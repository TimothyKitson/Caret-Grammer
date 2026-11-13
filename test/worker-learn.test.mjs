// The Caret Worker's 1.9.4 additions, run against fake Cloudflare bindings:
// "sentences" on a full check, the learned notes ("style"), and learn mode.
// Like worker.test.mjs, this tests the single-file build that gets pasted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTENCE_NOTE, LEARN_PROMPT } from '../src/shared/proofread.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(ROOT, 'worker/dist/worker.js'), 'utf8');
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
)).default;

function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const writes = [];
  return {
    store,
    writes,
    async get(key, options) {
      const value = store.get(key);
      if (value === undefined) return null;
      return options && options.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { writes.push(key); store.set(key, String(value)); },
  };
}

function fakeEnv({ kv, ai, extra = {} } = {}) {
  const calls = [];
  return {
    calls,
    KEYS: kv || fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3 }) }),
    AI: {
      async run(model, body) {
        calls.push({ model, body });
        if (ai) return ai(model, body);
        return { response: JSON.stringify({ corrections: [] }), usage: { prompt_tokens: 1000, completion_tokens: 100 } };
      },
    },
    ...extra,
  };
}

const post = (body) => new Request('https://w.example/check', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-caret-key': 'caret_abcdef123456' },
  body: JSON.stringify(body),
});
const today = () => new Date().toISOString().slice(0, 10);

// -------------------------------------------------------------- sentences

test('a full check asks about sentences only when told to', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'Some words here.' }), env);
  await worker.fetch(post({ text: 'Some words here.', sentences: true }), env);
  assert.ok(!env.calls[0].body.messages[0].content.includes(SENTENCE_NOTE));
  assert.ok(env.calls[1].body.messages[0].content.includes(SENTENCE_NOTE));
});

test('a quick check never asks about sentences, even when told to', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"corrections":[]}' }) });
  await worker.fetch(post({ text: 'One sentence.', mode: 'quick', sentences: true }), env);
  assert.ok(!env.calls[0].body.messages[0].content.includes(SENTENCE_NOTE));
});

test('only exactly true counts', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'Some words here.', sentences: 'yes' }), env);
  assert.ok(!env.calls[0].body.messages[0].content.includes(SENTENCE_NOTE));
});

// ------------------------------------------------------------------ notes

test('the notes go into a full check, cleaned, after the rules', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'Some words here.', style: 'Prefers British spelling\n\u0000- Likes dashes' }), env);
  const system = env.calls[0].body.messages[0].content;
  assert.match(system, /About this writer[\s\S]*- Prefers British spelling\n- Likes dashes/);
});

test('notes are never put into a quick check, and junk is not notes', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"corrections":[]}' }) });
  await worker.fetch(post({ text: 'One sentence.', mode: 'quick', style: '- x' }), env);
  assert.ok(!/About this writer/.test(env.calls[0].body.messages[0].content));
  const env2 = fakeEnv();
  await worker.fetch(post({ text: 'Some words here.', style: { evil: true } }), env2);
  await worker.fetch(post({ text: 'Some words here.', style: 'z'.repeat(50000) }), env2);
  assert.ok(!/About this writer/.test(env2.calls[0].body.messages[0].content));
  assert.ok(env2.calls[1].body.messages[0].content.length < 6000, 'a huge style is cut down, not pasted in');
});

// ------------------------------------------------------------------ learn

const LEARN_BODY = {
  mode: 'learn',
  text: 'The colour was lovely - really lovely.',
  notes: '- Likes dashes',
  accepted: [{ original: 'teh', replacement: 'the', kind: 'spelling', note: 'typo' }],
  ignored: [{ original: 'colour', replacement: 'color', kind: 'spelling', note: '' }],
};

test('learn mode answers with notes, on the cheap model, and nothing else', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"notes":"- Uses British spelling\\n- Likes dashes"}' }) });
  const response = await worker.fetch(post(LEARN_BODY), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'learn');
  assert.equal(body.notes, '- Uses British spelling\n- Likes dashes');
  assert.equal(body.corrections, undefined);
  assert.equal(env.calls[0].model, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(env.calls[0].body.messages[0].content, LEARN_PROMPT);
  const user = env.calls[0].body.messages[1].content;
  assert.match(user, /- "teh" -> "the" \(spelling\): typo/);
  assert.match(user, /- "colour" -> "color" \(spelling\)/);
  assert.match(user, /<notes>\n- Likes dashes\n<\/notes>/);
  assert.match(user, /The colour was lovely/);
  assert.ok(env.calls[0].body.max_tokens <= 400, 'a short answer cap');
});

test('learning goes on the meter, but not on the key\'s count of checks', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', daily: 3 }) });
  const env = fakeEnv({ kv, ai: () => ({ response: '{"notes":"- a"}', usage: { prompt_tokens: 2000, completion_tokens: 200 } }) });
  await worker.fetch(post(LEARN_BODY), env);
  assert.ok(Number(kv.store.get(`neurons:full:${today()}`)) > 0, 'metered');
  assert.equal(kv.store.get(`use:caret_abcdef123456:${today()}`), undefined, 'not counted as a check');
  assert.ok(kv.writes.filter((k) => k.startsWith('neurons:')).length === 1, 'one meter write');
  assert.ok(kv.writes.length <= 2, 'and at most one count write');
});

test('learning is turned away once the full checks\' share is spent', async () => {
  const kv = fakeKv({
    'key:caret_abcdef123456': JSON.stringify({ name: 'Dad' }),
    [`neurons:full:${today()}`]: '6000',
  });
  const env = fakeEnv({ kv });
  const response = await worker.fetch(post(LEARN_BODY), env);
  assert.equal(response.status, 429);
  assert.equal(env.calls.length, 0);
});

test('learning needs a real key', async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request('https://w.example/check', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(LEARN_BODY),
  }), env);
  assert.equal(response.status, 401);
  assert.equal(env.calls.length, 0);
});

test('learning from no text costs nothing', async () => {
  const env = fakeEnv();
  const body = await (await worker.fetch(post({ ...LEARN_BODY, text: '   ' }), env)).json();
  assert.equal(env.calls.length, 0);
  assert.equal(body.mode, 'learn');
  assert.equal(body.notes, '- Likes dashes', 'the notes come back as they were');
});

test('an answer with no notes in it says so, and is still metered', async () => {
  const kv = fakeKv({ 'key:caret_abcdef123456': JSON.stringify({ name: 'Dad' }) });
  const env = fakeEnv({ kv, ai: () => ({ response: 'I would rather not.' }) });
  const body = await (await worker.fetch(post(LEARN_BODY), env)).json();
  assert.equal(body.notes, null);
  assert.equal(body.unparsed, true);
  assert.ok(Number(kv.store.get(`neurons:full:${today()}`)) > 0);
});

test('a dead learning model falls through to the next', async () => {
  const env = fakeEnv({
    ai: (model) => {
      if (model.includes('gemma')) throw new Error('5028: model deprecated');
      return { response: '{"notes":"- b"}' };
    },
  });
  const body = await (await worker.fetch(post(LEARN_BODY), env)).json();
  assert.equal(body.notes, '- b');
  assert.equal(body.model, '@cf/zai-org/glm-4.7-flash');
});

test('LEARN_MODEL in the dashboard goes to the front', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"notes":"- c"}' }), extra: { LEARN_MODEL: '@cf/ibm-granite/granite-4.0-h-micro' } });
  await worker.fetch(post(LEARN_BODY), env);
  assert.equal(env.calls[0].model, '@cf/ibm-granite/granite-4.0-h-micro');
});

test('the changes a client sends are bounded', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"notes":"- a"}' }) });
  const many = Array.from({ length: 200 }, (_, i) => ({ original: `word${i}`, replacement: 'x'.repeat(5000), kind: 'k' }));
  await worker.fetch(post({ ...LEARN_BODY, accepted: many, ignored: 'nope' }), env);
  const user = env.calls[0].body.messages[1].content;
  assert.equal((user.match(/- "word\d+"/g) || []).length, 25);
  assert.ok(user.length < 12000);
  assert.match(user, /ignored:\n\(none\)/);
});

test('/health says learning is there, so the extension knows it may ask', async () => {
  const body = await (await worker.fetch(new Request('https://w.example/health'), fakeEnv())).json();
  assert.equal(body.learn, true);
  assert.equal(body.learnModel, '@cf/google/gemma-4-26b-a4b-it');
});

test('each key has its own daily learning cap, so a script cannot drain the meter or KV', async () => {
  const kv = fakeKv({
    'key:caret_abcdef123456': JSON.stringify({ name: 'Dad', learnDaily: 5 }),
    [`learn:caret_abcdef123456:${today()}`]: '5',
  });
  const env = fakeEnv({ kv, ai: () => ({ response: '{"notes":"- a"}' }) });
  const response = await worker.fetch(post(LEARN_BODY), env);
  assert.equal(response.status, 429);
  assert.equal(env.calls.length, 0, 'the model is never asked');
  const open = fakeEnv({ ai: () => ({ response: '{"notes":"- a"}' }) });
  assert.equal((await worker.fetch(post(LEARN_BODY), open)).status, 200, 'under the cap it works');
});

test('with sentences on, a full check gets more room to answer', async () => {
  const env = fakeEnv();
  await worker.fetch(post({ text: 'Some words here.' }), env);
  await worker.fetch(post({ text: 'Some words here.', sentences: true }), env);
  assert.equal(env.calls[0].body.max_tokens, 800);
  assert.equal(env.calls[1].body.max_tokens, 1200);
});
