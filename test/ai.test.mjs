// The optional AI pass, tested with a stub instead of the network: the request
// shape is the part that silently rots, so both providers are pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWithAi, checkQuick, leaveAloneFor, toIssues, maskSecrets, resolveModel, AI_MODELS, DEFAULT_MODEL,
} from '../src/engine/ai.js';

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
    apiKey: 'k', model: 'claude-sonnet-5-5', effort: 'medium',
    fetchImpl: stub({ payload: CORRECTIONS }, capture),
  });
  const body = capture.body;
  assert.equal(body.model, 'claude-sonnet-5-5');
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
    gemini: /^gemini-[0-9.]+-[\w-]+$/,
    openai: /^gpt-[\w.-]+$/,
    anthropic: /^claude-(opus|sonnet|haiku)-[0-9-]+$/,
  };
  for (const [provider, models] of Object.entries(AI_MODELS)) {
    if (provider === 'caret') {
      // The shared Worker picks its own model, so there is nothing to offer.
      assert.equal(models.length, 1);
      assert.equal(models[0].id, '');
      assert.equal(DEFAULT_MODEL.caret, '');
      continue;
    }
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
    model: 'gemini-3.5-flash-lite',
    fetchImpl: stub({ payload }, capture),
  });
  assert.ok(capture.url.includes('gemini-3.5-flash-lite:generateContent'), capture.url);
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
    model: 'gpt-6-luna',
  };
  await checkWithAi('I has went home.', {
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-6-luna',
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

// ------------------------------------------------------- the shared Worker

test('a caret_ key is recognised as its own provider', async () => {
  const { providerFor } = await import('../src/shared/apikey.js');
  assert.equal(providerFor('caret_a1b2c3d4e5f6'), 'caret');
  assert.equal(providerFor('caret_short'), null, 'too short to be a key');
  assert.equal(providerFor('caret'), null);
});

test('a caret_ key posts to the configured Worker with the key in a header', async () => {
  const { CARET_ENDPOINT } = await import('../src/shared/apikey.js');
  const capture = {};
  const payload = { corrections: [{
    before: 'I ', original: 'teh', replacement: 'the', kind: 'spelling', explanation: 'A typo.',
  }], model: '@cf/meta/llama-3.1-8b-instruct', left: 118 };

  const result = await checkWithAi('I teh cat', {
    provider: 'caret',
    apiKey: 'caret_a1b2c3d4e5f6',
    fetchImpl: stub({ payload }, capture),
  });

  assert.ok(CARET_ENDPOINT.startsWith('https://'), 'the endpoint must be https');
  assert.equal(capture.url, `${CARET_ENDPOINT}/check`);
  assert.equal(capture.init.headers['x-caret-key'], 'caret_a1b2c3d4e5f6');
  // The key goes in a header, never the URL, which ends up in logs.
  assert.ok(!capture.url.includes('caret_a1b2'));
  // Only the text is sent - no settings, no site, nothing else about the user.
  assert.deepEqual(Object.keys(capture.body), ['text']);
  assert.equal(capture.body.text, 'I teh cat');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].replacements[0], 'the');
});

test('the Worker running out of allowance is a quiet skip, not an error', async () => {
  await assert.rejects(
    () => checkWithAi('I teh cat', {
      provider: 'caret',
      apiKey: 'caret_a1b2c3d4e5f6',
      fetchImpl: stub({
        status: 429,
        payload: { error: 'The shared daily allowance is used up.', spent: true },
      }),
    }),
    // code 'quiet' is what stops the worker writing it to the error line.
    (error) => error.status === 429 && error.code === 'quiet',
  );
});

test('the proofreading contract is one copy, shared with the Worker', async () => {
  const contract = await import('../src/shared/proofread.js');
  assert.match(contract.SYSTEM_PROMPT, /plain, everyday words/);
  assert.match(contract.userPrompt('hello'), /<text>\nhello\n<\/text>/);
  // The Worker imports these same two, so a change reaches both at once.
  assert.ok(contract.SCHEMA.properties.corrections);
});

test('a model that wraps its JSON in chatter is still understood', async () => {
  const { parseCorrections } = await import('../src/shared/proofread.js');
  const wanted = [{ before: 'I ', original: 'teh', replacement: 'the', kind: 'spelling', explanation: 'typo' }];
  const body = JSON.stringify({ corrections: wanted });
  // Small models do all three of these.
  assert.deepEqual(parseCorrections(body), wanted);
  assert.deepEqual(parseCorrections('```json\n' + body + '\n```'), wanted);
  assert.deepEqual(parseCorrections('Sure! Here you go:\n' + body), wanted);
  assert.equal(parseCorrections('I could not do that.'), null);
  assert.equal(parseCorrections(''), null);
});

// ------------------------------------------------- what not to correct

test('words the writer rejected are named in the prompt', async () => {
  const capture = {};
  await checkWithAi('Kitson signed it.', {
    provider: 'openai',
    apiKey: 'sk-test',
    leaveAlone: ['Kitson', "ya'll", 'good'],
    fetchImpl: stub({ payload: { choices: [{ message: { content: '{"corrections":[]}' } }] } }, capture),
  });
  const system = capture.body.messages[0].content;
  // The original instructions are still there, with the list appended.
  assert.match(system, /meticulous copy editor/);
  assert.match(system, /NEVER propose a change to any of them/);
  for (const word of ['Kitson', "ya'll", 'good']) assert.ok(system.includes(word), word);
});

test('no rejections means no note at all', async () => {
  const capture = {};
  await checkWithAi('hello', {
    provider: 'openai',
    apiKey: 'sk-test',
    fetchImpl: stub({ payload: { choices: [{ message: { content: '{"corrections":[]}' } }] } }, capture),
  });
  const { SYSTEM_PROMPT } = await import('../src/shared/proofread.js');
  assert.equal(capture.body.messages[0].content, SYSTEM_PROMPT, 'the prompt should be untouched');
});

test('the list reaches every provider', async () => {
  const cases = [
    ['anthropic', 'sk-ant-x', { payload: CORRECTIONS }, (b) => b.system],
    ['gemini', 'AIzaSyTest', {
      payload: { candidates: [{ content: { parts: [{ text: '{"corrections":[]}' }] } }] },
    }, (b) => b.systemInstruction.parts[0].text],
  ];
  for (const [provider, apiKey, response, read] of cases) {
    const capture = {};
    await checkWithAi('hello', {
      provider, apiKey, leaveAlone: ['Kitson'], fetchImpl: stub(response, capture),
    });
    assert.match(read(capture.body), /Kitson/, provider);
  }
});

test('the Worker is sent the list, not a pre-built prompt', async () => {
  // The Worker owns the prompt - that is the point of it - so the extension
  // hands over the words and lets the server put them in.
  const capture = {};
  await checkWithAi('hello', {
    provider: 'caret',
    apiKey: 'caret_a1b2c3d4e5f6',
    leaveAlone: ['Kitson'],
    fetchImpl: stub({ payload: { corrections: [] } }, capture),
  });
  assert.deepEqual(capture.body.leaveAlone, ['Kitson']);
  assert.ok(!JSON.stringify(capture.body).includes('copy editor'), 'the prompt must not be sent');
});

test('the note cannot grow without limit', async () => {
  const { leaveAloneNote, MAX_LEAVE_ALONE } = await import('../src/shared/proofread.js');
  const many = Array.from({ length: 500 }, (_, i) => `word${i}`);
  const note = leaveAloneNote(many);
  assert.equal(note.split('\n').filter((l) => l.startsWith('  word')).length, MAX_LEAVE_ALONE);
  // A whole sentence is not a word someone rejected.
  assert.equal(leaveAloneNote(['x'.repeat(100)]), '');
  assert.equal(leaveAloneNote([]), '');
  // Duplicates collapse, whatever their case.
  assert.equal(leaveAloneNote(['Tim', 'tim', 'TIM']).split('\n').filter((l) => l.startsWith('  ')).length, 1);
});

// -------------------------------------------- a fix must not change meaning

/** Run one model correction through the filter and see if it survives. */
const survives = (text, original, replacement) => toIssues(text, [{
  before: '', original, replacement, kind: 'grammar', explanation: 'x',
}]).length === 1;

test('a correction may never drop a negative', () => {
  // The reported bug: "i didnt end up getting one" came back as "end up
  // getting one", which says the opposite thing.
  const text = 'i was going to get a dog but i didnt end up getting one.';
  assert.equal(survives(text, 'didnt end up getting', 'end up getting'), false);
  assert.equal(survives(text, 'i didnt', 'I'), false);

  for (const [original, replacement] of [
    ["couldn't go", 'could go'],
    ['never went', 'went'],
    ['is not ready', 'is ready'],
    ['cannot be done', 'can be done'],
    ["wasn't there", 'was there'],
    ['no one came', 'one came'],
  ]) {
    assert.equal(survives(`she ${original} today`, original, replacement), false, original);
  }
});

test('gaining a negative is still allowed, because some idioms need it', () => {
  const text = 'I could care less about it.';
  assert.equal(survives(text, 'could care less', "couldn't care less"), true);
});

test('fixing a word inside a negative keeps working', () => {
  const text = 'i didnt go to the shop';
  assert.equal(survives(text, 'didnt', "didn't"), true);
  assert.equal(survives(text, 'i didnt go', "I didn't go"), true);
});

test('dropping one word is a fix, dropping two is a rewrite', () => {
  assert.equal(survives('the the report is ready', 'the the', 'the'), true);
  assert.equal(survives('it was very very good', 'very very', 'very'), true);
  assert.equal(
    survives('we should probably maybe just go', 'should probably maybe just go', 'should go'),
    false,
  );
});

test('ordinary word swaps are untouched by any of this', () => {
  assert.equal(survives('I recieved it', 'recieved', 'received'), true);
  assert.equal(survives('we should of gone', 'should of', 'should have'), true);
  assert.equal(survives('Me and him went', 'Me and him', 'He and I'), true);
});

test('the prompt says it too, not just the filter', async () => {
  const { SYSTEM_PROMPT } = await import('../src/shared/proofread.js');
  assert.match(SYSTEM_PROMPT, /NEVER drop a negative/);
  assert.match(SYSTEM_PROMPT, /NEVER change what a sentence means/);
});

test('a correction may not change a number, a time, a price or a phone number', () => {
  assert.equal(survives('we met at 15:30 on May 3', '15:30', '16:30'), false);
  assert.equal(survives('it costs $40 a month', '$40', '$400'), false);
  assert.equal(survives('call 555-0101 today', '555-0101', '555-0110'), false);
  // Punctuation around a number is still fair game.
  assert.equal(survives('in 2019 we moved', '2019', '2019,'), true);
});

test('hardly, barely, rarely and without count as negatives', () => {
  assert.equal(survives('she hardly ever calls', 'hardly ever', 'ever'), false);
  assert.equal(survives('he barely passed', 'barely passed', 'passed'), false);
  assert.equal(survives('I rarely go there', 'rarely', 'often'), false);
  assert.equal(survives('the room was without heat', 'without', 'with'), false);
});

test('taking a negative prefix off a word is refused', () => {
  assert.equal(survives('it is unclear', 'unclear', 'clear'), false);
  assert.equal(survives('a nonprofit group', 'nonprofit', 'profit'), false);
  assert.equal(survives('that is incorrect', 'incorrect', 'correct'), false);
  assert.equal(survives('it was unnecesary', 'unnecesary', 'unnecessary'), true);
});

// ----------------------------------------------------- secrets stay at home

test('card numbers, keys and passwords are blanked before anything is sent', async () => {
  const capture = {};
  const text = 'I has went home. Card 4111 1111 1111 1111, key sk-proj-abcdefghijklmnop1234, '
    + 'ssn 123-45-6789, and my password is hunter2.';
  await checkWithAi(text, {
    provider: 'caret',
    apiKey: 'caret_testtesttest',
    leaveAlone: ['Caret', 'sk-proj-abcdefghijklmnop1234'],
    fetchImpl: stub({ payload: { corrections: [] } }, capture),
  });
  const sent = JSON.stringify(capture.body);
  for (const secret of ['4111', 'abcdefghijklmnop1234', '123-45-6789', 'hunter2']) {
    assert.ok(!sent.includes(secret), `sent ${secret}`);
  }
  assert.ok(sent.includes('I has went home.'), 'the prose itself still goes');
  assert.deepEqual(capture.body.leaveAlone, ['Caret']);
});

test('blanking keeps the length, and leaves ordinary numbers alone', () => {
  const text = 'Call 555-123-4567 at 10am on 2026-11-11. Order #12345678. PIN: 4821.';
  const masked = maskSecrets(text);
  assert.equal(masked.length, text.length);
  assert.ok(masked.startsWith('Call 555-123-4567 at 10am on 2026-11-11. Order #12345678. PIN: '));
  assert.ok(masked.endsWith('••••.'));
});

// ------------------------------------------------------------------- models

test('a model saved by an older version is swapped for its replacement', () => {
  assert.equal(resolveModel('gemini', 'gemini-2.0-flash'), 'gemini-3.5-flash-lite');   // shut down
  assert.equal(resolveModel('gemini', 'gemini-2.5-flash'), 'gemini-3.5-flash-lite');   // closed to new keys
  assert.equal(resolveModel('openai', 'gpt-4o-mini'), 'gpt-6-luna');
  assert.equal(resolveModel('openai', 'gpt-4o'), 'gpt-6.1-terra');
  assert.equal(resolveModel('anthropic', 'claude-haiku-4-5'), 'claude-haiku-5-5');
  assert.equal(resolveModel('anthropic', 'claude-opus-5'), 'claude-opus-5-5');
  // A current choice is kept, and a model from another provider is not used.
  assert.equal(resolveModel('openai', 'gpt-6.1-terra'), 'gpt-6.1-terra');
  assert.equal(resolveModel('gemini', 'gpt-6-luna'), DEFAULT_MODEL.gemini);
  assert.equal(resolveModel('anthropic', ''), DEFAULT_MODEL.anthropic);
});

test('the old id is what gets upgraded on the wire, too', async () => {
  const capture = {};
  await checkWithAi('I has went home.', {
    provider: 'gemini', apiKey: 'AIzaSyTest', model: 'gemini-2.0-flash',
    fetchImpl: stub({ payload: { candidates: [] } }, capture),
  });
  assert.ok(capture.url.includes('/gemini-3.5-flash-lite:generateContent'), capture.url);
});

test('GPT-6 is asked for no reasoning and sent no temperature', async () => {
  const reply = { payload: { choices: [{ message: { content: '{"corrections":[]}' } }] } };
  const modern = {};
  await checkWithAi('I has went home.', {
    provider: 'openai', apiKey: 'sk-test', model: 'gpt-6-luna', fetchImpl: stub(reply, modern),
  });
  assert.equal(modern.body.reasoning_effort, 'none');
  assert.equal('temperature' in modern.body, false);
  assert.equal('max_tokens' in modern.body, false);
});

// ------------------------------------------------------------- quick check

test('a quick check sends one sentence, marked quick, with only the words it contains', async () => {
  const capture = {};
  const reply = { payload: { corrections: [{
    before: 'The lake is ', original: 'near', replacement: 'close', kind: 'style', explanation: 'x',
  }], model: 'small', left: 9, mode: 'quick' } };
  const result = await checkQuick('The lake is near the Caretville trees.', {
    apiKey: 'caret_testtesttest',
    leaveAlone: ['Caretville', 'gonna', 'sk-proj-abcdefghijklmnop1234'],
    fetchImpl: stub(reply, capture),
  });
  assert.match(capture.url, /\/check$/);
  assert.equal(capture.init.headers['x-caret-key'], 'caret_testtesttest');
  assert.equal(capture.body.mode, 'quick');
  assert.equal(capture.body.text, 'The lake is near the Caretville trees.');
  assert.deepEqual(capture.body.leaveAlone, ['Caretville']);
  assert.equal(result.issues.length, 1);
  // Offsets are relative to the sentence, for the page to place.
  assert.equal(result.issues[0].start, 12);
  assert.equal(result.issues[0].end, 16);
  assert.equal(result.issues[0].source, 'ai');
});

test('a quick check blanks secrets and is refused for a run-on block', async () => {
  const capture = {};
  await checkQuick('My card is 4111 1111 1111 1111 and it expires soon.', {
    apiKey: 'caret_testtesttest', fetchImpl: stub({ payload: { corrections: [], mode: 'quick' } }, capture),
  });
  assert.ok(!JSON.stringify(capture.body).includes('4111'));
  await assert.rejects(
    () => checkQuick('word '.repeat(200), { apiKey: 'caret_testtesttest', fetchImpl: stub({ payload: {} }) }),
    /too long/,
  );
});

test('a used-up allowance on a quick check is a quiet pause', async () => {
  await assert.rejects(
    () => checkQuick('This is a sentence.', {
      apiKey: 'caret_testtesttest',
      fetchImpl: stub({ status: 429, payload: { error: 'used up' } }),
    }),
    (error) => error.code === 'quiet',
  );
});

test('a normal check does not say quick', async () => {
  const capture = {};
  await checkWithAi('I has went home.', {
    provider: 'caret', apiKey: 'caret_testtesttest', fetchImpl: stub({ payload: { corrections: [] } }, capture),
  });
  assert.equal('mode' in capture.body, false);
});

test('leaveAloneFor keeps only words that appear, case-insensitively', () => {
  assert.deepEqual(leaveAloneFor('We met at CARETVILLE today.', ['caretville', 'gonna', '']), ['caretville']);
});

test('a server that answers a quick check with the big model is reported, not trusted', async () => {
  await assert.rejects(
    () => checkQuick('This is a sentence.', {
      apiKey: 'caret_testtesttest',
      fetchImpl: stub({ payload: { corrections: [], model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } }),
    }),
    (error) => error.code === 'old-server',
  );
});
