// The optional AI pass, tested with a stub instead of the network: the request
// shape is the part that silently rots, so both providers are pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWithAi, AI_MODELS, DEFAULT_MODEL } from '../src/engine/ai.js';

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
  await checkWithAi('I has went home.', {
    provider: 'anthropic',
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
  await checkWithAi('I has went home.', {
    provider: 'anthropic',
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
  const result = await checkWithAi(text, {
    provider: 'anthropic',
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
    () => checkWithAi('x y z', {
      provider: 'anthropic',
      apiKey: 'nope',
      fetchImpl: stub({ status: 401, payload: { error: { message: 'invalid x-api-key' } } }),
    }),
    /rejected the API key/,
  );
});

test('other API errors carry the status and the reason', async () => {
  await assert.rejects(
    () => checkWithAi('x y z', {
      provider: 'anthropic',
      apiKey: 'k',
      fetchImpl: stub({ status: 429, payload: { error: { message: 'rate limit' } } }),
    }),
    (error) => error.status === 429 && /429/.test(error.message) && /rate limit/.test(error.message),
  );
});

test('a refusal is surfaced, not treated as clean text', async () => {
  await assert.rejects(
    () => checkWithAi('x y z', {
      provider: 'anthropic',
      apiKey: 'k',
      fetchImpl: stub({ payload: { stop_reason: 'refusal', content: [] } }),
    }),
    /declined/,
  );
});

test('nonsense in the response is a no-op, not a crash', async () => {
  const result = await checkWithAi('hello world', {
    provider: 'anthropic',
    apiKey: 'k',
    fetchImpl: stub({ payload: { content: [{ type: 'text', text: 'not json at all' }] } }),
  });
  assert.deepEqual(result.issues, []);
});

test('no key means no request', async () => {
  let called = false;
  await assert.rejects(() => checkWithAi('hi there', {
    apiKey: '',
    fetchImpl: async () => { called = true; },
  }));
  assert.equal(called, false);
});

test('long text is truncated rather than sent whole', async () => {
  const capture = {};
  const result = await checkWithAi('word '.repeat(3000), {
    provider: 'anthropic',
    apiKey: 'k', fetchImpl: stub({ payload: CORRECTIONS }, capture),
  });
  assert.equal(result.truncated, true);
  assert.ok(capture.body.messages[0].content.length < 7000);
});

test('every provider has models and a default that is one of them', () => {
  const shape = {
    gemini: /^gemini-[0-9.]+-\w+$/,
    openai: /^gpt-[\w.-]+$/,
    anthropic: /^claude-(opus|sonnet|haiku)-[0-9-]+$/,
  };
  for (const [provider, models] of Object.entries(AI_MODELS)) {
    assert.ok(models.length >= 2, provider);
    for (const model of models) {
      assert.match(model.id, shape[provider], `${provider}: ${model.id}`);
      assert.ok(model.label.length > 6);
    }
    assert.ok(
      models.some((m) => m.id === DEFAULT_MODEL[provider]),
      `${provider} default ${DEFAULT_MODEL[provider]} is not in its own list`,
    );
  }
});

test('a Gemini request carries the key in a header, not the URL', async () => {
  const capture = {};
  const payload = {
    candidates: [{
      content: { parts: [{ text: JSON.stringify({ corrections: [] }) }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 50 },
  };
  await checkWithAi('I has went home.', {
    provider: 'gemini',
    apiKey: 'AIzaSyTest',
    model: 'gemini-2.5-flash',
    fetchImpl: stub({ payload }, capture),
  });
  assert.ok(capture.url.includes('gemini-2.5-flash:generateContent'), capture.url);
  assert.ok(!capture.url.includes('AIzaSyTest'), 'the key must not be in the URL');
  assert.equal(capture.init.headers['x-goog-api-key'], 'AIzaSyTest');
  assert.equal(capture.body.generationConfig.responseMimeType, 'application/json');
  // Gemini rejects additionalProperties anywhere in the schema.
  assert.ok(!JSON.stringify(capture.body.generationConfig.responseSchema).includes('additionalProperties'));
});

test("a Gemini rate limit says it will clear on its own", async () => {
  await assert.rejects(
    () => checkWithAi('x y z', {
      provider: 'gemini',
      apiKey: 'AIzaSyTest',
      fetchImpl: stub({ status: 429, payload: { error: { message: 'quota' } } }),
    }),
    /free tier limit reached/,
  );
});

test('an OpenAI request uses a bearer token and a strict schema', async () => {
  const capture = {};
  const payload = {
    choices: [{ message: { content: JSON.stringify({ corrections: [] }) } }],
    usage: { prompt_tokens: 40 },
    model: 'gpt-4o-mini',
  };
  await checkWithAi('I has went home.', {
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini',
    fetchImpl: stub({ payload }, capture),
  });
  assert.equal(capture.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capture.init.headers.authorization, 'Bearer sk-test');
  assert.equal(capture.body.response_format.json_schema.strict, true);
  assert.equal(capture.body.messages[0].role, 'system');
});

test('the prompt tells the model not to reach for fancier words', () => {
  const capture = {};
  return checkWithAi('hello', {
    provider: 'openai', apiKey: 'sk-test',
    fetchImpl: stub({ payload: { choices: [{ message: { content: '{"corrections":[]}' } }] } }, capture),
  }).then(() => {
    const system = capture.body.messages[0].content;
    assert.match(system, /plain, everyday words/);
    assert.match(system, /utilize/);
    assert.match(system, /more advanced, more academic/);
  });
});
