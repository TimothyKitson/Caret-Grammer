// 1.9.4: sentence problems, names written without their capital, and learning
// how someone writes. The request shapes are pinned here with a stub for the
// network, the same way ai.test.mjs pins the full check's.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT, QUICK_SYSTEM_PROMPT, SENTENCE_NOTE, LEARN_PROMPT, LEARN_SCHEMA, SCHEMA,
  cleanNotes, parseNotes, cleanChanges, learnUserPrompt, styleNote, parseCorrections,
  MAX_NOTES_CHARS, MAX_LEARN_CHANGES,
} from '../src/shared/proofread.js';
import { checkWithAi, learnStyle, toIssues, looksSensitive } from '../src/engine/ai.js';
import { reconcile } from '../src/engine/engine.js';
import { mergeSettings, DEFAULT_SETTINGS, LEARN_DELAY_MS, LEARN_DAILY } from '../src/shared/defaults.js';
import { CARET_ENDPOINT } from '../src/shared/apikey.js';

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

const openAiAnswer = (content) => ({ payload: { choices: [{ message: { content } }], model: 'gpt-6-luna' } });

// ------------------------------------------------------------------ names

test('the prompts let a name missing its capital be fixed, and only that', () => {
  assert.match(SYSTEM_PROMPT, /except a name written without\s+its capital letter/);
  assert.match(SYSTEM_PROMPT, /"john" -> "John"/);
  assert.match(QUICK_SYSTEM_PROMPT, /except a name missing its capital \(john -> John\)/);
});

// --------------------------------------------------------------- locating

test('a correction is only placed on a whole word: "went" is not the end of "havwent"', () => {
  const text = 'I havwent home. We went out.';
  const issues = toIssues(text, [{ before: '', original: 'went', replacement: 'gone', kind: 'grammar', explanation: 'x' }]);
  assert.equal(issues.length, 1);
  assert.equal(text.slice(issues[0].start, issues[0].end), 'went');
  assert.equal(issues[0].start, text.indexOf(' went') + 1, 'the standalone word, not the tail of havwent');
});

test('a correction found only inside a longer word is dropped', () => {
  const issues = toIssues('I havwent home.', [{ before: '', original: 'went', replacement: 'gone', kind: 'grammar', explanation: 'x' }]);
  assert.deepEqual(issues, []);
});

test('a lower-case name is fixed like any other word', () => {
  const text = 'Like john would be John.';
  const issues = toIssues(text, [{ before: 'Like ', original: 'john', replacement: 'John', kind: 'grammar', explanation: 'A name.' }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].start, 5);
  assert.deepEqual(issues[0].replacements, ['John']);
});

// -------------------------------------------------------------- sentences

const RUN_ON = 'we went home it was late';

test('a sentence problem is its own kind, with no button when the fix is big', () => {
  const text = `Yesterday ${RUN_ON}. Fine.`;
  const [issue] = toIssues(text, [{ before: 'Yesterday ', original: RUN_ON, replacement: 'We went home because it was late, so we stopped', kind: 'sentence', explanation: 'Two sentences joined.' }], { sentences: true });
  assert.equal(issue.category, 'sentence');
  assert.equal(issue.id, 'ai-sentence');
  assert.equal(issue.short, 'Sentence');
  assert.equal(issue.source, 'ai');
  assert.equal(text.slice(issue.start, issue.end), RUN_ON);
  assert.deepEqual(issue.replacements, [], 'a rewrite is never offered as a button');
  assert.equal(issue.message, 'Two sentences joined.');
});

test('a small sentence fix - a full stop, a comma, one word - gets its button', () => {
  const text = `Yesterday ${RUN_ON}.`;
  for (const fix of ['we went home. It was late', 'we went home; it was late', 'we went home because it was late']) {
    const [issue] = toIssues(text, [{ before: '', original: RUN_ON, replacement: fix, kind: 'sentence', explanation: 'x' }], { sentences: true });
    assert.deepEqual(issue.replacements, [fix], fix);
  }
});

test('a sentence fix may not drop a negative, change a number, or add two words', () => {
  const cases = [
    ['I did not go there', 'I did go there'],
    ['we had 3 dogs at home', 'we had 4 dogs at home'],
    ['we went home it was late', 'we went home because it was very late'],
    ['it was unclear to me why', 'it was clear to me why'],
  ];
  for (const [original, replacement] of cases) {
    const [issue] = toIssues(`${original}.`, [{ before: '', original, replacement, kind: 'sentence', explanation: 'x' }], { sentences: true });
    assert.deepEqual(issue.replacements, [], replacement);
  }
});

test('a sentence problem may cover more words than a word fix, but not a paragraph', () => {
  const long = `${'word '.repeat(90)}end`;
  assert.deepEqual(toIssues(`${long}.`, [{ before: '', original: long, replacement: '', kind: 'sentence', explanation: 'x' }], { sentences: true }), []);
  assert.deepEqual(toIssues('a\nb', [{ before: '', original: 'a\nb', replacement: '', kind: 'sentence', explanation: 'x' }], { sentences: true }), []);
});

test('a word fix inside a sentence problem keeps its own underline', () => {
  const text = `Yesterday ${RUN_ON}.`;
  const issues = toIssues(text, [
    { before: 'Yesterday ', original: RUN_ON, replacement: '', kind: 'sentence', explanation: 'run-on' },
    { before: 'we ', original: 'went', replacement: 'walked', kind: 'style', explanation: 'word' },
  ], { sentences: true });
  assert.equal(issues.length, 2);
  const kept = reconcile(issues.map((i) => ({ ...i, confidence: 'high' })));
  assert.deepEqual(kept.map((i) => i.category).sort(), ['sentence', 'style']);
});

test('sentence problems only compete with each other', () => {
  const issues = [
    { id: 'ai-sentence', category: 'sentence', start: 0, end: 20, text: 'x', replacements: [], confidence: 'high' },
    { id: 'ai-sentence', category: 'sentence', start: 5, end: 25, text: 'y', replacements: [], confidence: 'high' },
    { id: 'spelling', category: 'spelling', start: 2, end: 6, text: 'z', replacements: ['q'], confidence: 'high' },
  ];
  const kept = reconcile(issues);
  assert.equal(kept.filter((i) => i.category === 'sentence').length, 1, 'overlapping sentence problems: one');
  assert.equal(kept.filter((i) => i.category === 'spelling').length, 1, 'the word inside stays');
  assert.deepEqual(kept.map((i) => i.start), [...kept.map((i) => i.start)].sort((a, b) => a - b));
});

test('the schema and the parser both know the sentence kind', () => {
  assert.ok(SCHEMA.properties.corrections.items.properties.kind.enum.includes('sentence'));
  const parsed = parseCorrections(JSON.stringify({ corrections: [{ before: '', original: RUN_ON, replacement: '', kind: 'sentence', explanation: 'x' }] }));
  assert.equal(parsed[0].kind, 'sentence');
});

test('sentences are only asked about when switched on, on every provider', async () => {
  const off = {};
  await checkWithAi('Some text here.', { provider: 'openai', apiKey: 'sk-test-123456789012345678', fetchImpl: stub(openAiAnswer('{"corrections":[]}'), off) });
  assert.ok(!off.body.messages[0].content.includes(SENTENCE_NOTE));
  const on = {};
  await checkWithAi('Some text here.', { provider: 'openai', apiKey: 'sk-test-123456789012345678', sentences: true, fetchImpl: stub(openAiAnswer('{"corrections":[]}'), on) });
  assert.ok(on.body.messages[0].content.includes(SENTENCE_NOTE));
  const caret = {};
  await checkWithAi('Some text here.', { provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', sentences: true, fetchImpl: stub({ payload: { corrections: [] } }, caret) });
  assert.equal(caret.body.sentences, true);
  const caretOff = {};
  await checkWithAi('Some text here.', { provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', fetchImpl: stub({ payload: { corrections: [] } }, caretOff) });
  assert.equal('sentences' in caretOff.body, false, 'nothing extra sent when it is off');
});

// ------------------------------------------------------------------ notes

test('notes are cleaned to at most eight short lines of "- "', () => {
  const raw = 'Notes:\n1. Uses British spelling\n* likes   dashes\n\n- casual tone x\n' + Array.from({ length: 12 }, (_, i) => `- more ${i}`).join('\n');
  const clean = cleanNotes(raw);
  const lines = clean.split('\n');
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => /^- \S/.test(l)));
  assert.equal(lines[0], '- Uses British spelling');
  assert.equal(lines[1], '- likes dashes');
  assert.equal(lines[2], '- casual tone x');
  const huge = cleanNotes(Array.from({ length: 8 }, () => `- ${'word '.repeat(60)}`).join('\n'));
  assert.ok(huge.length <= MAX_NOTES_CHARS);
  assert.ok(huge.split('\n').every((l) => l.length <= 142));
  assert.equal(cleanNotes(undefined), '');
  assert.equal(cleanNotes(42), '');
  assert.equal(cleanNotes('\u0000\u0007'), '');
});

test('notes are read from JSON, fenced JSON, or a bare list - and nothing else', () => {
  assert.equal(parseNotes('{"notes":"- a\\n- b"}'), '- a\n- b');
  assert.equal(parseNotes('```json\n{"notes":"- a"}\n```'), '- a');
  assert.equal(parseNotes('Sure! {"notes":"- a"} hope that helps'), '- a');
  assert.equal(parseNotes('Here you go:\n- one\n- two'), '- one\n- two');
  assert.equal(parseNotes('I cannot help with that.'), null);
  assert.equal(parseNotes(''), null);
  assert.equal(parseNotes('{"notes":""}'), '', 'an empty list is an answer, not a failure');
});

test('the changes sent are strings only, short, and a bounded number', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ original: `w${i}`, replacement: 'x', kind: 'spelling', note: 'n' }));
  assert.equal(cleanChanges(many).length, MAX_LEARN_CHANGES);
  const odd = cleanChanges([null, 'x', { original: '' }, { original: { a: 1 } }, { original: 'ok', replacement: 7, kind: 'a'.repeat(50), note: 'z'.repeat(500) }]);
  assert.equal(odd.length, 1);
  assert.deepEqual(odd[0], { original: 'ok', replacement: '', kind: 'a'.repeat(20), note: 'z'.repeat(160) });
  assert.deepEqual(cleanChanges('nope'), []);
});

test('the learning request names what was taken, what was ignored, and the writing', () => {
  const prompt = learnUserPrompt({
    notes: '- Likes dashes',
    accepted: [{ original: 'teh', replacement: 'the', kind: 'spelling', note: '' }],
    ignored: [{ original: 'colour', replacement: 'color', kind: 'spelling', note: 'US spelling' }],
    text: 'The colour was nice.',
  });
  assert.match(prompt, /<notes>\n- Likes dashes\n<\/notes>/);
  assert.match(prompt, /accepted:\n- "teh" -> "the" \(spelling\)/);
  assert.match(prompt, /ignored:\n- "colour" -> "color" \(spelling\): US spelling/);
  assert.match(prompt, /<text>\nThe colour was nice.\n<\/text>/);
  assert.match(learnUserPrompt({ text: 'x' }), /\(none yet\)[\s\S]*\(none\)[\s\S]*\(none\)/);
});

test('the learning prompt never lets notes switch real corrections off, or carry personal details', () => {
  assert.match(LEARN_PROMPT, /NEVER copy sentences/);
  assert.match(LEARN_PROMPT, /NEVER mention names, places,\s+personal details/);
  assert.match(LEARN_PROMPT, /NEVER write anything that would stop a real spelling or grammar mistake/);
  assert.deepEqual(LEARN_SCHEMA.required, ['notes']);
  assert.match(styleNote('- x'), /never\s+override the rules above/);
  assert.equal(styleNote(''), '');
  assert.equal(styleNote('   '), '');
});

test('notes go with a full check on every provider, after the rules', async () => {
  const capture = {};
  await checkWithAi('Some text here.', {
    provider: 'openai', apiKey: 'sk-test-123456789012345678', notes: '- Prefers British spelling', fetchImpl: stub(openAiAnswer('{"corrections":[]}'), capture),
  });
  const system = capture.body.messages[0].content;
  assert.ok(system.startsWith(SYSTEM_PROMPT));
  assert.match(system, /About this writer[\s\S]*- Prefers British spelling/);
  const caret = {};
  await checkWithAi('Some text here.', {
    provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', notes: 'Prefers British spelling', fetchImpl: stub({ payload: { corrections: [] } }, caret),
  });
  assert.equal(caret.body.style, '- Prefers British spelling', 'the Worker is sent the clean notes, not a built prompt');
  const none = {};
  await checkWithAi('Some text here.', { provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', fetchImpl: stub({ payload: { corrections: [] } }, none) });
  assert.equal('style' in none.body, false);
});

test('a key that ends up in the notes is blanked before it is sent', async () => {
  const caret = {};
  await checkWithAi('Some text here.', {
    provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', notes: '- uses sk-ant-abcdefghijklmnopqrstuvwxyz a lot', fetchImpl: stub({ payload: { corrections: [] } }, caret),
  });
  assert.ok(!caret.body.style.includes('abcdefghijklmnop'));
});

// --------------------------------------------------------------- learning

test('learning with Caret sends mode learn, the changes and the text, and keeps nothing else', async () => {
  const capture = {};
  const result = await learnStyle('The colour was nice.', {
    provider: 'caret',
    apiKey: 'caret_a1b2c3d4e5f6',
    notes: '- Likes dashes',
    accepted: [{ original: 'teh', replacement: 'the', kind: 'spelling', note: 'typo' }],
    ignored: [{ original: 'colour', replacement: 'color', kind: 'spelling', note: '' }],
    fetchImpl: stub({ payload: { notes: '- Uses British spelling\n- Likes dashes', mode: 'learn', model: 'gemma' } }, capture),
  });
  assert.equal(capture.url, `${CARET_ENDPOINT}/check`);
  assert.equal(capture.init.headers['x-caret-key'], 'caret_a1b2c3d4e5f6');
  assert.deepEqual(Object.keys(capture.body).sort(), ['accepted', 'ignored', 'mode', 'notes', 'text']);
  assert.equal(capture.body.mode, 'learn');
  assert.equal(capture.body.text, 'The colour was nice.');
  assert.deepEqual(capture.body.accepted, [{ original: 'teh', replacement: 'the', kind: 'spelling', note: 'typo' }]);
  assert.equal(result.notes, '- Uses British spelling\n- Likes dashes');
});

test('learning blanks secrets in the text and the changes', async () => {
  const capture = {};
  await learnStyle('my card is 4111 1111 1111 1111 ok', {
    provider: 'caret',
    apiKey: 'caret_a1b2c3d4e5f6',
    accepted: [{ original: 'sk-ant-abcdefghijklmnopqrstuvwxyz', replacement: 'x' }],
    fetchImpl: stub({ payload: { notes: '- a', mode: 'learn' } }, capture),
  });
  assert.ok(!capture.body.text.includes('4111'));
  assert.ok(!capture.body.accepted[0].original.includes('abcdefghijklmnop'));
});

test('a Caret server from before learning is reported, not trusted', async () => {
  await assert.rejects(
    () => learnStyle('Some writing.', {
      provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', fetchImpl: stub({ payload: { corrections: [], mode: 'full' } }),
    }),
    (error) => error.code === 'old-server',
  );
});

test('the shared allowance running out while learning is a quiet pause', async () => {
  await assert.rejects(
    () => learnStyle('Some writing.', {
      provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', fetchImpl: stub({ status: 429, payload: { error: 'used up' } }),
    }),
    (error) => error.code === 'quiet',
  );
});

test('learning with your own key asks for notes, not corrections', async () => {
  const openai = {};
  const result = await learnStyle('Some writing.', {
    provider: 'openai', apiKey: 'sk-test-123456789012345678', fetchImpl: stub(openAiAnswer('{"notes":"- Short sentences"}'), openai),
  });
  assert.equal(openai.body.messages[0].content, LEARN_PROMPT);
  assert.match(openai.body.messages[1].content, /What they have written now:/);
  assert.equal(openai.body.response_format.json_schema.name, 'notes');
  assert.deepEqual(openai.body.response_format.json_schema.schema, LEARN_SCHEMA);
  assert.equal(result.notes, '- Short sentences');

  const gemini = {};
  await learnStyle('Some writing.', {
    provider: 'gemini', apiKey: 'AIzaSyTest', fetchImpl: stub({ payload: { candidates: [{ content: { parts: [{ text: '{"notes":"- x"}' }] } }] } }, gemini),
  });
  assert.equal(gemini.body.systemInstruction.parts[0].text, LEARN_PROMPT);
  assert.deepEqual(gemini.body.generationConfig.responseSchema.required, ['notes']);

  const anthropic = {};
  const claude = await learnStyle('Some writing.', {
    provider: 'anthropic', apiKey: 'sk-ant-test', fetchImpl: stub({ payload: { content: [{ type: 'text', text: '{"notes":"- y"}' }] } }, anthropic),
  });
  assert.equal(anthropic.body.system, LEARN_PROMPT);
  assert.deepEqual(anthropic.body.output_config.format.schema, LEARN_SCHEMA);
  assert.equal(claude.notes, '- y');
});

test('an answer with no notes in it reads as null, so the old notes are kept', async () => {
  const result = await learnStyle('Some writing.', {
    provider: 'openai', apiKey: 'sk-test-123456789012345678', fetchImpl: stub(openAiAnswer('I would rather not.')),
  });
  assert.equal(result.notes, null);
});

test('no key, no learning', async () => {
  await assert.rejects(() => learnStyle('x', { provider: 'caret' }), (e) => e.code === 'no-key');
});

// ---------------------------------------------------------------- settings

test('the new settings have safe defaults and survive bad stored values', () => {
  assert.equal(DEFAULT_SETTINGS.aiSentences, false);
  assert.equal(DEFAULT_SETTINGS.aiLearn, true);
  assert.equal(DEFAULT_SETTINGS.aiNotes, '');
  assert.equal(LEARN_DELAY_MS, 5 * 60 * 1000);
  assert.ok(LEARN_DAILY > 0 && LEARN_DAILY <= 20);
  const odd = mergeSettings({ aiSentences: 'yes', aiLearn: 0, aiNotes: { x: 1 }, aiNotesAt: 'soon', aiLearnUsage: null });
  assert.equal(odd.aiSentences, false);
  assert.equal(odd.aiLearn, true, 'only an explicit false turns learning off');
  assert.equal(odd.aiNotes, '');
  assert.equal(odd.aiNotesAt, 0);
  assert.deepEqual(odd.aiLearnUsage, { day: '', count: 0 });
  assert.equal(mergeSettings({ aiLearn: false }).aiLearn, false);
  assert.equal(mergeSettings({ aiNotes: 'n'.repeat(5000) }).aiNotes.length, 1000);
});

// ------------------------------------------------- from the 1.9.4 review

test('a sentence answer is held to the word rules when sentences were not asked for', () => {
  const text = 'Me and him goes to store every day.';
  const correction = { before: '', original: 'Me and him goes to store every day', replacement: 'He and I go to the store every day', kind: 'sentence', explanation: 'x' };
  assert.deepEqual(toIssues(text, [correction]), [], 'a rewrite is not a word swap');
  assert.equal(toIssues(text, [correction], { sentences: true })[0].category, 'sentence');
});

test('a sentence fix that says something different gets no button, however short', () => {
  for (const [original, replacement] of [
    ['I will be at the meeting tomorrow', 'I will not be at the meeting tomorrow'],
    ['She said yes to the offer', 'She said no to the offer'],
    ['I was able to finish the report', 'I was unable to finish the report'],
    ['I went to the bank on Monday and they was closed', 'I went to the bank on Friday and it was open'],
  ]) {
    const [issue] = toIssues(`${original}.`, [{ before: '', original, replacement, kind: 'sentence', explanation: 'x' }], { sentences: true });
    assert.deepEqual(issue.replacements, [], replacement);
  }
});

test('corrections in languages written without spaces are still placed', () => {
  for (const [text, original, replacement] of [
    ['我今天去了学效。', '学效', '学校'],
    ['今日は学校に行きまた。', '行きまた', '行きました'],
    ['ฉันไปโรงเรยนวันนี้', 'โรงเรยน', 'โรงเรียน'],
  ]) {
    const issues = toIssues(text, [{ before: '', original, replacement, kind: 'spelling', explanation: 'x' }]);
    assert.equal(issues.length, 1, text);
  }
});

test('only words and short phrases are sent as the leave-alone list', async () => {
  const capture = {};
  const sentence = 'we saw the old shop it was closed and then we went home';
  await checkWithAi('Some text here.', {
    provider: 'caret', apiKey: 'caret_a1b2c3d4e5f6', leaveAlone: ['Ignitia', sentence, 'colour'], fetchImpl: stub({ payload: { corrections: [] } }, capture),
  });
  assert.deepEqual(capture.body.leaveAlone, ['Ignitia', 'colour']);
});

test('looksSensitive matches everything the page refuses to send', () => {
  for (const s of ['api_key=hunter2abc', 'token: 9f8e7d6c5b', 'secret: swordfish', 'my password is hunter2', '4111 1111 1111 1111', 'sk-ant-abcdefghijklmnopqrstuvwxyz']) {
    assert.equal(looksSensitive(s), true, s);
  }
  for (const s of ['I like tokens of thanks.', 'The secret is out.', 'Call me at 3 pm.']) {
    assert.equal(looksSensitive(s), false, s);
  }
});
