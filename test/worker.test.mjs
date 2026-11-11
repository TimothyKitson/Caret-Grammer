// The Caret Worker, run against fake Cloudflare bindings.
//
// This tests the single-file build in worker/dist/, because that is the one
// that actually gets deployed when it is pasted into the dashboard. If the
// bundler ever drops something, these fail rather than the Worker 500ing in
// production.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(ROOT, 'worker/dist/worker.js'), 'utf8');
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
)).default;

/** A KV namespace that lives in a Map. */
function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key, options) {
      const value = store.get(key);
      if (value === undefined) return null;
      return options && options.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, String(value)); },
  };
}

const CORRECTIONS = { corrections: [{
  before: 'I ', original: 'teh', replacement: 'the', kind: 'spelling', explanation: 'A typo.',
}] };

function fakeEnv({ kv, ai } = {}) {
  const calls = [];
  return {
    calls,
    KEYS: kv || fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3 }) }),
    AI: {
      async run(model, body) {
        calls.push({ model, body });
        if (ai) return ai(model, body);
        return { response: JSON.stringify(CORRECTIONS) };
      },
    },
    MODEL: '@cf/meta/llama-3.1-8b-instruct',
  };
}

const post = (body, headers = {}) => new Request('https://w.example/check', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const KEY = { 'x-caret-key': 'caret_abcdef123456' };

// ------------------------------------------------------------------ gate

test('a request with no key is refused and never reaches the model', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(post({ text: 'I teh cat' }), env);
  assert.equal(res.status, 401);
  assert.equal(env.calls.length, 0, 'the model must not be called');
});

test('a made-up key is refused', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(post({ text: 'I teh cat' }, { 'x-caret-key': 'caret_zzzzzzzzzzzz' }), env);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /not recognised/);
  assert.equal(env.calls.length, 0);
});

test('a key that is not even key-shaped is refused without a KV read', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(post({ text: 'hi there' }, { 'x-caret-key': 'hunter2' }), env);
  assert.equal(res.status, 401);
});

test('a revoked key is refused', async () => {
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Old', revoked: true }) }),
  });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 403);
  assert.equal(env.calls.length, 0);
});

// ------------------------------------------------------------- happy path

test('a good key gets corrections back in the shared shape', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.corrections, CORRECTIONS.corrections);
  assert.equal(body.model, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(body.left, 2, 'three a day, one spent');

  // The prompt the Worker sends must be the shared one, not a copy.
  const { SYSTEM_PROMPT } = await import('../src/shared/proofread.js');
  assert.equal(env.calls[0].body.messages[0].content, SYSTEM_PROMPT);
  assert.match(env.calls[0].body.messages[1].content, /<text>\nI teh cat\n<\/text>/);
});

test('empty text is answered without spending anything', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(post({ text: '   ' }, KEY), env);
  assert.deepEqual(await res.json(), { corrections: [] });
  assert.equal(env.calls.length, 0);
  assert.equal(env.KEYS.store.size, 1, 'no counter was written');
});

test('long text is cut before it is sent', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'word '.repeat(4000) }, KEY), env);
  assert.ok(env.calls[0].body.messages[1].content.length < 6400);
});

// ------------------------------------------------------------------ caps

test("one key cannot spend everybody's day", async () => {
  const env = fakeEnv();
  for (let i = 0; i < 3; i += 1) {
    const ok = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
    assert.equal(ok.status, 200, `call ${i + 1} should be allowed`);
  }
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /resets at midnight UTC/);
  assert.equal(env.calls.length, 3, 'the capped call must not reach the model');
});

test('the account running out of neurons reads as a pause, not a fault', async () => {
  const env = fakeEnv({
    ai: () => { throw new Error('Request failed: out of neurons for today (code 3040)'); },
  });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.spent, true, 'the extension keys off this to go quiet');
  assert.match(body.error, /daily allowance/);
});

test('any other model failure is a plain error', async () => {
  const env = fakeEnv({ ai: () => { throw new Error('model exploded'); } });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 502);
});

// ----------------------------------------------------------- sloppy models

test('a model that fences its JSON is still understood', async () => {
  const env = fakeEnv({ ai: () => ({ response: '```json\n' + JSON.stringify(CORRECTIONS) + '\n```' }) });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.deepEqual((await res.json()).corrections, CORRECTIONS.corrections);
});

test('a model that answers with prose is a no-op, not a crash', async () => {
  const env = fakeEnv({ ai: () => ({ response: 'I am sorry, I cannot do that.' }) });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.corrections, []);
  assert.equal(body.unparsed, true);
});

// ---------------------------------------------------------------- the rest

test('/health says nothing about any key', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(new Request('https://w.example/health'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(!JSON.stringify(body).includes('caret_'));
});

test('a browser preflight is answered', async () => {
  const res = await worker.fetch(new Request('https://w.example/check', { method: 'OPTIONS' }), fakeEnv());
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /x-caret-key/);
});

test('anything else is a 404', async () => {
  const res = await worker.fetch(new Request('https://w.example/'), fakeEnv());
  assert.equal(res.status, 404);
});

// ------------------------------------------------- what not to correct

test('the Worker puts the writer\'s rejected words into its prompt', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'Kitson signed it', leaveAlone: ['Kitson'] }, KEY), env);
  assert.match(env.calls[0].body.messages[0].content, /NEVER propose a change/);
  assert.match(env.calls[0].body.messages[0].content, /Kitson/);
});

test('a client cannot use leaveAlone to write the prompt', async () => {
  const env = fakeEnv();
  await worker.fetch(post({
    text: 'hello',
    leaveAlone: [
      'x'.repeat(500),                       // too long to be a word
      ...Array.from({ length: 300 }, (_, i) => `w${i}`),  // too many
      12345, null, { bad: true },            // not strings
    ],
  }, KEY), env);
  const system = env.calls[0].body.messages[0].content;
  assert.ok(!system.includes('x'.repeat(100)), 'a long string got through');
  assert.ok(!system.includes('12345'));
  assert.ok(system.length < 6000, `prompt ballooned to ${system.length}`);
});

test('no list means the prompt is the plain one', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'hello' }, KEY), env);
  const { SYSTEM_PROMPT } = await import('../src/shared/proofread.js');
  assert.equal(env.calls[0].body.messages[0].content, SYSTEM_PROMPT);
});

// ------------------------------------------------------ models come and go

test('a retired model is skipped and the next one answers', async () => {
  const tried = [];
  const env = fakeEnv({
    ai: (model) => {
      tried.push(model);
      // Exactly what Cloudflare said when llama-3.1-8b-instruct was retired.
      if (tried.length === 1) {
        throw new Error('5028: @cf/meta/infire-llama-3.1-8b-instruct was deprecated on 2026-05-30.');
      }
      return { response: JSON.stringify(CORRECTIONS) };
    },
  });
  env.MODEL = '@cf/meta/llama-3.1-8b-instruct';

  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.corrections, CORRECTIONS.corrections);
  assert.equal(tried[0], '@cf/meta/llama-3.1-8b-instruct', 'the configured one is tried first');
  assert.notEqual(body.model, tried[0], 'it should have moved on');
  assert.equal(body.model, tried[1]);
});

test('a retired model is not retried without the schema first', async () => {
  // Dropping response_format cannot revive a model that no longer exists, and
  // every wasted call is one off a small daily allowance.
  const tried = [];
  const env = fakeEnv({
    ai: (model, body) => {
      tried.push({ model, schema: !!body.response_format });
      if (tried.length < 3) throw new Error('5028: deprecated');
      return { response: JSON.stringify(CORRECTIONS) };
    },
  });
  await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.deepEqual(tried.map((t) => t.schema), [true, true, true], 'no pointless no-schema retries');
  assert.equal(new Set(tried.map((t) => t.model)).size, 3, 'three different models');
});

test('a model that refuses the schema is retried without it', async () => {
  const tried = [];
  const env = fakeEnv({
    ai: (model, body) => {
      tried.push(!!body.response_format);
      if (body.response_format) throw new Error('response_format is not supported for this model');
      return { response: '```json\n' + JSON.stringify(CORRECTIONS) + '\n```' };
    },
  });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 200);
  assert.deepEqual(tried, [true, false], 'same model, second time without the schema');
  assert.deepEqual((await res.json()).corrections, CORRECTIONS.corrections);
});

test('running out of allowance stops immediately, it does not try every model', async () => {
  let calls = 0;
  const env = fakeEnv({
    ai: () => { calls += 1; throw new Error('out of neurons for today (3040)'); },
  });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).spent, true);
  assert.equal(calls, 1, 'burning the whole list on a spent account helps nobody');
});

test('when nothing answers, the last reason is passed on', async () => {
  const env = fakeEnv({ ai: () => { throw new Error('everything is on fire'); } });
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /everything is on fire/);
});

test('/health names the model it would reach for', async () => {
  const res = await worker.fetch(new Request('https://w.example/health'), fakeEnv());
  const body = await res.json();
  assert.match(body.model, /^@cf\//);
  assert.ok(body.fallbacks >= 3, 'there should be several to fall back on');
});

test('a key with no "daily" is not capped by the Worker', async () => {
  // Caret limits each person in the extension now, so the server only caps a
  // key that has been given a number of its own.
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Tim' }) }),
  });
  for (let i = 0; i < 8; i += 1) {
    const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
    assert.equal(res.status, 200, `call ${i + 1}`);
  }
  // Still counted, so a key being hammered can be spotted and given a cap.
  assert.equal(env.KEYS.store.get(`use:caret_abcdef123456:${new Date().toISOString().slice(0, 10)}`), '8');
});

test('an explicit "daily" on a key still caps it', async () => {
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Noisy', daily: 2 }) }),
  });
  await worker.fetch(post({ text: 'x y' }, KEY), env);
  await worker.fetch(post({ text: 'x y' }, KEY), env);
  const res = await worker.fetch(post({ text: 'x y' }, KEY), env);
  assert.equal(res.status, 429);
});

// --------------------------------------------------------- KV having a bad day

test('a counter KV cannot write (over the free quota) still answers the check', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3 }) });
  kv.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };
  const env = fakeEnv({ kv });
  const response = await worker.fetch(post({ text: 'I saw teh dog.' }, KEY), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.corrections.length, 1);
});

test('a counter KV cannot read still answers the check', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3 }) });
  const get = kv.get.bind(kv);
  kv.get = async (key, options) => {
    if (key.startsWith('use:')) throw new Error('KV get() limit exceeded');
    return get(key, options);
  };
  const response = await worker.fetch(post({ text: 'I saw teh dog.' }, KEY), fakeEnv({ kv }));
  assert.equal(response.status, 200);
});

test('when the key itself cannot be looked up, it says so instead of "not recognised"', async () => {
  const kv = fakeKv();
  kv.get = async () => { throw new Error('KV unavailable'); };
  const env = fakeEnv({ kv });
  const response = await worker.fetch(post({ text: 'I saw teh dog.' }, KEY), env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /cannot check keys right now/);
  assert.equal(env.calls.length, 0, 'no model call without a checked key');
});

// ------------------------------------------------------------ the quick check
//
// One finished sentence at a time, on a small model, counted separately from
// the full check. These are the tests that keep it free: the right model, a
// short prompt, a small token cap, and a counter that does not use up KV's
// free writes.

const { SYSTEM_PROMPT, QUICK_SYSTEM_PROMPT, userPrompt } = await import('../src/shared/proofread.js');

const GRANITE = '@cf/ibm-granite/granite-4.0-h-micro';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const BIG = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const RETIRING = /llama-3\.1-8b|llama-3\.2-3b/;

const day = () => new Date().toISOString().slice(0, 10);
const QUICK_COUNTER = () => `quick:caret_abcdef123456:${day()}`;
const FULL_COUNTER = () => `use:caret_abcdef123456:${day()}`;

const quick = (text, extra = {}) => post({ text, mode: 'quick', ...extra }, KEY);

/** Run fn with Math.random pinned to one number, and always put it back. */
async function withRandom(value, fn) {
  const real = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
}

test('the quick prompt is short, and still carries the rules that matter', () => {
  // It is paid for on every sentence anybody finishes.
  assert.ok(QUICK_SYSTEM_PROMPT.length < 900, `quick prompt is ${QUICK_SYSTEM_PROMPT.length} characters`);
  assert.ok(QUICK_SYSTEM_PROMPT.length < SYSTEM_PROMPT.length / 2);
  assert.match(QUICK_SYSTEM_PROMPT, /Never rewrite/);
  assert.match(QUICK_SYSTEM_PROMPT, /Never change the meaning/);
  assert.match(QUICK_SYSTEM_PROMPT, /"not"/);
  assert.match(QUICK_SYSTEM_PROMPT, /fancier/);
  assert.match(QUICK_SYSTEM_PROMPT, /"before"/);
  assert.match(QUICK_SYSTEM_PROMPT, /\{"corrections":\[\]\}/);
});

test('a quick check goes to Granite with the short prompt, a small cap and one sentence', async () => {
  const env = fakeEnv();   // MODEL is set: the quick check must ignore it
  const long = 'I saw teh dog in the park today. '.repeat(60);
  const res = await withRandom(0.5, () => worker.fetch(quick(long), env));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'quick');
  assert.equal(body.model, GRANITE);
  assert.deepEqual(body.corrections, CORRECTIONS.corrections);

  assert.equal(env.calls.length, 1);
  const call = env.calls[0];
  assert.equal(call.model, GRANITE);
  assert.equal(call.body.messages[0].content, QUICK_SYSTEM_PROMPT);
  assert.equal(call.body.messages[1].content, userPrompt(long.slice(0, 800)), 'cut to 800 characters');
  assert.equal(call.body.max_tokens, 256);
  assert.equal(call.body.temperature, 0);
  assert.ok(call.body.response_format, 'the schema is still asked for first');
});

test('QUICK_MODEL puts a model at the front of the quick list, and MODEL does not', async () => {
  const env = fakeEnv();
  env.QUICK_MODEL = GEMMA;
  await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(env.calls[0].model, GEMMA);

  const health = await (await worker.fetch(new Request('https://w.example/health'), env)).json();
  assert.equal(health.quickModel, GEMMA);
  assert.equal(health.quickFallbacks, 2, 'moved to the front, not added twice');

  env.QUICK_MODEL = '@cf/someone/brand-new-small-model';
  const newer = await (await worker.fetch(new Request('https://w.example/health'), env)).json();
  assert.equal(newer.quickModel, '@cf/someone/brand-new-small-model');
  assert.equal(newer.quickFallbacks, 3);
});

test('a retired quick model falls back to Gemma', async () => {
  const tried = [];
  const env = fakeEnv({
    ai: (model) => {
      tried.push(model);
      if (model === GRANITE) throw new Error('5028: @cf/ibm-granite/granite-4.0-h-micro was deprecated.');
      return { response: JSON.stringify(CORRECTIONS) };
    },
  });
  const res = await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, GEMMA);
  assert.deepEqual(tried, [GRANITE, GEMMA], 'no pointless no-schema retry of a retired model');
});

test('a quick check never falls back to the big model, even when nothing else answers', async () => {
  const tried = [];
  const env = fakeEnv({
    ai: (model) => { tried.push(model); throw new Error('5028: deprecated'); },
  });
  const res = await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(res.status, 502);
  assert.deepEqual(tried, [GRANITE, GEMMA]);
  assert.ok(!tried.includes(BIG), 'the 70B costs fifty times as much');
  assert.ok(!tried.includes(env.MODEL), 'MODEL is for the full check only');
});

test('a quick model that refuses the schema is retried without it', async () => {
  const tried = [];
  const env = fakeEnv({
    ai: (model, body) => {
      tried.push({ model, schema: !!body.response_format });
      if (body.response_format) throw new Error('response_format is not supported for this model');
      return { response: 'Sure! ' + JSON.stringify(CORRECTIONS) };
    },
  });
  const res = await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(res.status, 200);
  assert.deepEqual(tried, [{ model: GRANITE, schema: true }, { model: GRANITE, schema: false }]);
  assert.deepEqual((await res.json()).corrections, CORRECTIONS.corrections);
});

test('a spent account stops a quick check at once, as a pause', async () => {
  let calls = 0;
  const env = fakeEnv({
    ai: () => { calls += 1; throw new Error('out of neurons for today (3040)'); },
  });
  const res = await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).spent, true);
  assert.equal(calls, 1);
});

test('a quick check only sends the leave-alone words that are in its sentence', async () => {
  const env = fakeEnv();
  await withRandom(0.5, () => worker.fetch(quick('Kitson signed it.', {
    leaveAlone: ['kitson', 'Zorblax', '   '],
  }), env));
  const system = env.calls[0].body.messages[0].content;
  assert.ok(system.startsWith(QUICK_SYSTEM_PROMPT));
  assert.match(system, /kitson/);
  assert.ok(!system.includes('Zorblax'), 'a word not in the sentence is paid for for nothing');

  const plain = fakeEnv();
  await withRandom(0.5, () => worker.fetch(quick('Hello there.', { leaveAlone: ['Zorblax'] }), plain));
  assert.equal(plain.calls[0].body.messages[0].content, QUICK_SYSTEM_PROMPT);
});

test('empty quick text is answered without spending anything', async () => {
  const env = fakeEnv();
  const res = await worker.fetch(quick('   '), env);
  assert.deepEqual(await res.json(), { corrections: [] });
  assert.equal(env.calls.length, 0);
  assert.equal(env.KEYS.store.size, 1, 'no counter was written');
});

// ------------------------------------------------- the full check, unchanged

test('the full check has dropped the Llamas that retire on 2026-11-20', async () => {
  const env = fakeEnv({ ai: () => { throw new Error('everything is on fire'); } });
  delete env.MODEL;
  const health = await (await worker.fetch(new Request('https://w.example/health'), env)).json();
  assert.equal(health.model, BIG);
  assert.equal(health.fallbacks, 4);

  // Walk the whole list: every model, schema then no schema, in order.
  const res = await worker.fetch(post({ text: 'I teh cat' }, KEY), env);
  assert.equal(res.status, 502);
  const tried = [...new Set(env.calls.map((c) => c.model))];
  assert.deepEqual(tried, [BIG, GEMMA, '@cf/zai-org/glm-4.7-flash', GRANITE]);
  assert.ok(!tried.some((m) => RETIRING.test(m)));
  assert.equal(env.calls.length, 8);
});

test('no mode, or any mode but "quick", is the full check exactly as before', async () => {
  for (const mode of [undefined, 'full', 'QUICK', 'fast', 7]) {
    const env = fakeEnv();
    delete env.MODEL;
    const res = await worker.fetch(post({ text: 'I teh cat', ...(mode === undefined ? {} : { mode }) }, KEY), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'full', `mode ${mode}`);
    assert.equal(body.model, BIG);
    assert.equal(body.left, 2);
    assert.equal(env.calls[0].body.messages[0].content, SYSTEM_PROMPT);
    assert.equal(env.calls[0].body.max_tokens, 1200);
    assert.equal(env.KEYS.store.get(FULL_COUNTER()), '1');
    assert.equal(env.KEYS.store.get(QUICK_COUNTER()), undefined);
  }
});

test('a full check is still cut at 6,000 characters, not 800', async () => {
  const env = fakeEnv();
  const long = 'word '.repeat(4000);
  await worker.fetch(post({ text: long }, KEY), env);
  assert.equal(env.calls[0].body.messages[1].content, userPrompt(long.slice(0, 6000)));
});

// ---------------------------------------------------------- counting quick checks

test('quick checks do not use up the full check, and the other way round', async () => {
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 1, quickDaily: 10 }) }),
  });
  await withRandom(0.05, async () => {
    assert.equal((await worker.fetch(post({ text: 'I teh cat' }, KEY), env)).status, 200);
    assert.equal((await worker.fetch(post({ text: 'I teh cat' }, KEY), env)).status, 429, 'full cap reached');
    // Full checks used up; quick checks still go.
    assert.equal((await worker.fetch(quick('I saw teh dog.'), env)).status, 200);
    assert.equal(env.KEYS.store.get(FULL_COUNTER()), '1', 'the quick check left the full count alone');
    assert.equal(env.KEYS.store.get(QUICK_COUNTER()), '10');
    // Now the quick ones are gone too...
    assert.equal((await worker.fetch(quick('I saw teh dog.'), env)).status, 429);
  });

  // ...and a fresh day's full checks would not care.
  const other = fakeEnv({
    kv: fakeKv({
      'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3, quickDaily: 10 }),
      [QUICK_COUNTER()]: '10',
    }),
  });
  assert.equal((await worker.fetch(quick('I saw teh dog.'), other)).status, 429);
  assert.equal((await worker.fetch(post({ text: 'I teh cat' }, KEY), other)).status, 200);
});

test('quick checks are counted ten at a time, about one time in ten', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad' }) });
  const puts = [];
  const put = kv.put.bind(kv);
  kv.put = async (key, value, options) => { puts.push({ key, value, options }); return put(key, value, options); };
  const env = fakeEnv({ kv });

  // The one-in-ten draw: written, and written as ten.
  await withRandom(0.05, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(env.KEYS.store.get(QUICK_COUNTER()), '10');
  await withRandom(0.05, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(env.KEYS.store.get(QUICK_COUNTER()), '20');
  assert.equal(puts.length, 2);
  assert.ok(puts.every((p) => p.options && p.options.expirationTtl > 0), 'counters expire');

  // The other nine: no write at all.
  for (const draw of [0.1, 0.5, 0.99]) {
    const res = await withRandom(draw, () => worker.fetch(quick('I saw teh dog.'), env));
    assert.equal(res.status, 200);
  }
  assert.equal(puts.length, 2, 'nothing written when the draw misses');
  assert.equal(env.KEYS.store.get(QUICK_COUNTER()), '20');
});

test('the quick count averages out to one per check, for a tenth of the writes', async () => {
  // A seeded stand-in for Math.random, so this is the same run every time:
  // over a thousand checks the count should land near a thousand, which is
  // the whole point of counting this way.
  let seed = 12345;
  const draw = () => {
    seed = (seed * 16807) % 2147483647;   // Park-Miller: exact in a double
    return (seed - 1) / 2147483646;
  };
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad' }) }),
    ai: () => ({ response: '{"corrections":[]}' }),
  });
  let writes = 0;
  const put = env.KEYS.put.bind(env.KEYS);
  env.KEYS.put = async (...args) => { writes += 1; return put(...args); };

  const real = Math.random;
  Math.random = draw;
  try {
    for (let i = 0; i < 1000; i += 1) await worker.fetch(quick('Fine.'), env);
  } finally {
    Math.random = real;
  }
  const count = Number(env.KEYS.store.get(QUICK_COUNTER()));
  // Expected 1,000 with a spread of about 95; three of those either way.
  assert.ok(count > 700 && count < 1300, `counted ${count} for 1,000 checks`);
  assert.equal(count, writes * 10);
  assert.ok(writes < 150, `${writes} KV writes for 1,000 checks`);
});

test("a key's quick allowance runs out with a plain message, before the model is asked", async () => {
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', quickDaily: 20 }) }),
  });
  await withRandom(0.05, async () => {
    const first = await worker.fetch(quick('I saw teh dog.'), env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).left, 19);
    assert.equal((await worker.fetch(quick('I saw teh dog.'), env)).status, 200);
    const res = await worker.fetch(quick('I saw teh dog.'), env);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "Today's quick checks on this key are used up. They come back at midnight UTC.");
    assert.equal(body.spent, undefined, 'one key being done is not the whole account being done');
  });
  assert.equal(env.calls.length, 2, 'the capped call must not reach the model');
});

test('the quick cap is 2,000 by default, and QUICK_DAILY changes it', async () => {
  const seeded = (count, record = { name: 'Dad' }) => fakeKv({
    'key:caret_abcdef123456': JSON.stringify(record),
    [QUICK_COUNTER()]: String(count),
  });

  await withRandom(0.5, async () => {
    // The default, including for a key with a full "daily" and none for quick.
    const under = await worker.fetch(quick('I saw teh dog.'), fakeEnv({ kv: seeded(1990, { name: 'Dad', daily: 3 }) }));
    assert.equal(under.status, 200);
    assert.equal((await under.json()).left, 9);
    assert.equal((await worker.fetch(quick('I saw teh dog.'), fakeEnv({ kv: seeded(2000) }))).status, 429);

    // QUICK_DAILY in the dashboard.
    const lower = fakeEnv({ kv: seeded(500) });
    lower.QUICK_DAILY = '500';
    assert.equal((await worker.fetch(quick('I saw teh dog.'), lower)).status, 429);

    // "0" there is the default, not "no cap" and not "nothing allowed".
    const zero = fakeEnv({ kv: seeded(1990) });
    zero.QUICK_DAILY = '0';
    assert.equal((await worker.fetch(quick('I saw teh dog.'), zero)).status, 200);
    const zeroCapped = fakeEnv({ kv: seeded(2000) });
    zeroCapped.QUICK_DAILY = '0';
    assert.equal((await worker.fetch(quick('I saw teh dog.'), zeroCapped)).status, 429);

    // "quickDaily" on the key beats QUICK_DAILY.
    const own = fakeEnv({ kv: seeded(500, { name: 'Owner', quickDaily: 3000 }) });
    own.QUICK_DAILY = '500';
    assert.equal((await worker.fetch(quick('I saw teh dog.'), own)).status, 200);
  });
});

test('a revoked key gets no quick checks either', async () => {
  const env = fakeEnv({
    kv: fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Old', revoked: true }) }),
  });
  const res = await worker.fetch(quick('I saw teh dog.'), env);
  assert.equal(res.status, 403);
  assert.equal(env.calls.length, 0);
});

// --------------------------------------------- KV having a bad day, quick edition

test('a quick counter KV cannot write still answers the check', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad' }) });
  kv.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };
  const env = fakeEnv({ kv });
  const res = await withRandom(0.05, () => worker.fetch(quick('I saw teh dog.'), env));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).corrections.length, 1);
});

test('a quick counter KV cannot read still answers the check', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', quickDaily: 1 }) });
  const get = kv.get.bind(kv);
  kv.get = async (key, options) => {
    if (key.startsWith('quick:')) throw new Error('KV get() limit exceeded');
    return get(key, options);
  };
  const res = await withRandom(0.5, () => worker.fetch(quick('I saw teh dog.'), fakeEnv({ kv })));
  assert.equal(res.status, 200);
});

test('a quick check whose key cannot be looked up gets the same 503', async () => {
  const kv = fakeKv();
  kv.get = async () => { throw new Error('KV unavailable'); };
  const env = fakeEnv({ kv });
  const res = await worker.fetch(quick('I saw teh dog.'), env);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /cannot check keys right now/);
  assert.equal(env.calls.length, 0);
});

// ------------------------------------------------------------------ the rest

test('/health names the quick model too, and still says nothing about keys', async () => {
  const env = fakeEnv();
  const body = await (await worker.fetch(new Request('https://w.example/health'), env)).json();
  assert.equal(body.quickModel, GRANITE);
  assert.equal(body.quickFallbacks, 2);
  assert.equal(body.model, env.MODEL, 'MODEL still decides the full check');
  assert.ok(!JSON.stringify(body).includes('caret_'));
});

test('JSON that is not an object is refused, not a crash', async () => {
  for (const raw of ['null', '"hello"', '42']) {
    const env = fakeEnv();
    const res = await worker.fetch(new Request('https://w.example/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...KEY },
      body: raw,
    }), env);
    assert.equal(res.status, 400, raw);
    assert.equal(env.calls.length, 0);
  }
});
