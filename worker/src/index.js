// The Caret Worker: a free AI proofreading pass for a handful of people.
//
// Why it exists. The extension can already call Google, OpenAI or Anthropic
// directly, but each person has to go and get their own API key first. This
// removes that step for a small, known group: one Cloudflare account runs the
// model, and each person gets a short Caret key to paste instead.
//
// What it is not. It is not a service. The Workers AI free plan allows 10,000
// neurons a day across the whole account, and when they are gone every request
// fails until 00:00 UTC. There are two kinds of check, and they cost very
// different amounts of that:
//
//   full check   the whole field, on Llama 3.3 70B. Roughly 55 neurons each,
//                so about 180 a day if nothing else ran at all.
//   quick check  one finished sentence, on IBM Granite micro. Roughly 1 neuron
//                each, or 3-4 if it has to fall back to Gemma.
//
// So it is the full check that runs the account dry. Give the shared key
// "daily": 100 and full checks top out around 5,500 neurons, which leaves room
// for the default 2,000 quick checks on that key (about 2,000 neurons) with
// some to spare. Switch QUICK_MODEL to Gemma and QUICK_DAILY has to come down
// to about 1,000 to stay under. Without caps like these, one person leaving
// "after every pause" switched on takes the day's allowance by lunch.
//
// What it never does: store the text it is sent, or log it. The only things
// written down are counters.

import {
  SYSTEM_PROMPT, QUICK_SYSTEM_PROMPT, SCHEMA, userPrompt, parseCorrections, leaveAloneNote,
} from '../../src/shared/proofread.js';

// Models get retired, and when one does every request fails with a 5028 until
// somebody notices and edits a setting. So this is a list, tried in order, and
// a retired or unknown model costs one wasted call rather than a day of
// outage. Set MODEL in the dashboard to force a particular one to the front.
//
// Ordered best-first among models that are on the free plan. Try a candidate
// on writing that is already correct before reordering (test/quality.mjs
// scores the built-in checks, not these): a bigger model is not automatically
// better at leaving correct writing alone, which is the thing that matters.
// Llama 3.1 8B and Llama 3.2 3B used to be at the bottom; both are retired on
// 2026-11-20, so they are gone rather than left to fail.
const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-4.7-flash',
  // Last resort only. It is the quick check's model and much less careful with
  // a whole field, but it is still answering if everything above has gone.
  '@cf/ibm-granite/granite-4.0-h-micro',
];

// The quick check's own list: one finished sentence at a time, as people
// type, so it is the number of calls that adds up, not the size of each.
// Granite micro does a sentence for about a neuron; Gemma, the fallback, for
// three or four. Set QUICK_MODEL in the dashboard to force one to the front.
//
// The 70B is left off on purpose, not even last. A quick check that quietly
// fell back to it would cost about twenty times as much, and at a couple of
// thousand sentences a day that is the whole account's allowance gone without
// anyone having changed a setting. Better that the quick check stops.
const QUICK_MODELS = [
  '@cf/ibm-granite/granite-4.0-h-micro',
  '@cf/google/gemma-4-26b-a4b-it',
];

/** A model that is gone, renamed or not on this plan. Try the next one. */
const DEAD_MODEL = /5028|deprecat|not found|no such model|unknown model|does not exist|invalid model|7000|7001/i;

/** The account is out of allowance. Trying another model will not help. */
const OUT_OF_ALLOWANCE = /neuron|quota|exceeded|capacity|3040/i;

// Matches the extension's own ceiling, so a long field is cut the same way.
const MAX_CHARS = 6000;

// One sentence. The extension never sends more than 600 characters as a quick
// check; this leaves room for that, and stops a page pasted in as "a sentence"
// being paid for at full length.
const QUICK_MAX_CHARS = 800;

// No per-key cap on the full check by default: the extension holds each person
// to its own daily limit, so capping here as well would just be a second
// number to keep in step with the first. Set "daily" on a key, or
// PER_KEY_DAILY, to rein in a particular key - say, one that has got out. On a
// key that a lot of people share, about 100 is the number that keeps full
// checks to roughly half the account's neurons (see the top of this file).
//
// The account-wide Workers AI allowance is still the real ceiling, and running
// into it is handled separately.
const DEFAULT_PER_KEY_DAILY = 0;

// The quick check IS capped here by default, because it is the one that runs
// without anybody pressing anything. 2,000 a day on Granite is about 2,000
// neurons, a fifth of the account's day. Set "quickDaily" on a key, or
// QUICK_DAILY in the dashboard, to change it. Nothing, or 0, means this
// default, not "no cap". If QUICK_MODEL is switched to Gemma each check costs
// three or four times as much, so bring QUICK_DAILY down to about 1,000.
const DEFAULT_QUICK_DAILY = 2000;

// Quick checks are counted in steps of this many, one time in this many. See
// countQuick() for why.
const QUICK_COUNT_STEP = 10;

// A day counter only has to last until its UTC day is over, which is at most
// 24 hours after it is first written. 36 is that with room to spare, and then
// KV tidies it away.
const COUNTER_TTL = 60 * 60 * 36;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-caret-key',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...CORS },
});

const today = () => new Date().toISOString().slice(0, 10);

/** The list to try, with the model named in the dashboard (if any) moved to the front. */
const ordered = (forced, list) => (forced ? [forced, ...list.filter((m) => m !== forced)] : list);

/**
 * Look the key up and count this call against it.
 * @param {'full'|'quick'} mode  which day's count the call comes out of
 * @returns {Promise<{ok: true, name: string, left: number|null} | {ok: false, status: number, error: string}>}
 */
async function spendKey(env, key, mode) {
  if (!key || !/^caret_[A-Za-z0-9_-]{8,64}$/.test(key)) {
    return { ok: false, status: 401, error: 'That is not a Caret key.' };
  }

  let record;
  try {
    record = await env.KEYS.get(`key:${key}`, { type: 'json' });
  } catch (_) {
    // KV itself is unreachable or over its daily quota. Nothing can be
    // checked, so say that plainly instead of calling a good key unknown.
    return { ok: false, status: 503, error: 'Caret cannot check keys right now. Try again in a minute.' };
  }
  if (!record) return { ok: false, status: 401, error: 'This Caret key is not recognised.' };
  if (record.revoked) return { ok: false, status: 403, error: 'This Caret key has been turned off.' };

  // The two kinds of check are counted separately, so a day of quick checks
  // never eats into anybody's full checks, or the other way round.
  return mode === 'quick' ? countQuick(env, key, record) : countFull(env, key, record);
}

/** The full check's count: one KV write per check. */
async function countFull(env, key, record) {
  // "daily": 0, or no "daily" at all, means this key is not capped here.
  const limit = Number(record.daily) > 0
    ? Number(record.daily)
    : Number(env.PER_KEY_DAILY) || DEFAULT_PER_KEY_DAILY;

  // The count is a guard rail, not the gate: if KV cannot be read or written
  // (the free plan allows 1,000 writes a day), the check goes ahead uncounted
  // rather than failing. Each copy of Caret caps itself every day anyway.
  const counter = `use:${key}:${today()}`;
  let used = 0;
  try {
    used = Number(await env.KEYS.get(counter)) || 0;
  } catch (_) { /* count unknown: carry on */ }
  if (limit > 0 && used >= limit) {
    return {
      ok: false,
      status: 429,
      error: `That is ${limit} checks today on this key. It resets at midnight UTC.`,
    };
  }

  // Counted either way, so a key that is being hammered can be spotted in KV
  // and given a "daily" of its own. Two checks landing together can both read
  // the same number; losing one off the count matters far less than making
  // every request wait on a lock.
  try {
    await env.KEYS.put(counter, String(used + 1), { expirationTtl: COUNTER_TTL });
  } catch (_) { /* over the write quota: carry on uncounted */ }
  return {
    ok: true,
    name: record.name || 'someone',
    left: limit > 0 ? limit - used - 1 : null,
  };
}

/**
 * The quick check's count. Always capped, and counted by chance rather than
 * one by one - see below.
 */
async function countQuick(env, key, record) {
  // "quickDaily" on the key, else QUICK_DAILY, else the default. Unlike the
  // full check there is no "0 means no cap": 0, or nothing, is the default.
  const everyone = Number(env.QUICK_DAILY) > 0 ? Number(env.QUICK_DAILY) : DEFAULT_QUICK_DAILY;
  const limit = Number(record.quickDaily) > 0 ? Number(record.quickDaily) : everyone;

  // Fails open exactly like the full count: a KV that cannot be read or
  // written never stops a check, it only stops it being counted.
  const counter = `quick:${key}:${today()}`;
  let used = 0;
  try {
    used = Number(await env.KEYS.get(counter)) || 0;
  } catch (_) { /* count unknown: carry on */ }
  if (used >= limit) {
    return {
      ok: false,
      status: 429,
      error: "Today's quick checks on this key are used up. They come back at midnight UTC.",
    };
  }

  // Counted ten at a time, one time in ten, instead of one at a time, every
  // time.
  //
  // KV's free plan allows 1,000 writes a day for the whole account, and the
  // quick check runs on every sentence anybody finishes. Writing the counter
  // each time would need twice the day's writes at the default cap alone, and
  // once they ran out no counter anywhere would move - the full check's
  // included. So each quick check draws a number, and only about one in ten
  // writes, adding ten. On average that is still exactly one per check, so
  // the count stays honest over a day, for a tenth of the writes. It wanders
  // a little either way - after 2,000 checks it is usually within about 130
  // of the truth - which is plenty for a cap whose only job is to stop one
  // key spending everybody's day. Math.random is fine here: nobody gains
  // anything by predicting it.
  if (Math.random() < 1 / QUICK_COUNT_STEP) {
    try {
      await env.KEYS.put(counter, String(used + QUICK_COUNT_STEP), { expirationTtl: COUNTER_TTL });
    } catch (_) { /* over the write quota: carry on uncounted */ }
  }
  return {
    ok: true,
    name: record.name || 'someone',
    // An estimate, like the count it comes from.
    left: Math.max(0, limit - used - 1),
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    // The configured model first, then the rest of its list.
    const models = ordered(env.MODEL, MODELS);
    const quickModels = ordered(env.QUICK_MODEL, QUICK_MODELS);

    // A liveness check that says nothing about any key.
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        model: models[0],
        fallbacks: models.length,
        quickModel: quickModels[0],
        quickFallbacks: quickModels.length,
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/check') {
      return json({ error: 'POST /check' }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: 'Body must be JSON.' }, 400);
    }
    if (!body || typeof body !== 'object') return json({ error: 'Body must be a JSON object.' }, 400);

    // "quick" is one finished sentence, for the small model. Anything else,
    // including no mode at all - which is what every copy of Caret from before
    // the quick check sends - is the full check, exactly as it always was.
    const mode = body.mode === 'quick' ? 'quick' : 'full';
    const quick = mode === 'quick';

    const text = typeof body.text === 'string'
      ? body.text.slice(0, quick ? QUICK_MAX_CHARS : MAX_CHARS)
      : '';
    if (!text.trim()) return json({ corrections: [] });

    // Words the writer has told their own copy of Caret to leave alone. Taken
    // as untrusted input: strings only, short ones, and a bounded number of
    // them, so a bad client cannot use this to write the prompt.
    let leaveAlone = Array.isArray(body.leaveAlone)
      ? body.leaveAlone.filter((w) => typeof w === 'string' && w.length <= 40).slice(0, 80)
      : [];
    // A quick check pays for its prompt on every sentence, and a word that is
    // not in the sentence cannot be corrected in it, so only those that are
    // go in. The extension already sends just those; this holds any client
    // to it.
    if (quick) {
      const lower = text.toLowerCase();
      leaveAlone = leaveAlone.filter((w) => w.trim() && lower.includes(w.trim().toLowerCase()));
    }

    const gate = await spendKey(env, request.headers.get('x-caret-key') || body.key, mode);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    // A quick check only ever walks the quick list: see QUICK_MODELS.
    const candidates = quick ? quickModels : models;
    const system = (quick ? QUICK_SYSTEM_PROMPT : SYSTEM_PROMPT) + leaveAloneNote(leaveAlone);

    const ask = (model, withSchema) => env.AI.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt(text) },
      ],
      // Asked for, not relied on: Workers AI says it cannot guarantee the
      // schema is met, and fewer models support it than not. parseCorrections
      // picks up the pieces either way, so a model that rejects the parameter
      // outright is retried without it rather than written off.
      ...(withSchema ? { response_format: { type: 'json_schema', json_schema: SCHEMA } } : {}),
      // One sentence's corrections fit in 256 tokens with room over. The cap
      // is there so a small model that starts rambling stops after a few
      // neurons rather than a few dozen.
      max_tokens: quick ? 256 : 1200,
      temperature: 0,
    });

    let reply;
    let model;
    let lastError = '';
    for (const candidate of candidates) {
      for (const withSchema of [true, false]) {
        try {
          reply = await ask(candidate, withSchema);
          model = candidate;
          break;
        } catch (error) {
          lastError = String((error && error.message) || error);
          // No point trying anything else: the day is spent, not the model
          // broken. Say so plainly so the extension can go quiet rather than
          // show an error nobody can act on.
          if (OUT_OF_ALLOWANCE.test(lastError)) {
            return json({
              error: 'The shared daily allowance is used up. It resets at midnight UTC.',
              spent: true,
            }, 429);
          }
          // A retired model is worth skipping immediately; anything else gets
          // the no-schema retry first.
          if (DEAD_MODEL.test(lastError)) break;
        }
      }
      if (model) break;
    }

    if (!model) return json({ error: `No model would answer. Last said: ${lastError}` }, 502);

    const raw = typeof reply === 'string' ? reply : (reply.response ?? reply.result ?? '');
    const corrections = parseCorrections(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!corrections) return json({ corrections: [], unparsed: true, model, left: gate.left, mode });

    // Hand back the same shape every other provider produces, so the extension
    // runs it through exactly the same toIssues() it always has.
    return json({ corrections, model, left: gate.left, mode });
  },
};
