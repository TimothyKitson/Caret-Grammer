// node --test test/autocorrect.test.mjs
//
// Autocorrect changes the user's text without being asked, so the tests that
// matter most here are the ones asserting it does NOTHING: a wrong "fix" lands
// in their email before they can stop it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// autocorrect.js is a classic content script: it hangs itself off window.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/autocorrect.js'), 'utf8'), sandbox);
const { wordBefore, decide, startsSentence } = sandbox.window.__caret.autocorrect;

const ALL_ON = { capitalizeI: true, sentenceCaps: true, apostrophes: true, commonTypos: true };

// Types `text` and returns what the word just finished would become, or null.
const fixFor = (text, options = {}) => {
  const found = wordBefore(text, text.length);
  if (!found) return null;
  const verdict = decide(found, text, { autocorrect: ALL_ON, ...options });
  return verdict ? verdict.fixed : null;
};

// ------------------------------------------------------------- wordBefore

test('finds the word a terminator just closed', () => {
  const found = wordBefore('i dont ', 7);
  assert.equal(found.word, 'dont');
  assert.equal(found.start, 2);
  assert.equal(found.end, 6);
});

test('ignores a word still being typed', () => {
  assert.equal(wordBefore('i don', 5), null);
});

test('reads through an apostrophe', () => {
  assert.equal(wordBefore("say i'm ", 8).word, "i'm");
});

// ------------------------------------------------------------ capitalize I

test('capitalizes a lone i and its contractions', () => {
  assert.equal(fixFor('well i '), 'I');
  assert.equal(fixFor('well im '), "I'm");
  assert.equal(fixFor('well ive '), "I've");
  assert.equal(fixFor("well i'll "), "I'll");
});

test('leaves i alone when it is part of something else', () => {
  assert.equal(fixFor('the iPhone '), null);
  assert.equal(fixFor('see u_i '), null);
  assert.equal(fixFor('mail me@i '), null);
});

// ------------------------------------------------------------- apostrophes

test('adds the apostrophe to unambiguous contractions', () => {
  assert.equal(fixFor('i dont '), "don't");
  assert.equal(fixFor('he doesnt '), "doesn't");
  assert.equal(fixFor('we wouldnt '), "wouldn't");
  assert.equal(fixFor('you cant '), "can't");
  assert.equal(fixFor('so thats '), "that's");
  assert.equal(fixFor('and youre '), "you're");
});

test('leaves the ones that are also ordinary words', () => {
  for (const word of ['ill', 'id', 'were', 'its', 'lets', 'hes', 'shed']) {
    assert.equal(fixFor(`he ${word} `), null, `${word} should be left alone`);
  }
  for (const word of ['wont', 'cant']) {
    const fixed = fixFor(`he ${word} `);
    assert.ok(fixed && fixed.includes("'"), `${word} should get an apostrophe`);
  }
});

test('keeps the capital it was typed with', () => {
  assert.equal(fixFor('. Dont '), "Don't");
});

// ---------------------------------------------------------- sentence caps

test('capitalizes the first word of a sentence', () => {
  assert.equal(fixFor('hello. then '), 'Then');
  assert.equal(fixFor('wow! this '), 'This');
  assert.equal(fixFor('really? maybe '), 'Maybe');
  assert.equal(fixFor('hello '), 'Hello');
});

test('does not capitalize after an abbreviation or an initial', () => {
  assert.equal(fixFor('Dr. smith '), null);
  assert.equal(fixFor('Mrs. jones '), null);
  assert.equal(fixFor('J. r. tolkien '), null);
});

test('does not capitalize after a trailing-off ellipsis', () => {
  assert.equal(fixFor('wait... then '), null);
});

test('never capitalizes inside a URL or an email', () => {
  assert.equal(fixFor('https://example.com/docs '), null);
  assert.equal(fixFor('mail tim@school.org '), null);
  assert.ok(!startsSentence('go to https://a.com/b ', 18));
});

// ------------------------------------------------------------- the brakes

test('a word the user undid is never corrected again', () => {
  assert.equal(fixFor('i dont ', { skip: new Set(['dont']) }), null);
});

test("a word in the user's own dictionary is left alone", () => {
  assert.equal(fixFor('my dont ', { known: new Set(['dont']) }), null);
});

test('each sub-setting can be switched off on its own', () => {
  assert.equal(fixFor('i dont ', { autocorrect: { ...ALL_ON, apostrophes: false } }), null);
  assert.equal(fixFor('hello. then ', { autocorrect: { ...ALL_ON, sentenceCaps: false } }), null);
  assert.equal(fixFor('well i ', { autocorrect: { ...ALL_ON, capitalizeI: false } }), null);
});

test('leaves ALL-CAPS and mid-word capitals alone', () => {
  assert.equal(fixFor('say HTML '), null);
  assert.equal(fixFor('a McDonald '), null);
});

test('clean prose is not touched', () => {
  const prose = "I don't think that's the one he wanted. ";
  let caret = 0;
  for (const word of prose.split(' ')) {
    caret += word.length + 1;
    const found = wordBefore(prose, Math.min(caret, prose.length));
    if (!found) continue;
    assert.equal(decide(found, prose, { autocorrect: ALL_ON }), null, `changed "${found.word}"`);
  }
});
