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
