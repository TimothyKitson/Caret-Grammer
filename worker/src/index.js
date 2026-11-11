// The Caret Worker: a free AI proofreading pass for a handful of people.
//
// Why it exists. The extension can already call Google, OpenAI or Anthropic
// directly, but each person has to go and get their own API key first. This
// removes that step for a small, known group: one Cloudflare account runs the
// model, and each person gets a short Caret key to paste instead.
//
// What it is not. It is not a service. The Workers AI free plan allows 10,000
// neurons a day across the whole account, and when they are gone every request
// fails until 00:00 UTC. Fails, not billed: on the free plan nothing is ever
// charged. There are two kinds of check, and they cost very different amounts
// of that. Workers AI charges by the token, and the 70B charges about eight
// times as much for a token it writes as for one it reads:
//
//   full check   the whole field, on Llama 3.3 70B. The system prompt alone is
//                about 630 tokens. An essay-length field - 3,000 characters,
//                eight or so corrections - is about 1,400 tokens in and 370
//                out: roughly 110 neurons. A paragraph is 30-60. The worst
//                case, 6,000 characters with a long leave-alone list and an
//                answer that runs to the 800-token cap, is about 240.
//   quick check  one finished sentence, on IBM Granite micro. About 1 neuron,
//                3 at the very most. If Granite is not answering it falls back
//                to Gemma on its own, and then it is about 3, up to 10.
//
// So it is the full check that runs the account dry: a hundred essay-length
// full checks is more than the whole day. Two things stand in the way:
//
//   - An account-wide meter adds up what full checks have cost today, for
//     every key together, and turns them away once they reach
//     FULL_NEURONS_DAILY (6,000 by default). That is about 50 essay-length
//     checks, and it leaves about 4,000 neurons for quick checks: over 1,000
//     sentences even if every one cost the most a Granite sentence can.
//   - Per-key caps, "daily" and "quickDaily", as a backstop for one key. On
//     the key everybody's copy of Caret shares, set "daily" to about 50.
//
// Neither is exact. KV has no locks, so requests that land together can all
// read the same count and all go ahead, and the meter only learns what a full
// check cost once it has finished. Making that exact would need a Durable
// Object, which cannot be set up by pasting one file into the dashboard. And
// the shared key is inside the extension, so anyone who digs it out can call
// this from a script. So the caps hold an ordinary day, or a steady stream
// from a script, to their shares, and a burst of requests all at once can go
// past them by about as many as were in flight. Past that, the account's own
// 10,000 is the ceiling: on the free plan the worst that can happen is the
// day's allowance running out early. It is never a bill.
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
// Granite micro does a sentence for about a neuron, 3 at the very most; Gemma,
// the fallback, for about three, up to ten. Set QUICK_MODEL in the dashboard
// to force one to the front.
//
// The 70B is left off on purpose, not even last. A quick check that quietly
// fell back to it would cost about twenty times as much, and at a couple of
// thousand sentences a day that is the whole account's allowance gone without
// anyone having changed a setting. Better that the quick check stops.
const QUICK_MODELS = [
  '@cf/ibm-granite/granite-4.0-h-micro',
  '@cf/google/gemma-4-26b-a4b-it',
];

// What each model charges, in neurons per million tokens: [read, written].
// From Workers AI's pricing page. Only used to estimate what a full check
// cost, for the meter below. A model not listed here - one forced with MODEL,
// say - is reckoned at the 70B's price, the dearest, so the guess never comes
// out low.
const PRICES = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [26668, 204805],
  '@cf/google/gemma-4-26b-a4b-it': [9091, 27273],
  '@cf/zai-org/glm-4.7-flash': [5500, 36400],
  '@cf/ibm-granite/granite-4.0-h-micro': [1542, 10158],
};
const DEAREST = PRICES['@cf/meta/llama-3.3-70b-instruct-fp8-fast'];

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

// The most a full check's answer may run to. A correction is about 40 tokens
// of JSON, so 800 is room for fifteen or more, which is more than even a long
// field usually needs. It was 1,200. The 70B charges about eight times as
// much to write a token as to read one, so the answer is most of what a full
// check costs: at 1,200 one check could reach about 320 neurons, and at 800
// it stops at about 240.
const FULL_MAX_TOKENS = 800;

// One sentence's corrections fit in 256 tokens with room over. The cap is
// there so a small model that starts rambling stops after a few neurons
// rather than a few dozen.
const QUICK_MAX_TOKENS = 256;

// How many neurons a day full checks may use between them, every key
// together, before they are turned away until midnight UTC. 6,000 of the
// 10,000 is about 50 essay-length checks, and leaves about 4,000 for quick
// checks, which this meter does not touch. Set FULL_NEURONS_DAILY in the
// dashboard to change it.
const DEFAULT_FULL_NEURONS_DAILY = 6000;

const FULL_SHARE_USED = 'The full AI checks for today are used up for everyone. '
  + 'The quick check and the built-in checks still work. They come back at midnight UTC.';

// No per-key cap on the full check by default: the meter above keeps full
// checks to their share of the account, and the extension holds each person
// to 20 a day. Set "daily" on a key, or PER_KEY_DAILY, as a backstop for one
// key - say, one that has got out. On the key that everybody's copy of Caret
// shares, about 50 is right: that is roughly what the meter's 6,000 neurons
// buys in essay-length checks, so neither runs out long before the other.
const DEFAULT_PER_KEY_DAILY = 0;

// The quick check IS capped here by default, because it is the one that runs
// without anybody pressing anything. 2,000 a day on Granite is usually under
// 2,000 neurons. If every one were a long sentence whose answer ran to the cap
// it would be about 6,000, more than the 4,000 or so the full checks leave, and
// the account's allowance would run out before midnight - a pause, never a
// bill. In practice the extension holds each person to 80 at most, so the
// whole group comes nowhere near it; the cap is for a key that has got out.
// Set "quickDaily" on a key, or QUICK_DAILY in the dashboard, to change it.
// Nothing, or 0, means this default, not "no cap". If QUICK_MODEL is switched
// to Gemma each check costs about 3 neurons, up to 10 - three to five times
// as much - so bring QUICK_DAILY down to about 500.
const DEFAULT_QUICK_DAILY = 2000;

// Quick checks are counted in steps of this many, one time in this many. See
// countQuick() for why.
const QUICK_COUNT_STEP = 10;

// A day counter only has to last until its UTC day is over, which is at most
// 24 hours after it is first written. 36 is that with room to spare, and then
// KV tidies it away.
const COUNTER_TTL = 60 * 60 * 36;

// No CORS headers, on purpose. Caret calls this from its service worker and
// its own pages, which have host permission for every site and so are not held
// to CORS at all. A web page is. Leaving the headers off means no site can
// make a visitor's browser spend the allowance for it. (A script outside a
// browser can still call this with the shared key - the caps are what limit
// that.)
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------- the full checks' meter
//
// One number for the whole account: roughly how many neurons full checks have
// cost since midnight UTC. Read before each full check and added to after it,
// so it costs one KV write per full check, and full checks are few. Quick
// checks are not metered here; they have their own count per key.

const meterKey = () => `neurons:full:${today()}`;

const fullBudget = (env) => (Number(env.FULL_NEURONS_DAILY) > 0
  ? Number(env.FULL_NEURONS_DAILY)
  : DEFAULT_FULL_NEURONS_DAILY);

/** Neurons full checks have used today, as far as KV knows. null if it cannot say. */
async function readMeter(env) {
  try {
    return Number(await env.KEYS.get(meterKey())) || 0;
  } catch (_) {
    return null;
  }
}

/**
 * Add one full check's cost to the meter.
 *
 * Read again first, rather than adding to the number read before the check:
 * the model takes seconds, and any full check that finished in the meantime
 * would otherwise be written over. Still not exact - two can finish together -
 * but close. If KV cannot be read either time, nothing is written: putting
 * down this one check's cost would wipe out the rest of the day's.
 */
async function addToMeter(env, before, neurons) {
  const now = await readMeter(env);
  const base = now ?? before;
  if (base === null || !(neurons > 0)) return;
  try {
    await env.KEYS.put(meterKey(), String(Math.ceil(base + neurons)), { expirationTtl: COUNTER_TTL });
  } catch (_) { /* over the write quota: carry on unmetered */ }
}

/**
 * Roughly what one model call cost, in neurons.
 *
 * Workers AI usually says how many tokens went in and came out, and that is
 * used when it is there. When it is not, or says 0, four characters to a token
 * is near enough for English.
 * @param {string} prompt  everything sent: system prompt and user turn
 * @param {string} answer  everything the model wrote back
 */
function neuronsUsed(model, reply, prompt, answer) {
  const [perIn, perOut] = PRICES[model] || DEAREST;
  const usage = (reply && typeof reply === 'object' && reply.usage) || {};
  const given = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
  const tokensIn = given(usage.prompt_tokens) ?? prompt.length / 4;
  const tokensOut = given(usage.completion_tokens) ?? answer.length / 4;
  return (tokensIn * perIn + tokensOut * perOut) / 1e6;
}

/** The list to try, with the model named in the dashboard (if any) moved to the front. */
const ordered = (forced, list) => (forced ? [forced, ...list.filter((m) => m !== forced)] : list);

/**
 * Look the key up and count this call against it. A full check also has to
 * fit in what is left of the account's full-check share for the day.
 * @param {'full'|'quick'} mode  which day's count the call comes out of
 * @returns {Promise<{ok: true, name: string, left: number|null, meter?: number|null} | {ok: false, status: number, error: string}>}
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
  if (mode === 'quick') return countQuick(env, key, record);

  // The meter is looked at before the key's own count, so being turned away
  // here does not use up one of the key's checks as well. Like every count
  // here it fails open: if KV cannot say, the check goes ahead.
  const meter = await readMeter(env);
  if (meter !== null && meter >= fullBudget(env)) {
    return { ok: false, status: 429, error: FULL_SHARE_USED };
  }
  const gate = await countFull(env, key, record);
  return gate.ok ? { ...gate, meter } : gate;
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
    // A preflight still gets an answer, just one that allows nothing: see json.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

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
    const user = userPrompt(text);

    const ask = (model, withSchema) => env.AI.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Asked for, not relied on: Workers AI says it cannot guarantee the
      // schema is met, and fewer models support it than not. parseCorrections
      // picks up the pieces either way, so a model that rejects the parameter
      // outright is retried without it rather than written off.
      ...(withSchema ? { response_format: { type: 'json_schema', json_schema: SCHEMA } } : {}),
      max_tokens: quick ? QUICK_MAX_TOKENS : FULL_MAX_TOKENS,
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
    const answer = typeof raw === 'string' ? raw : JSON.stringify(raw);

    // A full check goes on the meter once a model has actually answered,
    // whether or not the answer turns out to be usable: it cost the same
    // either way. Calls that failed outright are not counted - nothing came
    // back to count.
    if (!quick) await addToMeter(env, gate.meter, neuronsUsed(model, reply, system + user, answer));

    const corrections = parseCorrections(answer);
    if (!corrections) return json({ corrections: [], unparsed: true, model, left: gate.left, mode });

    // Hand back the same shape every other provider produces, so the extension
    // runs it through exactly the same toIssues() it always has.
    return json({ corrections, model, left: gate.left, mode });
  },
};
