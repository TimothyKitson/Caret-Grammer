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

// ------------------------------------------- places autocorrect stays out of

// Types the whole string one character at a time, applying every fix, the
// way the content script does. Returns the text as it ends up.
const typeOut = (input, options = {}) => {
  let text = '';
  for (const ch of input) {
    text += ch;
    const found = wordBefore(text, text.length);
    if (!found) continue;
    const verdict = decide(found, text, { autocorrect: ALL_ON, ...options });
    if (verdict) text = text.slice(0, found.start) + verdict.fixed + text.slice(found.end);
  }
  return text;
};

test('"i.e." is not turned into "I.e."', () => {
  assert.equal(typeOut('Bring snacks, i.e. fruit. '), 'Bring snacks, i.e. fruit. ');
  assert.equal(typeOut('bring snacks, i.e fruit '), 'Bring snacks, i.e fruit ');
});

test('a lone i before a full stop is still fixed, once the space shows it ended', () => {
  assert.equal(typeOut('so do i. then we left. '), 'So do I. Then we left. ');
  assert.equal(typeOut('ok i.\nbye '), 'Ok I.\nBye ');
});

test('street and unit abbreviations do not start a sentence', () => {
  assert.equal(typeOut('Take Elm Ave. to the end. '), 'Take Elm Ave. to the end. ');
  assert.equal(typeOut('Acme Inc. makes it. '), 'Acme Inc. makes it. ');
  assert.equal(typeOut('It weighs 3 lbs. or so. '), 'It weighs 3 lbs. or so. ');
});

test('two dots is a typo for an ellipsis, not a full stop', () => {
  assert.equal(typeOut('Wait.. then what? '), 'Wait.. then what? ');
});

test('i used as a name, a letter or in maths is not the pronoun', () => {
  assert.equal(fixFor('the variable i '), null);
  assert.equal(fixFor('for i '), null);
  assert.equal(fixFor('x = i '), null);
  assert.equal(fixFor('dot the i '), null);
  // ...while the pronoun after ordinary words is still fixed.
  assert.equal(fixFor('if i '), 'I');
  assert.equal(fixFor('where i '), 'I');
  assert.equal(fixFor('that i '), 'I');
  assert.equal(fixFor('well - i '), 'I');
});

test('nothing is changed in text that is plainly code', () => {
  const code = 'def run(items):\n    for i in items:\n        total = i + 1\n    if i == 0:\n        print(i)\n';
  assert.equal(typeOut(code).slice(code.indexOf('\n')), code.slice(code.indexOf('\n')));
  assert.equal(fixFor('const x = 1;\nim '), null);
  assert.equal(fixFor('```\nif i '), null);
  // ...and nothing at all in an editor drawn in a code font.
  assert.equal(typeOut('for i in range(10): ', { field: { code: true } }), 'for i in range(10): ');
});

test('ordinary prose that happens to use code-ish words is still corrected', () => {
  assert.equal(typeOut('For example: then i left. '), 'For example: then I left. ');
  assert.equal(typeOut('Let me know if i can help. '), 'Let me know if I can help. ');
  assert.equal(typeOut('From now on dont. '), "From now on don't. ");
});

test('single-line fields: no capital on the first word of a search or a name', () => {
  assert.equal(fixFor('pizza ', { field: { kind: 'input', type: 'text' } }), null);
  assert.equal(fixFor('pizza ', { field: { kind: 'input', type: 'search' } }), null);
  assert.equal(fixFor('hi. how ', { field: { kind: 'input', type: 'search' } }), null);
  // A sentence after a full stop in an ordinary input is still a sentence.
  assert.equal(fixFor('hi. how ', { field: { kind: 'input', type: 'text' } }), 'How');
  assert.equal(fixFor('pizza ', { field: { kind: 'textarea' } }), 'Pizza');
});

test('email, URL and phone fields are never touched', () => {
  for (const type of ['email', 'url', 'tel']) {
    assert.equal(fixFor('i ', { field: { kind: 'input', type } }), null, type);
    assert.equal(fixFor('dont ', { field: { kind: 'input', type } }), null, type);
  }
});

test('a page that says it is not English gets no English-only fixes', () => {
  assert.equal(fixFor('pane i ', { field: { lang: 'it' } }), null);
  assert.equal(fixFor('ich bin im ', { field: { lang: 'de-DE' } }), null);
  assert.equal(fixFor('ich bin im ', { field: { lang: 'en-GB' } }), "I'm");
});

test('autocapitalize="off" turns sentence capitals off', () => {
  assert.equal(fixFor('hello ', { field: { autocapitalize: 'off' } }), null);
  assert.equal(fixFor('hello ', { field: { autocapitalize: 'none' } }), null);
  // It is about capitals at the start of a sentence, not about "I".
  assert.equal(fixFor('so i ', { field: { autocapitalize: 'off' } }), 'I');
});

test('a single letter at the start of a line is a label, except "a"', () => {
  assert.equal(fixFor('x '), null);
  assert.equal(fixFor('a '), 'A');
});
