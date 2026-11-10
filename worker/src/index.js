// The Caret Worker: a free AI proofreading pass for a handful of people.
//
// Why it exists. The extension can already call Google, OpenAI or Anthropic
// directly, but each person has to go and get their own API key first. This
// removes that step for a small, known group: one Cloudflare account runs the
// model, and each person gets a short Caret key to paste instead.
//
// What it is not. It is not a service. The Workers AI free plan allows 10,000
// neurons a day across the whole account, and when they are gone every request
// fails until 00:00 UTC. That is roughly 900-1,200 checks a day shared between
// everyone, so the per-key daily cap below matters: without it one person
// leaving "after every pause" switched on takes the day's allowance by lunch.
//
// What it never does: store the text it is sent, or log it. The only things
// written down are counters.

import {
  SYSTEM_PROMPT, SCHEMA, userPrompt, parseCorrections, leaveAloneNote,
} from '../../src/shared/proofread.js';

// Models get retired, and when one does every request fails with a 5028 until
// somebody notices and edits a setting. So this is a list, tried in order, and
// a retired or unknown model costs one wasted call rather than a day of
// outage. Set MODEL in the dashboard to force a particular one to the front.
//
// Ordered best-first among models that are on the free plan. Verify with
// test/quality.mjs before reordering: a bigger model is not automatically
// better at leaving correct writing alone, which is the thing that matters.
const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-3b-instruct',
];

/** A model that is gone, renamed or not on this plan. Try the next one. */
const DEAD_MODEL = /5028|deprecat|not found|no such model|unknown model|does not exist|invalid model|7000|7001/i;

/** The account is out of allowance. Trying another model will not help. */
const OUT_OF_ALLOWANCE = /neuron|quota|exceeded|capacity|3040/i;

// Matches the extension's own ceiling, so a long field is cut the same way.
const MAX_CHARS = 6000;

// No per-key cap by default: the extension holds each person to its own daily
// limit, so capping here as well would just be a second number to keep in step
// with the first. Set "daily" on a key, or PER_KEY_DAILY, only to rein in a
// particular person - say, one whose key has got out.
//
// The account-wide Workers AI allowance is still the real ceiling, and running
// into it is handled separately.
const DEFAULT_PER_KEY_DAILY = 0;

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

/**
 * Look the key up and count this call against it.
 * @returns {Promise<{ok: true, name: string, left: number} | {ok: false, status: number, error: string}>}
 */
async function spendKey(env, key) {
  if (!key || !/^caret_[A-Za-z0-9_-]{8,64}$/.test(key)) {
    return { ok: false, status: 401, error: 'That is not a Caret key.' };
  }

  const record = await env.KEYS.get(`key:${key}`, { type: 'json' });
  if (!record) return { ok: false, status: 401, error: 'This Caret key is not recognised.' };
  if (record.revoked) return { ok: false, status: 403, error: 'This Caret key has been turned off.' };

  // "daily": 0, or no "daily" at all, means this key is not capped here.
  const limit = Number(record.daily) > 0
    ? Number(record.daily)
    : Number(env.PER_KEY_DAILY) || DEFAULT_PER_KEY_DAILY;

  const counter = `use:${key}:${today()}`;
  const used = Number(await env.KEYS.get(counter)) || 0;
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
  await env.KEYS.put(counter, String(used + 1), { expirationTtl: 60 * 60 * 36 });
  return {
    ok: true,
    name: record.name || 'someone',
    left: limit > 0 ? limit - used - 1 : null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    // A liveness check that says nothing about any key.
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        model: env.MODEL || MODELS[0],
        fallbacks: (env.MODEL ? [env.MODEL, ...MODELS.filter((m) => m !== env.MODEL)] : MODELS).length,
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

    const text = typeof body.text === 'string' ? body.text.slice(0, MAX_CHARS) : '';
    if (!text.trim()) return json({ corrections: [] });

    // Words the writer has told their own copy of Caret to leave alone. Taken
    // as untrusted input: strings only, short ones, and a bounded number of
    // them, so a bad client cannot use this to write the prompt.
    const leaveAlone = Array.isArray(body.leaveAlone)
      ? body.leaveAlone.filter((w) => typeof w === 'string' && w.length <= 40).slice(0, 80)
      : [];

    const gate = await spendKey(env, request.headers.get('x-caret-key') || body.key);
    if (!gate.ok) return json({ error: gate.error }, gate.status);

    // Try the configured model first, then the rest of the list.
    const candidates = env.MODEL
      ? [env.MODEL, ...MODELS.filter((m) => m !== env.MODEL)]
      : MODELS;

    const ask = (model, withSchema) => env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + leaveAloneNote(leaveAlone) },
        { role: 'user', content: userPrompt(text) },
      ],
      // Asked for, not relied on: Workers AI says it cannot guarantee the
      // schema is met, and fewer models support it than not. parseCorrections
      // picks up the pieces either way, so a model that rejects the parameter
      // outright is retried without it rather than written off.
      ...(withSchema ? { response_format: { type: 'json_schema', json_schema: SCHEMA } } : {}),
      max_tokens: 1200,
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
    if (!corrections) return json({ corrections: [], unparsed: true });

    // Hand back the same shape every other provider produces, so the extension
    // runs it through exactly the same toIssues() it always has.
    return json({ corrections, model, left: gate.left });
  },
};
