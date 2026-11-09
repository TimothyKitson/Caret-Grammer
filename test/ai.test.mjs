// The optional Claude pass, tested with a stub instead of the network: the
// request shape is the part that silently rots, so it is pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWithClaude, AI_MODELS } from '../src/engine/ai.js';

function stub(response, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return {
      ok: response.status ? response.status < 400 : true,
      status: response.status || 200,
      json: async () => response.payload,
    };
  };
}

const CORRECTIONS = {
  content: [{
    type: 'text',
    text: JSON.stringify({
      corrections: [{
        before: 'I ',
        original: 'has went',
        replacement: 'went',
        kind: 'grammar',
        explanation: 'Simple past is enough here.',
      }],
    }),
  }],
  usage: { input_tokens: 100, output_tokens: 20 },
  model: 'claude-opus-5',
};

test('the request goes to the Messages API with the headers it needs', async () => {
  const capture = {};
  await checkWithClaude('I has went home.', {
    apiKey: 'sk-ant-test',
    fetchImpl: stub({ payload: CORRECTIONS }, capture),
  });
  assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capture.init.method, 'POST');
  assert.equal(capture.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(capture.init.headers['anthropic-version'], '2023-06-01');
  // Without this, a request carrying an Origin header is refused.
  assert.equal(capture.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(capture.init.headers['content-type'], 'application/json');
});

test('the body asks for JSON in the shape the parser expects', async () => {
  const capture = {};
  await checkWithClaude('I has went home.', {
    apiKey: 'k', model: 'claude-sonnet-5', effort: 'medium',
    fetchImpl: stub({ payload: CORRECTIONS }, capture),
  });
  const body = capture.body;
  assert.equal(body.model, 'claude-sonnet-5');
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  const schema = body.output_config.format.schema;
  assert.deepEqual(schema.required, ['corrections']);
  assert.deepEqual(
    schema.properties.corrections.items.required,
    ['before', 'original', 'replacement', 'kind', 'explanation'],
  );
  assert.equal(schema.properties.corrections.items.additionalProperties, false);
  assert.ok(body.max_tokens >= 4000);
  assert.ok(body.system.includes('copy editor'));
  assert.ok(body.messages[0].content.includes('I has went home.'));
  // No sampling or thinking parameters: they are rejected on current models.
  assert.equal(body.temperature, undefined);
  assert.equal(body.thinking, undefined);
});

test('the answer is turned into issues with real offsets', async () => {
  const text = 'I has went home.';
  const result = await checkWithClaude(text, {
    apiKey: 'k', fetchImpl: stub({ payload: CORRECTIONS }),
  });
  assert.equal(result.issues.length, 1);
  const issue = result.issues[0];
  assert.equal(text.slice(issue.start, issue.end), 'has went');
  assert.deepEqual(issue.replacements, ['went']);
  assert.equal(issue.source, 'ai');
  assert.equal(issue.category, 'grammar');
});

test('a bad key is reported as a bad key', async () => {
  await assert.rejects(
    () => checkWithClaude('x y z', {
      apiKey: 'nope',
      fetchImpl: stub({ status: 401, payload: { error: { message: 'invalid x-api-key' } } }),
    }),
    /rejected the API key/,
  );
});

test('other API errors carry the status and the reason', async () => {
  await assert.rejects(
    () => checkWithClaude('x y z', {
      apiKey: 'k',
      fetchImpl: stub({ status: 429, payload: { error: { message: 'rate limit' } } }),
    }),
    (error) => error.status === 429 && /429/.test(error.message) && /rate limit/.test(error.message),
  );
});

test('a refusal is surfaced, not treated as clean text', async () => {
  await assert.rejects(
    () => checkWithClaude('x y z', {
      apiKey: 'k',
      fetchImpl: stub({ payload: { stop_reason: 'refusal', content: [] } }),
    }),
    /declined/,
  );
});

test('nonsense in the response is a no-op, not a crash', async () => {
  const result = await checkWithClaude('hello world', {
    apiKey: 'k',
    fetchImpl: stub({ payload: { content: [{ type: 'text', text: 'not json at all' }] } }),
  });
  assert.deepEqual(result.issues, []);
});

test('no key means no request', async () => {
  let called = false;
  await assert.rejects(() => checkWithClaude('hi there', {
    apiKey: '',
    fetchImpl: async () => { called = true; },
  }));
  assert.equal(called, false);
});

test('long text is truncated rather than sent whole', async () => {
  const capture = {};
  const result = await checkWithClaude('word '.repeat(3000), {
    apiKey: 'k', fetchImpl: stub({ payload: CORRECTIONS }, capture),
  });
  assert.equal(result.truncated, true);
  assert.ok(capture.body.messages[0].content.length < 7000);
});

test('the model list only offers current model ids', async () => {
  assert.ok(AI_MODELS.length >= 3);
  for (const model of AI_MODELS) {
    assert.match(model.id, /^claude-(opus|sonnet|haiku)-[0-9-]+$/);
    assert.ok(model.label.length > 6);
  }
});
