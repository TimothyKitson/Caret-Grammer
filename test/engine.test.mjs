// node --test test/
//
// The important test in here is "clean prose is left alone": a checker that
// underlines correct writing is worse than no checker at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/engine/tokenize.js';
import { createDictionary } from '../src/engine/dictionary.js';
import { suggest, checkToken } from '../src/engine/spelling.js';
import { check, reconcile } from '../src/engine/engine.js';
import { toIssues } from '../src/engine/ai.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(ROOT, 'data', name), 'utf8');

const dict = createDictionary({
  wordsText: read('words.txt'),
  frequencyText: read('frequency.txt'),
  properNounsText: read('propernouns.txt'),
  misspellings: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'misspellings.json'), 'utf8')),
});

const idsFor = (text, options = {}) => check(text, { dict }, options).issues.map((i) => i.id);
const issuesFor = (text, options = {}) => check(text, { dict }, options).issues;
const findAt = (text, word, options = {}) => issuesFor(text, options)
  .find((issue) => text.slice(issue.start, issue.end) === word);

// ---------------------------------------------------------------- tokenizer

test('splits sentences without tripping on abbreviations or decimals', () => {
  const doc = analyze('Dr. Smith paid $3.50. Then he left! Did he?');
  assert.equal(doc.sentences.length, 3);
  assert.equal(doc.text.slice(doc.sentences[0].start, doc.sentences[0].end), 'Dr. Smith paid $3.50.');
});

test('skips links, e-mail addresses and anything with a digit in it', () => {
  const doc = analyze('Mail tim@ecschool.org or see https://ecschool.org/staff for the 3rd time.');
  const checked = doc.tokens.filter((t) => !t.skip).map((t) => t.lower);
  assert.deepEqual(checked, ['mail', 'or', 'see', 'for', 'the', 'time']);
});

test('marks the first word of each sentence', () => {
  const doc = analyze('One two. Three four.');
  assert.deepEqual(doc.tokens.filter((t) => t.first).map((t) => t.lower), ['one', 'three']);
});

test('a search box is not treated as prose', () => {
  assert.equal(analyze('cheap flights').isProse, false);
  assert.equal(analyze('This is a whole sentence with plenty of words.').isProse, true);
});

// --------------------------------------------------------------- dictionary

test('knows possessives, plurals possessive and contractions', () => {
  for (const word of ["dog's", "teachers'", "don't", "it's", "o'clock", 'sarah'.replace('sarah', 'school')]) {
    assert.equal(dict.isKnown(word), true, word);
  }
  assert.equal(dict.isKnown('recieve'), false);
});

test('words added by the user count as correct', () => {
  const local = createDictionary({ wordsText: 'apple\n', frequencyText: 'apple\n', misspellings: {} });
  assert.equal(local.isKnown('zyzzyva'), false);
  local.setUserWords(['Zyzzyva']);
  assert.equal(local.isKnown('zyzzyva'), true);
});

// ----------------------------------------------------------------- spelling

test('suggests the right word for common typos', () => {
  const expected = {
    teh: 'the', recieve: 'receive', seperate: 'separate', wierd: 'weird',
    definately: 'definitely', tomorow: 'tomorrow', becuase: 'because',
    goverment: 'government', neccessary: 'necessary', freind: 'friend',
    dont: "don't", cant: "can't", wtih: 'with', thsi: 'this',
  };
  for (const [typo, want] of Object.entries(expected)) {
    assert.equal(suggest(typo, dict, 3)[0], want, `${typo} -> ${want}`);
  }
});

test('keeps the capitalisation of what was typed', () => {
  assert.equal(suggest('Teh', dict, 1)[0], 'The');
  assert.equal(suggest('TEH', dict, 1)[0], 'THE');
});

test('leaves names, acronyms, code and shouting alone', () => {
  const text = 'Kitson and Zhang met the PTO about JavaScript and HTML at hmmmm o’clock.';
  const doc = analyze(text);
  const flagged = doc.tokens
    .map((t) => checkToken(t, dict, {}))
    .filter(Boolean)
    .map((i) => i.text);
  assert.deepEqual(flagged, []);
});

test('still flags a capitalised word when an ordinary word is one edit away', () => {
  const issue = findAt('Teh meeting is over.', 'Teh');
  assert.ok(issue, 'expected Teh to be flagged');
  assert.equal(issue.replacements[0], 'The');
});

// -------------------------------------------------------------------- rules

const RULE_CASES = [
  ['Your welcome to stay.', 'your-youre', "You're"],
  ['I know you’re dog is friendly.', 'youre-your', 'your'],
  ['Their is a problem.', 'their-there', 'There'],
  ['There going to be late.', 'there-theyre', "They're"],
  ['Its a good day.', 'its-it-is', "It's"],
  ['The dog wagged it’s tail.', 'it-is-its', null],
  ['This is better then that.', 'then-than', 'than'],
  ['I could of told you.', 'could-of', 'could have'],
  ['Do not loose your keys.', 'loose-lose', 'lose'],
  ['That is to expensive.', 'to-too', 'too'],
  ['The school principle called.', 'principle-principal', 'principal'],
  ['We have went there before.', 'have-past-tense', 'gone'],
  ['He don’t like it.', 'he-dont', "doesn't"],
  ['They was late.', 'they-is', 'were'],
  ['I is ready.', 'i-is', 'am'],
  ['She have three cats.', 'he-have', 'has'],
  ['There is many reasons.', 'there-is-plural', 'are'],
  ['I ate a apple.', 'article-agreement', 'an'],
  ['It took an hour.', null, null],
  ['She is an honest woman.', null, null],
  ['He went to an university.', 'article-agreement', 'a'],
  ['We read an FBI report.', null, null],
  ['i went home.', 'lowercase-i', 'I'],
  ['the meeting is over. it starts again soon.', 'sentence-capital', null],
  ['That is the the plan.', 'doubled-word', 'the'],
  ['Hello ,world.', 'space-before-punctuation', null],
  ['One sentence.Another sentence follows.', 'missing-space-after-period', null],
  ['I dont know.', 'missing-apostrophe', "don't"],
  ['We have alot to do.', null, 'a lot'],
  ['Stop!!! Now.', 'repeated-punctuation', '!'],
  ['In order to finish, we hurried.', 'wordy-phrase', 'To'],
  ['Each and every child came.', 'redundant-phrase', 'Every'],
  ['I did not see nothing.', 'double-negative', null],
  ['Less people came this year.', 'less-fewer', 'Fewer'],
  ['For all intensive purposes it is done.', 'fixed-phrase', 'For all intents and purposes'],
];

for (const [text, ruleId, replacement] of RULE_CASES) {
  test(`rule: ${text}`, () => {
    const issues = issuesFor(text);
    if (ruleId === null && replacement === null) {
      assert.deepEqual(issues.map((i) => `${i.id}:${i.text}`), [], `expected nothing for "${text}"`);
      return;
    }
    if (ruleId) {
      const ids = issues.map((i) => i.id).concat(issues.flatMap((i) => i.alsoFlaggedBy || []));
      assert.ok(ids.includes(ruleId), `expected ${ruleId}, got ${ids.join(', ') || 'nothing'}`);
    }
    if (replacement) {
      // Suggestions come back with the writer's own apostrophe style.
      const all = issues.flatMap((i) => i.replacements).map((r) => r.replace(/\u2019/g, "'"));
      assert.ok(all.includes(replacement), `expected a "${replacement}" suggestion, got ${JSON.stringify(all)}`);
    }
  });
}

// ------------------------------------------------------- precision (the point)

const CLEAN = [
  'The principal of the school sent an email to every parent this morning.',
  'They’re going to bring their books over there before the bell rings.',
  'It’s a shame that its battery died, but you’re welcome to borrow mine.',
  'I would rather walk than drive, and then I will eat lunch.',
  'She could have told me sooner; I have gone over the notes twice.',
  'We were where the map said we would be, and we are still here.',
  'Please advise the team; that advice was helpful.',
  'The effect of the new rule will affect every student.',
  'Fewer people came, so there is less noise than last year.',
  'He has an hour to finish an honest day of work at a university.',
  'Dr. Smith paid $3.50 for a 3rd cup of coffee at 10:30 a.m.',
  'Visit https://ecschool.org/staff or email tim@ecschool.org for details.',
  'The dog wagged its tail because it was happy to see us.',
  'Whether or not it rains, the weather will not stop the game.',
  'I passed the school in the past week without noticing the new sign.',
  'Quiet please: I am quite tired of the noise in this room.',
  'Every day I use my everyday coffee mug.',
  'That is a part of the plan we set apart from the rest.',
  'Who’s coming, and whose car are we taking?',
  'The lesson led us to read about lead pipes.',
  'Take a deep breath, then breathe out slowly.',
  'JavaScript and HTML are taught by the PTO volunteers at Englewood Christian School.',
  'Kitson and Zhang will meet Mrs. Alvarez on Wednesday.',
  'You’re right that your idea is the best one we have heard.',
  'We accept every application except the one that arrived late.',
  'The team is ready; the players are ready too.',
  'I want to go to the store, and I would like to walk there.',
  'Between you and me, the answer is obvious.',
];

for (const sentence of CLEAN) {
  test(`clean: ${sentence.slice(0, 46)}…`, () => {
    const issues = issuesFor(sentence);
    assert.deepEqual(
      issues.map((i) => `${i.id} @ "${sentence.slice(i.start, i.end)}"`),
      [],
    );
  });
}

// ------------------------------------------------------------------- engine

test('one span is reported once, with the suggestions merged', () => {
  const merged = reconcile([
    { id: 'a', category: 'grammar', start: 0, end: 4, text: 'alot', replacements: ['a lot'] },
    { id: 'b', category: 'spelling', start: 0, end: 4, text: 'alot', replacements: ['allot'] },
    { id: 'c', category: 'style', start: 2, end: 8, text: 'ot bar', replacements: [] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'b');                       // spelling outranks grammar
  assert.deepEqual(merged[0].replacements, ['allot', 'a lot']);
});

test('the ignore list silences one complaint about one word', () => {
  const text = 'Their is a problem.';
  assert.ok(idsFor(text).includes('their-there'));
  const quiet = idsFor(text, { ignored: new Set(['their-there:their']) });
  assert.ok(!quiet.includes('their-there'));
});

test('switching a category off switches its rules off', () => {
  const text = 'In order to win, each and every player must try.';
  assert.ok(idsFor(text).length > 0);
  assert.deepEqual(idsFor(text, { categories: { style: false } }), []);
});

test('offsets always point at the text that was flagged', () => {
  const text = 'Their is alot of reasons why i could of went, and its to late.';
  for (const issue of issuesFor(text)) {
    assert.equal(text.slice(issue.start, issue.end), issue.text);
    assert.ok(issue.end > issue.start);
  }
});

test('a big document stays fast', () => {
  const paragraph = 'The principal sent an email about the meeting, and their is alot to discuss. ';
  const text = paragraph.repeat(120);                    // ~9 000 characters
  const started = Date.now();
  const result = check(text, { dict }, {});
  const elapsed = Date.now() - started;
  assert.ok(result.issues.length > 100);
  assert.ok(elapsed < 1500, `took ${elapsed}ms`);
});

// ----------------------------------------------------------------------- AI

test('AI corrections are matched back to the right occurrence', () => {
  const text = 'The cat sat. The cat sat again.';
  const issues = toIssues(text, [
    { before: 'again. ', original: 'The cat', replacement: 'A cat', kind: 'style', explanation: 'x' },
    { before: '', original: 'The cat', replacement: 'One cat', kind: 'style', explanation: 'y' },
  ]);
  assert.equal(issues.length, 2);
  for (const issue of issues) assert.equal(text.slice(issue.start, issue.end), 'The cat');
  assert.notEqual(issues[0].start, issues[1].start);
});

test('AI corrections that do not appear in the text are dropped', () => {
  assert.deepEqual(toIssues('Hello there.', [
    { before: '', original: 'not present', replacement: 'x', kind: 'grammar', explanation: 'z' },
  ]), []);
});

// ------------------------------------------------------- names vs. ordinary words

test('an ordinary word that is also a surname is left alone', () => {
  for (const sentence of [
    'That is good.', 'This is good.', 'I am good.', "It's good to see you.",
    'This is will, the new intern.', 'I am rich in the ways that count.',
    'Thanks, hope you had a nice weekend.', "It's may already.",
    'I met will at the station.', 'Tell grace I said hello.',
    'Please ask bill about it.', 'We rose early and walked to town.',
    'A frank conversation is overdue.', 'The wifi is slow.',
  ]) {
    const names = issuesFor(sentence).filter((i) => i.id === 'proper-noun-capital');
    assert.deepEqual(names.map((i) => sentence.slice(i.start, i.end)), [], sentence);
  }
});

test('a word the sentence introduces as a name is still caught', () => {
  for (const [sentence, word] of [
    ['Hello, my name is good.', 'good'],
    ['My name is will.', 'will'],
    ['Dear rose,', 'rose'],
    ['Hi will,', 'will'],
    ['Mr. good signed it.', 'good'],
    ['Dr. smith called.', 'smith'],
    ['Sincerely, grace', 'grace'],
    ['They call me rose.', 'rose'],
  ]) {
    const names = issuesFor(sentence).filter((i) => i.id === 'proper-noun-capital');
    assert.deepEqual(names.map((i) => sentence.slice(i.start, i.end)), [word], sentence);
  }
});

test('a greeting only names someone when nothing else follows', () => {
  // "Hi rose," is Rose. "Hi, good to hear from you" is not Mr Good.
  assert.equal(issuesFor('Hi, good to hear from you.').filter((i) => i.id === 'proper-noun-capital').length, 0);
  assert.equal(issuesFor('Hey will,').filter((i) => i.id === 'proper-noun-capital').length, 1);
});

test('a name that is never an ordinary word is caught anywhere', () => {
  for (const [sentence, word] of [
    ['we went to america.', 'america'],
    ['see you on monday.', 'monday'],
    ['i read it in january.', 'january'],
  ]) {
    const found = issuesFor(sentence).find((i) => i.id === 'proper-noun-capital');
    assert.ok(found, sentence);
    assert.equal(sentence.slice(found.start, found.end), word);
  }
});

// ------------------------------------------------------------ added rules

test('a subject pronoun followed by "where" wants "were"', () => {
  assert.ok(idsFor('They where at the store.').includes('where-were-subject'));
  assert.deepEqual(idsFor('Where were you?'), []);
  assert.deepEqual(idsFor('Where is the office?'), []);
});

test('"could care less" is the wrong way round', () => {
  const found = findAt('I could care less about it.', 'could care less');
  assert.ok(found);
  assert.deepEqual(found.replacements, ["couldn't care less"]);
});

test('"he don\'t" wants "doesn\'t"', () => {
  const found = findAt('She dont know yet.', 'dont');
  assert.ok(found);
  // The apostrophe fix is offered too, but agreement comes first.
  assert.equal(found.replacements[0], "doesn't");
  assert.deepEqual(idsFor("I don't know."), []);
  assert.deepEqual(idsFor("They don't know."), []);
});

test('"me and him" is only wrong when it is the subject', () => {
  const found = findAt('Me and him went together.', 'Me and him');
  assert.ok(found);
  assert.deepEqual(found.replacements, ['He and I']);
  assert.deepEqual(findAt('Me and her are late.', 'Me and her').replacements, ['She and I']);
  assert.deepEqual(idsFor('She told me and him about it.'), []);
});

test('an unknown run of capitals is an acronym, not a misspelling', () => {
  assert.deepEqual(idsFor('Her IEP meeting is Tuesday.'), []);
  assert.deepEqual(idsFor('The HVAC and FAFSA forms are late.'), []);
});

test('modern everyday words are in the dictionary', () => {
  for (const sentence of [
    'I took screenshots of the emojis and hashtags.',
    'The teacher emailed the printables for homeschooling.',
    'He is livestreaming the fundraiser.',
    'Check the dropdown and the checkboxes on the website.',
    'She unsubscribed from the podcast and the newsletter.',
    'The paraprofessional updated the gradebook.',
  ]) {
    assert.deepEqual(idsFor(sentence).filter((id) => id === 'spelling-unknown'), [], sentence);
  }
});
