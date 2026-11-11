// node --test test/sentences.test.mjs
//
// The quick check spends a small shared free allowance one sentence at a
// time, so the tests that matter most are the ones that count: a paragraph of
// five sentences is five checks, not six and not four, and clicking around,
// pasting, or text that was already there costs nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// sentences.js is a classic content script: it hangs itself off window.
const sandbox = { window: {} };
vm.createContext(sandbox);
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/content/sentences.js'), 'utf8');
vm.runInContext(SOURCE, sandbox);
const { segments, segmentAt, isCheckable, createTracker } = sandbox.window.__caret.sentences;

// Objects made inside the vm come from another realm, so compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const texts = (text) => plain(segments(text).map((s) => s.text));
const shape = (text) => plain(segments(text).map((s) => [s.text, s.complete]));

/**
 * A field and a person typing into it. Every keystroke goes through
 * tracker.input() exactly as the content script would call it, and every
 * sentence that comes back as due is collected in `due`, in order.
 */
function field(initial = '') {
  const tracker = createTracker(initial);
  const state = { text: initial, caret: initial.length, due: [], tracker };
  const collect = (list) => {
    assert.ok(Array.isArray(list), 'tracker calls return an array');
    state.due.push(...list);
    return state;
  };
  Object.assign(state, {
    /** Types one character at a time at the caret. */
    type(input) {
      for (const ch of input) {
        state.text = state.text.slice(0, state.caret) + ch + state.text.slice(state.caret);
        state.caret += ch.length;
        collect(tracker.input(state.text, state.caret, ch === '\n' ? 'insertParagraph' : 'insertText'));
      }
      return state;
    },
    backspace(times = 1) {
      for (let i = 0; i < times; i += 1) {
        state.text = state.text.slice(0, state.caret - 1) + state.text.slice(state.caret);
        state.caret -= 1;
        collect(tracker.input(state.text, state.caret, 'deleteContentBackward'));
      }
      return state;
    },
    /** Deletes `count` characters before the caret in one go: Ctrl+Backspace, a cut. */
    deleteBefore(count, kind = 'deleteWordBackward') {
      state.text = state.text.slice(0, state.caret - count) + state.text.slice(state.caret);
      state.caret -= count;
      return collect(tracker.input(state.text, state.caret, kind));
    },
    paste(input, kind = 'insertFromPaste') {
      state.text = state.text.slice(0, state.caret) + input + state.text.slice(state.caret);
      state.caret += input.length;
      return collect(tracker.input(state.text, state.caret, kind));
    },
    /**
     * A paste the editor handles itself (ProseMirror, Quill, CKEditor, Lexical,
     * TinyMCE): no input event, so the content script reports it a moment
     * later from its paste listener, when the caret can still be unknown.
     */
    editorPaste(input, caretKnown = false) {
      state.text = state.text.slice(0, state.caret) + input + state.text.slice(state.caret);
      state.caret += input.length;
      return collect(tracker.input(state.text, caretKnown ? state.caret : null, 'insertFromPaste'));
    },
    /** A click or an arrow key: the caret moves, the text does not. */
    moveTo(caret) {
      state.caret = caret;
      return collect(tracker.caret(state.text, caret));
    },
    /** Moves to just after the first occurrence of `marker`. */
    moveAfter(marker) {
      const at = state.text.indexOf(marker);
      assert.ok(at >= 0, `"${marker}" is in the text`);
      return state.moveTo(at + marker.length);
    },
    idle() { return collect(tracker.idle(state.text, state.caret)); },
    leave() { return collect(tracker.leave(state.text)); },
    /** Something other than the person changed the text (a site, Caret itself). */
    replaceText(text) { state.text = text; return state; },
  });
  return state;
}

const FIVE = [
  'The quick brown fox jumps.',
  'It was a sunny day.',
  'We went to the park.',
  'Everyone had fun there.',
  'Then we all went home.',
];
const PARAGRAPH = FIVE.join(' ');

// ================================================================ segments

test('splits plain sentences, with offsets that slice the original exactly', () => {
  const text = 'One two three. Four five six! Seven eight nine?';
  const found = plain(segments(text));
  assert.deepEqual(found, [
    { start: 0, end: 14, text: 'One two three.', complete: true },
    { start: 15, end: 29, text: 'Four five six!', complete: true },
    { start: 30, end: 47, text: 'Seven eight nine?', complete: true },
  ]);
});

test('segments are exactly {start, end, text, complete}', () => {
  for (const segment of segments('Hello there. Dear Sam,\n- One more line')) {
    assert.deepEqual(Object.keys(segment).sort(), ['complete', 'end', 'start', 'text']);
  }
});

test('the text of every segment is the original sliced at its offsets', () => {
  const text = '  - Buy milk.\r\nDear Sam,\n\n\t\u00a0Mr. Smith came. Wait... Then "Stop!" he said.) Ok?!\n1. Item one. Item two';
  for (const segment of segments(text)) {
    assert.equal(segment.text, text.slice(segment.start, segment.end));
    assert.equal(segment.text, segment.text.trim(), 'no leading or trailing space');
    assert.ok(segment.text.length > 0);
  }
});

test('nothing at all in empty or blank text', () => {
  assert.deepEqual(plain(segments('')), []);
  assert.deepEqual(plain(segments('   \n\n\t  \r\n')), []);
  assert.deepEqual(plain(segments(null)), []);
  assert.deepEqual(plain(segments(undefined)), []);
});

test('runs of stops end a sentence: ?! !! ?? ... and ‽', () => {
  assert.deepEqual(texts('Really?! Yes. No!! Why?? Huh‽ Ok.'),
    ['Really?!', 'Yes.', 'No!!', 'Why??', 'Huh‽', 'Ok.']);
  assert.deepEqual(texts('What?!. Then more.'), ['What?!.', 'Then more.']);
});

test('closing quotes and brackets stay with the sentence they close', () => {
  assert.deepEqual(texts('He said "Stop." Then he left.'), ['He said "Stop."', 'Then he left.']);
  assert.deepEqual(texts('He said “Stop.” Then he left.'), ['He said “Stop.”', 'Then he left.']);
  assert.deepEqual(texts("She asked 'why?' Then she left."), ["She asked 'why?'", 'Then she left.']);
  assert.deepEqual(texts('It ended ‘badly.’ Next one.'), ['It ended ‘badly.’', 'Next one.']);
  assert.deepEqual(texts('(See above.) Next one.'), ['(See above.)', 'Next one.']);
  assert.deepEqual(texts('[Citation needed.] Next one.'), ['[Citation needed.]', 'Next one.']);
  assert.deepEqual(texts('Il a dit «Non!» Et puis.'), ['Il a dit «Non!»', 'Et puis.']);
  assert.deepEqual(texts('He said "Really?". Then left.'), ['He said "Really?".', 'Then left.']);
  assert.deepEqual(texts('Done.") Next.'), ['Done.")', 'Next.']);
});

test('a stop with no space after it is never a sentence end', () => {
  assert.deepEqual(texts('It costs 3.5 dollars today.'), ['It costs 3.5 dollars today.']);
  assert.deepEqual(texts('Visit example.com for more.'), ['Visit example.com for more.']);
  assert.deepEqual(texts('Mail tim@school.org with it.'), ['Mail tim@school.org with it.']);
  assert.deepEqual(texts('Open file.txt and read it.'), ['Open file.txt and read it.']);
  assert.deepEqual(texts('Odd things like a.m.x happen.'), ['Odd things like a.m.x happen.']);
  assert.deepEqual(texts('See https://a.com/b?c=1!d now.'), ['See https://a.com/b?c=1!d now.']);
  assert.deepEqual(texts('It ended.Then more'), ['It ended.Then more']);
  assert.equal(segments('It ended.Then more')[0].complete, false);
});

test('a web address, a file or a number at the end of a sentence still ends it', () => {
  assert.deepEqual(texts('Visit example.com. Then go.'), ['Visit example.com.', 'Then go.']);
  assert.deepEqual(texts('Open notes.txt. Then close it.'), ['Open notes.txt.', 'Then close it.']);
  assert.deepEqual(texts('Mail me at hi@a.co. Then wait.'), ['Mail me at hi@a.co.', 'Then wait.']);
  assert.deepEqual(texts('It costs $5. Then more.'), ['It costs $5.', 'Then more.']);
  assert.deepEqual(texts('Count to 3. Then stop.'), ['Count to 3.', 'Then stop.']);
  assert.deepEqual(texts('It happened in 2020. What a year.'), ['It happened in 2020.', 'What a year.']);
});

test('known abbreviations do not end a sentence', () => {
  assert.deepEqual(texts('Mr. Smith came by today.'), ['Mr. Smith came by today.']);
  assert.deepEqual(texts('Dr. Who is here. Mrs. Jones left.'), ['Dr. Who is here.', 'Mrs. Jones left.']);
  assert.deepEqual(texts('Take Elm Ave. to the end.'), ['Take Elm Ave. to the end.']);
  assert.deepEqual(texts('Acme Inc. makes it. We buy it.'), ['Acme Inc. makes it.', 'We buy it.']);
  assert.deepEqual(texts('It weighs 3 lbs. or so.'), ['It weighs 3 lbs. or so.']);
  assert.deepEqual(texts('See Fig. 3 and Vol. 2 now.'), ['See Fig. 3 and Vol. 2 now.']);
  assert.deepEqual(texts('Smith vs. Jones was a case.'), ['Smith vs. Jones was a case.']);
  assert.deepEqual(texts('Smith et al. found it.'), ['Smith et al. found it.']);
  assert.deepEqual(texts('Meet on Jan. 5 at noon.'), ['Meet on Jan. 5 at noon.']);
  assert.deepEqual(texts('Room No. 5 is free.'), ['Room No. 5 is free.']);
  assert.deepEqual(texts('Gen. Patton and Lt. Dan met Sgt. Pepper.'), ['Gen. Patton and Lt. Dan met Sgt. Pepper.']);
  assert.deepEqual(texts('He lives on St. Mark St. near here.'), ['He lives on St. Mark St. near here.']);
});

test('abbreviations are recognised whatever their case', () => {
  assert.deepEqual(texts('MR. SMITH CAME BY.'), ['MR. SMITH CAME BY.']);
  assert.deepEqual(texts('mr. smith came by.'), ['mr. smith came by.']);
  assert.deepEqual(texts('Ask Prof. Lee or DR. Kay.'), ['Ask Prof. Lee or DR. Kay.']);
});

test('dotted abbreviations do not end a sentence: e.g. i.e. U.S. Ph.D.', () => {
  assert.deepEqual(texts('I like fruit, e.g. apples.'), ['I like fruit, e.g. apples.']);
  assert.deepEqual(texts('Bring snacks, i.e. fruit. Then go.'), ['Bring snacks, i.e. fruit.', 'Then go.']);
  assert.deepEqual(texts('He lives in the U.S. now.'), ['He lives in the U.S. now.']);
  assert.deepEqual(texts('She has a Ph.D. in maths.'), ['She has a Ph.D. in maths.']);
  assert.deepEqual(texts('Meet at 5 p.m. tomorrow.'), ['Meet at 5 p.m. tomorrow.']);
  assert.deepEqual(texts('Read J.R.R. Tolkien first.'), ['Read J.R.R. Tolkien first.']);
});

test('"etc." and a.m./p.m. do end a sentence before a capital', () => {
  assert.deepEqual(texts('We bought apples, pears, etc. Then we left.'),
    ['We bought apples, pears, etc.', 'Then we left.']);
  assert.deepEqual(texts('We bought apples, pears, etc. and more.'),
    ['We bought apples, pears, etc. and more.']);
  assert.deepEqual(texts('Apples, pears, etc. "Then" we left.'), ['Apples, pears, etc.', '"Then" we left.']);
  assert.deepEqual(texts('We met at 9 a.m. Then we left.'), ['We met at 9 a.m.', 'Then we left.']);
  assert.deepEqual(texts('We met at 9 P.M. Then we left.'), ['We met at 9 P.M.', 'Then we left.']);
  assert.deepEqual(texts('We met at 9 am. Then we left.'), ['We met at 9 am.', 'Then we left.']);
  assert.deepEqual(texts('We met at 9 am. sharp, then left.'), ['We met at 9 am. sharp, then left.']);
});

test('abbreviations that are also everyday words are the word in small letters', () => {
  // "sat", "sun", "fig" are on the list as Saturday, Sunday, figure.
  assert.deepEqual(shape('The cat sat.'), [['The cat sat.', true]]);
  assert.deepEqual(texts('We sat in the sun. then it rained.'), ['We sat in the sun.', 'then it rained.']);
  assert.deepEqual(texts('I ate a fig. It was sweet.'), ['I ate a fig.', 'It was sweet.']);
  assert.deepEqual(texts('Wait a sec. I am coming.'), ['Wait a sec.', 'I am coming.']);
  // ...but with a capital of their own, they are still abbreviations.
  assert.deepEqual(texts('Open Sun. Mar. 3 only.'), ['Open Sun. Mar. 3 only.']);
  assert.deepEqual(shape('We open on Sat.'), [['We open on Sat.', false]]);
});

test('"am" is the verb unless a number comes before it', () => {
  assert.deepEqual(shape('Yes, I am.'), [['Yes, I am.', true]]);
  assert.deepEqual(texts('Yes, I am. are you?'), ['Yes, I am.', 'are you?']);
  assert.deepEqual(shape('We met at 9 am.'), [['We met at 9 am.', false]]);
  assert.deepEqual(texts('We met at 9am. sharp.'), ['We met at 9am. sharp.']);
});

test('"No." and units end a sentence before a capital, not before a number', () => {
  assert.deepEqual(texts('No. I will not go.'), ['No.', 'I will not go.']);
  assert.deepEqual(texts('Book room No. 5 for us.'), ['Book room No. 5 for us.']);
  assert.deepEqual(texts('It took 3 hrs. Then we ate.'), ['It took 3 hrs.', 'Then we ate.']);
  assert.deepEqual(texts('Add 5 lbs. of flour.'), ['Add 5 lbs. of flour.']);
});

test('a single-letter initial does not end a sentence, but "I" does', () => {
  assert.deepEqual(texts('J. K. Rowling wrote it.'), ['J. K. Rowling wrote it.']);
  assert.deepEqual(texts('Ask John F. Kennedy about it.'), ['Ask John F. Kennedy about it.']);
  assert.deepEqual(texts('So do I. Then we left.'), ['So do I.', 'Then we left.']);
  assert.deepEqual(texts('so do i. then we left.'), ['so do i.', 'then we left.']);
  // A word with an apostrophe is not an initial, nor is a letter after a number.
  assert.deepEqual(texts("I really don't. Then we left."), ["I really don't.", 'Then we left.']);
  assert.deepEqual(texts('We saw it in 3D. Then we left.'), ['We saw it in 3D.', 'Then we left.']);
});

test('an ellipsis ends a sentence only before a capital', () => {
  assert.deepEqual(texts('Wait... then it rained.'), ['Wait... then it rained.']);
  assert.deepEqual(texts('Wait... Then it rained.'), ['Wait...', 'Then it rained.']);
  assert.deepEqual(texts('Wait.. Then it rained.'), ['Wait..', 'Then it rained.']);
  assert.deepEqual(texts('Wait… Then it rained.'), ['Wait…', 'Then it rained.']);
  assert.deepEqual(texts('Wait… then it rained.'), ['Wait… then it rained.']);
  assert.deepEqual(texts('Wait... "Then" it rained.'), ['Wait...', '"Then" it rained.']);
  assert.deepEqual(texts('Wait... 5 more minutes.'), ['Wait... 5 more minutes.']);
  assert.deepEqual(texts('...and then it rained.'), ['...and then it rained.']);
  // At the very end of the text, they may still be typing the next word.
  assert.deepEqual(shape('I wonder...'), [['I wonder...', false]]);
  assert.deepEqual(shape('I wonder... '), [['I wonder...', false]]);
});

test('a line break always ends a segment; an unfinished line is incomplete', () => {
  assert.deepEqual(shape('Dear Sam,\nThanks for the note.'),
    [['Dear Sam,', false], ['Thanks for the note.', true]]);
  assert.deepEqual(shape('Shopping list\nMilk and eggs'), [['Shopping list', false], ['Milk and eggs', false]]);
  assert.deepEqual(shape('One sentence\ncarries on here.'), [['One sentence', false], ['carries on here.', true]]);
});

test('the capital that finishes "etc." or an ellipsis can be on the next line', () => {
  assert.deepEqual(shape('I wonder...\nNext one.'), [['I wonder...', true], ['Next one.', true]]);
  assert.deepEqual(shape('Pears, etc.\n\n    Then we left.'), [['Pears, etc.', true], ['Then we left.', true]]);
  assert.deepEqual(shape('I wonder...\nnext one.'), [['I wonder...', false], ['next one.', true]]);
  // A line break on its own does not finish one: a rich editor reports a line
  // break after the line still being typed.
  assert.deepEqual(shape('I met Mr.\n'), [['I met Mr.', false]]);
  assert.deepEqual(shape('I wonder... \n'), [['I wonder...', false]]);
  assert.deepEqual(shape('I work at Acme Inc.  \nNext line.'), [['I work at Acme Inc.', false], ['Next line.', true]]);
  assert.deepEqual(shape('We went home.\n'), [['We went home.', true]]);
});

test('CRLF, lone CR and Unicode line separators all break lines', () => {
  const text = 'Dear Sam,\r\nThanks for the note.\r\n\r\nSee you soon.';
  const found = plain(segments(text));
  assert.deepEqual(found.map((s) => s.text), ['Dear Sam,', 'Thanks for the note.', 'See you soon.']);
  for (const s of found) assert.equal(text.slice(s.start, s.end), s.text);
  assert.deepEqual(texts('One here\rTwo here'), ['One here', 'Two here']);
  assert.deepEqual(texts('One here\u2028Two here\u2029Three'), ['One here', 'Two here', 'Three']);
});

test('empty lines produce nothing', () => {
  assert.deepEqual(texts('One.\n\n\n\nTwo.'), ['One.', 'Two.']);
  assert.deepEqual(texts('\n\nOne.\n\n'), ['One.']);
});

test('indentation is not part of the sentence', () => {
  const text = 'First one here. Second one here.\n\n    Next paragraph starts here. And goes on.';
  const found = plain(segments(text));
  assert.deepEqual(found.map((s) => s.text),
    ['First one here.', 'Second one here.', 'Next paragraph starts here.', 'And goes on.']);
  assert.equal(found[2].start, text.indexOf('Next'));
  assert.deepEqual(texts('\tTabbed in. Again.'), ['Tabbed in.', 'Again.']);
  assert.deepEqual(texts('\u00a0\u00a0\u2003Odd spaces. Again.'), ['Odd spaces.', 'Again.']);
  assert.equal(segments('\u00a0\u00a0Odd spaces.')[0].start, 2);
});

test('several spaces between sentences', () => {
  const text = 'One two three.    Four five six.\t\tSeven eight.\u00a0Nine ten.';
  assert.deepEqual(texts(text), ['One two three.', 'Four five six.', 'Seven eight.', 'Nine ten.']);
});

test('list markers at the start of a line are not part of the sentence', () => {
  const cases = {
    '- Buy milk today.': 'Buy milk today.',
    '* Buy milk today.': 'Buy milk today.',
    '+ Buy milk today.': 'Buy milk today.',
    '• Buy milk today.': 'Buy milk today.',
    '◦ Buy milk today.': 'Buy milk today.',
    '– Buy milk today.': 'Buy milk today.',
    '— Buy milk today.': 'Buy milk today.',
    '•Buy milk today.': 'Buy milk today.',
    '1. Buy milk today.': 'Buy milk today.',
    '12. Buy milk today.': 'Buy milk today.',
    '1) Buy milk today.': 'Buy milk today.',
    '1.2. Buy milk today.': 'Buy milk today.',
    'a. Buy milk today.': 'Buy milk today.',
    'a) Buy milk today.': 'Buy milk today.',
    'B) Buy milk today.': 'Buy milk today.',
    '(1) Buy milk today.': 'Buy milk today.',
    '(a) Buy milk today.': 'Buy milk today.',
    '(iv) Buy milk today.': 'Buy milk today.',
    'iv. Buy milk today.': 'Buy milk today.',
    'xii) Buy milk today.': 'Buy milk today.',
    'IV. Buy milk today.': 'Buy milk today.',
    '  - Buy milk today.': 'Buy milk today.',
    '\t3. Buy milk today.': 'Buy milk today.',
    '- [ ] Buy milk today.': 'Buy milk today.',
    '- [x] Buy milk today.': 'Buy milk today.',
    '> Buy milk today.': 'Buy milk today.',
    '> > Buy milk today.': 'Buy milk today.',
  };
  for (const [line, sentence] of Object.entries(cases)) {
    const found = plain(segments(line));
    assert.equal(found.length, 1, line);
    assert.equal(found[0].text, sentence, line);
    assert.equal(found[0].start, line.indexOf('Buy'), line);
    assert.equal(found[0].complete, true, line);
  }
});

test('list markers only count at the start of a line', () => {
  assert.deepEqual(texts('Do this - then that.'), ['Do this - then that.']);
  assert.deepEqual(texts('Count to 1. Then stop.'), ['Count to 1.', 'Then stop.']);
  assert.deepEqual(texts('One here.\n2. Two here.\n- Three here.'), ['One here.', 'Two here.', 'Three here.']);
});

test('a question or exclamation mark inside quotes: the next word decides', () => {
  assert.deepEqual(shape('"Are you coming with us today?" she asked.'),
    [['"Are you coming with us today?" she asked.', true]]);
  assert.deepEqual(shape('Did you hear him yell "Watch out!" at me?'),
    [['Did you hear him yell "Watch out!" at me?', true]]);
  assert.deepEqual(texts('The question "What is love?" is hard to answer.'),
    ['The question "What is love?" is hard to answer.']);
  assert.deepEqual(texts('He was (really!) tired that day.'), ['He was (really!) tired that day.']);
  assert.deepEqual(texts('"Are you coming?" She asked me twice.'), ['"Are you coming?"', 'She asked me twice.']);
  assert.deepEqual(texts('He shouted "Stop!"\nThen we ran.'), ['He shouted "Stop!"', 'Then we ran.']);
  // At the very end of the text they may still be typing "...he said."
  assert.deepEqual(shape('He shouted "Stop!"'), [['He shouted "Stop!"', false]]);
  assert.deepEqual(shape('He shouted "Stop!" '), [['He shouted "Stop!"', false]]);
  // Without a quote or bracket after it, a question mark still ends one at once.
  assert.deepEqual(shape('Did you go? yes I did.'), [['Did you go?', true], ['yes I did.', true]]);
  assert.deepEqual(shape('Did you go?'), [['Did you go?', true]]);
});

test('things that look like list markers but are not', () => {
  assert.deepEqual(texts('3.5 kg of flour is enough.'), ['3.5 kg of flour is enough.']);
  assert.deepEqual(texts('-5 degrees is cold.'), ['-5 degrees is cold.']);
  assert.deepEqual(texts('*Bold* text is here.'), ['*Bold* text is here.']);
  assert.deepEqual(texts('Mix. Stir. Bake.'), ['Mix.', 'Stir.', 'Bake.']);
  // An initial at the start of a line is a name, not a list.
  assert.deepEqual(texts('J. K. Rowling wrote it.'), ['J. K. Rowling wrote it.']);
});

test('a line that is only a list marker is not a segment', () => {
  assert.deepEqual(texts('- \n1.\n* \n(a)\nReal one.'), ['Real one.']);
});

// =============================================================== segmentAt

test('segmentAt: start and end are both inside', () => {
  const text = 'One two three. Four five six.';
  assert.equal(segmentAt(text, 0).text, 'One two three.');
  assert.equal(segmentAt(text, 14).text, 'One two three.');
  assert.equal(segmentAt(text, 15).text, 'Four five six.');
  assert.equal(segmentAt(text, text.length).text, 'Four five six.');
  assert.equal(segmentAt(text, 7).start, 0);
});

test('segmentAt: the space between sentences belongs to none', () => {
  assert.equal(segmentAt('One.  Two.', 5), null);
  assert.equal(segmentAt('One. Two.', 4).text, 'One.');
  assert.equal(segmentAt('One. Two.', 5).text, 'Two.');
});

test('segmentAt: indentation, list markers, empty lines and trailing space belong to none', () => {
  const text = 'Dear Sam,\n\n    - Next one here.   ';
  assert.equal(segmentAt(text, 10), null);                       // empty line
  assert.equal(segmentAt(text, 12), null);                       // indentation
  assert.equal(segmentAt(text, text.indexOf('-') + 1), null);    // the marker
  assert.equal(segmentAt(text, text.indexOf('Next')).text, 'Next one here.');
  assert.equal(segmentAt(text, text.length), null);              // trailing spaces
});

test('segmentAt: an offset on a line break belongs to the line it ends', () => {
  const text = 'Dear Sam,\nThanks.';
  assert.equal(segmentAt(text, 9).text, 'Dear Sam,');
  assert.equal(segmentAt(text, 10).text, 'Thanks.');
  const crlf = 'Hi there\r\nBye now.';
  assert.equal(segmentAt(crlf, 8).text, 'Hi there');
  assert.equal(segmentAt(crlf, 9), null);
  assert.equal(segmentAt(crlf, 10).text, 'Bye now.');
});

test('segmentAt: outside the text, or not an offset at all', () => {
  assert.equal(segmentAt('Hello.', -1), null);
  assert.equal(segmentAt('Hello.', 7), null);
  assert.equal(segmentAt('Hello.', 1.5), null);
  assert.equal(segmentAt('Hello.', NaN), null);
  assert.equal(segmentAt('', 0), null);
  assert.equal(segmentAt(null, 0), null);
});

test('segmentAt agrees with segments everywhere', () => {
  const text = '  - Buy milk.\nDear Sam,\n\n\tMr. Smith came. Wait... Then "Stop!" he said. Ok?!\n1. Item one. Item two';
  const all = segments(text);
  for (let offset = 0; offset <= text.length; offset += 1) {
    const expected = all.find((s) => s.start <= offset && offset <= s.end) || null;
    assert.deepEqual(plain(segmentAt(text, offset)), plain(expected), `offset ${offset}`);
  }
});

// ============================================================= isCheckable

test('isCheckable: a finished sentence of three words or more', () => {
  assert.equal(isCheckable(segmentAt('The cat sat.', 0)), true);
  assert.equal(isCheckable(segmentAt('The cat.', 0)), false);
  assert.equal(isCheckable(segmentAt('The cat sat', 0)), false);           // not finished
  assert.equal(isCheckable({ text: 'The cat sat.', complete: true, start: 0, end: 12 }), true);
  assert.equal(isCheckable({ text: 'The cat sat.', complete: false, start: 0, end: 12 }), false);
});

test('isCheckable: words are only words if they have letters', () => {
  assert.equal(isCheckable(segmentAt('It is 3.', 0)), false);
  assert.equal(isCheckable(segmentAt('We have 3 cats.', 0)), true);
  assert.equal(isCheckable(segmentAt('1 2 3 4 5 a.', 0)), false);
});

test('isCheckable: not too long', () => {
  const long = `${'word '.repeat(120)}end.`;
  assert.ok(long.length > 600);
  assert.equal(isCheckable(segmentAt(long, 0)), false);
  const fits = `${'word '.repeat(110)}end.`;
  assert.ok(fits.length <= 600);
  assert.equal(isCheckable(segmentAt(fits, 0)), true);
});

test('isCheckable: phone numbers, links and code are skipped', () => {
  assert.equal(isCheckable(segmentAt('Call 555-123-4567 or 555-765-4321 now.', 0)), false);
  assert.equal(isCheckable(segmentAt('x = 1; y = 2; z = 3.', 0)), false);
  assert.equal(isCheckable(segmentAt('See 2024-01-01 12:00:00 UTC log.', 0)), false);
  assert.equal(isCheckable(segmentAt('Visit https://example.com for the details.', 0)), true);
});

test('isCheckable: nothing, or not a segment', () => {
  assert.equal(isCheckable(null), false);
  assert.equal(isCheckable(undefined), false);
  assert.equal(isCheckable({}), false);
});

// ========================================================= tracker: typing

test('typing a five-sentence paragraph checks five sentences, in order', () => {
  const f = field().type(PARAGRAPH);
  assert.deepEqual(f.due, FIVE.slice(0, 4), 'each one as the space after it is typed');
  f.idle();
  assert.deepEqual(f.due, FIVE, 'the last one once they stop');
  f.idle().leave();
  assert.deepEqual(f.due, FIVE, 'and never twice');
});

test('the last sentence goes when they leave the field instead', () => {
  const f = field().type(PARAGRAPH).leave();
  assert.deepEqual(f.due, FIVE);
});

test('the last sentence goes when they move on to another one', () => {
  const f = field().type(PARAGRAPH).moveTo(3);
  assert.deepEqual(f.due, FIVE);
});

test('each sentence is due at the moment the space after it is typed', () => {
  const f = field().type('We went to the park.');
  assert.deepEqual(f.due, []);
  f.type(' ');
  assert.deepEqual(f.due, ['We went to the park.']);
});

test('?! and closing quotes are waited for before the sentence goes', () => {
  const f = field().type('Did you really say that?! ');
  assert.deepEqual(f.due, ['Did you really say that?!']);
  const g = field().type('He said "stop it now." ');
  assert.deepEqual(g.due, ['He said "stop it now."']);
});

test('a quoted "!" or "?" in the middle of a sentence does not send half of it', () => {
  const f = field().type('Did you hear him yell "Watch out!" at me? ');
  assert.deepEqual(f.due, ['Did you hear him yell "Watch out!" at me?']);
  const g = field().type('"Are you coming with us today?" she asked. ');
  assert.deepEqual(g.due, ['"Are you coming with us today?" she asked.']);
});

test('a quoted "!" or "?" before a capital ends the sentence as you type', () => {
  const f = field().type('He shouted "Stop the bus now!" ');
  assert.deepEqual(f.due, [], 'not yet: "he said" may follow');
  f.type('Then we ran.').idle();
  assert.deepEqual(f.due, ['He shouted "Stop the bus now!"', 'Then we ran.']);
});

test('a quoted "!" at the end of the field goes when they leave, not when they pause', () => {
  const f = field().type('He shouted "Stop the bus now!"').idle();
  assert.deepEqual(f.due, []);
  f.leave();
  assert.deepEqual(f.due, ['He shouted "Stop the bus now!"']);
});

test('a paragraph, then a new indented paragraph', () => {
  const f = field()
    .type('First one is here. Second one is here.')
    .type('\n\n    Next paragraph starts here. And goes on now.');
  assert.deepEqual(f.due, ['First one is here.', 'Second one is here.', 'Next paragraph starts here.']);
  f.leave();
  assert.deepEqual(f.due.at(-1), 'And goes on now.');
  assert.equal(f.due.length, 4);
});

test('several spaces between sentences: still once each', () => {
  const f = field().type('One two three.   Four five six.  Seven eight nine.').idle();
  assert.deepEqual(f.due, ['One two three.', 'Four five six.', 'Seven eight nine.']);
});

test('an abbreviation in the middle is one sentence', () => {
  const f = field().type('Mr. Smith came by today. ');
  assert.deepEqual(f.due, ['Mr. Smith came by today.']);
  const g = field().type('Take Elm Ave. to the end. We met Dr. Who there. ');
  assert.deepEqual(g.due, ['Take Elm Ave. to the end.', 'We met Dr. Who there.']);
});

test('initials and e.g. are one sentence; "I." ends one', () => {
  const f = field().type('J. K. Rowling wrote it. Bring fruit, e.g. apples. So do I. Then we went home.').idle();
  assert.deepEqual(f.due,
    ['J. K. Rowling wrote it.', 'Bring fruit, e.g. apples.', 'So do I.', 'Then we went home.']);
});

test('everyday words that are also abbreviations end a sentence as you type', () => {
  const f = field().type('The cat just sat. Yes, I am. ');
  assert.deepEqual(f.due, ['The cat just sat.', 'Yes, I am.']);
});

test('"No." mid-sentence waits for the next word', () => {
  const f = field().type('Please book room No. ');
  assert.deepEqual(f.due, []);
  f.type('5 for us. ');
  assert.deepEqual(f.due, ['Please book room No. 5 for us.']);
});

test('"etc." followed by a capital is two sentences, decided by the next word', () => {
  const f = field().type('We bought apples, pears, etc. ');
  assert.deepEqual(f.due, [], 'not yet: "etc. and more" would carry on');
  f.type('Then we left the shop.');
  assert.deepEqual(f.due, ['We bought apples, pears, etc.']);
  f.idle();
  assert.deepEqual(f.due, ['We bought apples, pears, etc.', 'Then we left the shop.']);
});

test('"etc." followed by a small letter carries on', () => {
  const f = field().type('We bought apples, pears, etc. and more. ');
  assert.deepEqual(f.due, ['We bought apples, pears, etc. and more.']);
});

test('an ellipsis: one sentence before a small letter, two before a capital', () => {
  const f = field().type('I waited for a while... then it rained hard. ');
  assert.deepEqual(f.due, ['I waited for a while... then it rained hard.']);
  const g = field().type('I waited for a while... Then it rained hard. ');
  assert.deepEqual(g.due, ['I waited for a while...', 'Then it rained hard.']);
});

test('an ellipsis at the end of a line goes when they press Enter', () => {
  const f = field().type('I was not sure what to say...\n');
  assert.deepEqual(f.due, ['I was not sure what to say...']);
});

test('"Inc." at the end of a line goes when they move to another line', () => {
  const f = field('Dear Sam,\n').type('I now work at Acme Inc.');
  f.moveTo(2);
  assert.deepEqual(f.due, ['I now work at Acme Inc.']);
});

test('moving elsewhere on the same line does not finish "Inc." or "..."', () => {
  const f = field('We went home. ').type('I now work at Acme Inc.');
  f.moveTo(3);
  assert.deepEqual(f.due, []);
});

test('a rich editor that always reports a line break at the end', () => {
  // <div>...</div> and a trailing <br> both read as "\n" after the text.
  const f = field('\n');
  f.caret = 0;
  f.type('I met Mr. Smith today. I waited a while... then it rained. We bought pears, etc. and more. ');
  assert.deepEqual(f.due,
    ['I met Mr. Smith today.', 'I waited a while... then it rained.', 'We bought pears, etc. and more.']);
  f.type('Wait for it...').idle();
  assert.equal(f.due.length, 3, 'not finished while they are still on the line');
  f.leave();
  assert.equal(f.due.at(-1), 'Wait for it...');
});

test('a rich editor: Enter after "..." opens a new block, and the line is done', () => {
  const f = field('\n');
  f.caret = 0;
  f.type('I was not sure what to say...').type('\n');
  assert.equal(f.text, 'I was not sure what to say...\n\n');
  assert.deepEqual(f.due, ['I was not sure what to say...']);
});

test('an unfinished line is not checked when they press Enter', () => {
  const f = field().type('Dear Sam and Jo,\n\nThanks for the lovely note.\n');
  assert.deepEqual(f.due, ['Thanks for the lovely note.']);
});

test('a number with a decimal point is not a sentence end mid-typing', () => {
  const f = field().type('It weighs about 3.5 kilos now. ');
  assert.deepEqual(f.due, ['It weighs about 3.5 kilos now.']);
});

test('the same sentence typed twice is checked once', () => {
  const f = field().type('Thank you very much. Thank you very much. ');
  assert.deepEqual(f.due, ['Thank you very much.']);
});

test('short sentences are not worth a check', () => {
  const f = field().type('Hi. Ok then. Yes! ').leave();
  assert.deepEqual(f.due, []);
});

test('IME composition text counts as typing', () => {
  const tracker = createTracker('');
  let due = tracker.input('The cat sat down.', 17, 'insertCompositionText');
  assert.deepEqual(plain(due), []);
  due = tracker.input('The cat sat down. ', 18, 'insertText');
  assert.deepEqual(plain(due), ['The cat sat down.']);
});

// ============================================================ tracker: idle

test('idle at the end of a finished sentence sends it', () => {
  const f = field().type('We went to the park').idle();
  assert.deepEqual(f.due, [], 'not finished');
  f.type('.').idle();
  assert.deepEqual(f.due, ['We went to the park.']);
  f.type(' ');
  assert.deepEqual(f.due, ['We went to the park.'], 'not again when they carry on');
});

test('idle in the middle of a sentence sends nothing', () => {
  const f = field().type('We went to the park.');
  f.moveTo(5).idle();
  assert.deepEqual(f.due, []);
});

test('idle with a quote still open waits for it to close', () => {
  const f = field().type('He said "stop it now.').idle();
  assert.deepEqual(f.due, []);
  f.type('"').idle();
  assert.deepEqual(f.due, ['He said "stop it now."']);
});

test('idle after "etc." or an initial at the end waits for the next word', () => {
  const f = field().type('We bought apples, pears, etc.').idle();
  assert.deepEqual(f.due, []);
  const g = field().type('The book was by J.').idle();
  assert.deepEqual(g.due, []);
});

test('idle in the middle of a line, after a sentence being revised, sends nothing yet', () => {
  const start = 'The quick brown fox jumps. It was a sunny day. We went to the park. Everyone had fun there.';
  const f = field(start);
  f.moveAfter('a sunny day.').backspace(4).type('morning.');
  f.idle();
  assert.deepEqual(f.due, [], 'the caret is after its full stop, but more of the line follows');
  f.backspace(1).type(' in May.').idle();
  assert.deepEqual(f.due, []);
  f.moveAfter('Everyone');
  assert.deepEqual(f.due, ['It was a sunny morning in May.'], 'once, when they move on');
});

test('a new sentence typed in the middle of a paragraph goes when they move on', () => {
  const f = field('We went out. We came back.');
  f.moveAfter('We went out.').type(' It was cold outside.').idle();
  assert.deepEqual(f.due, []);
  f.leave();
  assert.deepEqual(f.due, ['It was cold outside.']);
});

test('idle at the end of a line still sends, with or without lines after it', () => {
  const f = field('\n\nThe next paragraph is here.');
  f.caret = 0;
  f.type('We went to the park.').idle();
  assert.deepEqual(f.due, ['We went to the park.']);
  const g = field('\n');                  // a rich editor's trailing line break
  g.caret = 0;
  g.type('We went to the park.');
  assert.deepEqual(g.due, []);
  g.idle();
  assert.deepEqual(g.due, ['We went to the park.']);
  const h = field('We went out.  \nWe came back.');   // spaces left at the end of the line
  h.moveAfter('We went out.').backspace(1).type('!').idle();
  assert.deepEqual(h.due, ['We went out!']);
});

test('an edited sentence they paused in, then carried on with, is sent once it is finished', () => {
  const f = field().type('We went to the park.').idle();
  assert.deepEqual(f.due, ['We went to the park.']);
  // They come back and add to it before moving on.
  f.backspace(1).type(' with Sam.').type(' ');
  assert.deepEqual(f.due, ['We went to the park.', 'We went to the park with Sam.']);
});

// =========================================================== tracker: leave

test('leave sends the sentence being edited, once', () => {
  const f = field().type('We went to the park.').leave().leave();
  assert.deepEqual(f.due, ['We went to the park.']);
});

test('leave does not send an unfinished sentence', () => {
  const f = field().type('We went to the park').leave();
  assert.deepEqual(f.due, []);
});

test('leave: "..." or "Inc." at the very end counts as finished', () => {
  const f = field().type('I am not really sure...').leave();
  assert.deepEqual(f.due, ['I am not really sure...']);
  const g = field().type('I work at Acme Inc. ').leave();
  assert.deepEqual(g.due, ['I work at Acme Inc.']);
});

test('a sentence only the end of its line can finish, left for elsewhere on that line, goes on leave', () => {
  const endings = [
    'I now work at Acme Inc.',
    'I was not sure what to say...',
    'In the end the answer was no.',
    'My family moved to the U.S.',
    'We met them at 9 am.',
    'We bought apples, pears, etc.',
    'He shouted "Stop the bus now!"',
  ];
  for (const last of endings) {
    const f = field().type(`We went home after school. ${last}`);
    f.moveTo(5).idle();
    assert.deepEqual(f.due, ['We went home after school.'], `${last}: not while the line is open`);
    f.moveTo(f.text.length).idle().moveTo(8);
    f.leave();
    assert.deepEqual(f.due, ['We went home after school.', last], last);
    f.moveTo(3).leave();
    assert.deepEqual(f.due, ['We went home after school.', last], `${last}: and only once`);
  }
});

test('a pending sentence finished by a capital is sent on leave, once', () => {
  const f = field().type('We went home after school. We bought apples, pears, etc.');
  f.moveTo(5);
  f.moveTo(f.text.length).type(' Then we left the shop.');
  assert.deepEqual(f.due, ['We went home after school.']);
  f.leave();
  assert.deepEqual(f.due,
    ['We went home after school.', 'Then we left the shop.', 'We bought apples, pears, etc.']);
});

test('a pending sentence that is changed is sent as it now reads, not as it was', () => {
  const f = field().type('We went home after school. I now work at Acme Inc.');
  f.moveTo(5);
  f.moveAfter('Acme Inc.').type(' in town.');
  f.leave();
  assert.deepEqual(f.due, ['We went home after school.', 'I now work at Acme Inc. in town.']);
  const g = field().type('We went home after school. I now work at Acme Inc.');
  g.moveTo(5);
  g.moveAfter('Acme').backspace(4).type('Initech');
  g.moveTo(0).leave();
  assert.deepEqual(g.due, ['We went home after school.', 'I now work at Initech Inc.']);
});

test('a pending sentence that is deleted, or was pasted, is not sent', () => {
  const f = field().type('We went home after school. I now work at Acme Inc.');
  f.moveTo(5);
  f.moveTo(f.text.length).backspace('I now work at Acme Inc.'.length);
  f.leave();
  assert.deepEqual(f.due, ['We went home after school.']);
  const g = field().paste('We went home after school. I now work at Acme Inc.');
  g.moveTo(5).leave();
  assert.deepEqual(g.due, []);
});

test('leave forgets the sentence: coming back and leaving again sends nothing', () => {
  const f = field().type('We went to the park.').leave();
  f.moveTo(3).idle().leave();
  assert.deepEqual(f.due, ['We went to the park.']);
});

// ======================================================= tracker: going back

test('changing a word in sentence 2 and moving to sentence 4 sends the new sentence 2, once', () => {
  const f = field().type(PARAGRAPH).idle();
  assert.equal(f.due.length, 5);
  f.due.length = 0;
  f.moveAfter('a sunny');
  assert.deepEqual(f.due, []);
  f.backspace(5).type('rainy');
  assert.deepEqual(f.due, [], 'still in it');
  f.moveAfter('Everyone had');
  assert.deepEqual(f.due, ['It was a rainy day.']);
  f.moveTo(0).moveAfter('rainy').moveAfter('went home').idle().leave();
  assert.deepEqual(f.due, ['It was a rainy day.'], 'and not again');
});

test('changing a sentence and moving on with the arrow keys sends it', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('quick');
  f.type('est');
  f.moveTo(f.caret + 1).moveTo(f.caret + 1);
  assert.deepEqual(f.due, []);
  f.moveAfter('It was');
  assert.deepEqual(f.due, ['The quickest brown fox jumps.']);
});

test('changing a sentence, then typing in another one, sends the first', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('a sunny').backspace(5).type('rainy');
  f.moveAfter('Everyone had').type(' great');
  assert.deepEqual(f.due, ['It was a rainy day.']);
  f.leave();
  assert.deepEqual(f.due, ['It was a rainy day.', 'Everyone had great fun there.']);
});

test('changing a sentence, then typing earlier in the text, still sends the right one', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('Everyone').type(' else');
  // Without a click being reported, they start typing in sentence 1. Every
  // keystroke there pushes sentence 4 along.
  f.caret = f.text.indexOf('fox');
  f.type('red ');
  assert.deepEqual(f.due, ['Everyone else had fun there.']);
});

test('clicking around without typing sends nothing', () => {
  const f = field().type(PARAGRAPH).idle();
  f.due.length = 0;
  for (let at = 0; at <= f.text.length; at += 7) f.moveTo(at).idle();
  f.leave();
  assert.deepEqual(f.due, []);
});

test('editing a sentence and putting it back exactly as it was sends nothing', () => {
  const f = field().type(PARAGRAPH).idle();
  f.due.length = 0;
  f.moveAfter('a sunny').backspace(2).type('nx').backspace(1).type('y');
  assert.equal(f.text, PARAGRAPH);
  f.moveAfter('Everyone').leave();
  assert.deepEqual(f.due, []);
});

test('deleting the full stop: not due until it is finished again', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('went home.').backspace(1);
  f.moveAfter('Everyone');
  assert.deepEqual(f.due, [], 'unfinished');
  f.moveTo(f.text.length).idle().leave();
  assert.deepEqual(f.due, [], 'still unfinished');
  f.moveAfter('went home').type('!');
  f.moveAfter('Everyone');
  assert.deepEqual(f.due, ['Then we all went home!']);
});

test('deleting the full stop of a sentence being typed, then moving on', () => {
  const f = field().type('We went to the park.').backspace(1);
  f.type('\n');
  assert.deepEqual(f.due, []);
  f.moveAfter('the park').type('.');
  f.moveTo(f.text.length);
  assert.deepEqual(f.due, ['We went to the park.']);
});

test('deleting a full stop merges two sentences; the merged one is checked when finished', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('a sunny day.').backspace(1).type(' and');
  f.moveAfter('Everyone');
  assert.deepEqual(f.due, ['It was a sunny day and We went to the park.']);
});

test('deleting the opening word of a sentence, then moving on, sends what is left of it', () => {
  const start = 'We had a long day. So I went home early. It was late.';
  const f = field(start);
  f.moveAfter('So').backspace(2);
  assert.equal(f.text, 'We had a long day.  I went home early. It was late.');
  f.idle();
  assert.deepEqual(f.due, [], 'still there: they may type a new opening word');
  f.moveTo(0);
  assert.deepEqual(f.due, ['I went home early.']);
  f.leave();
  assert.deepEqual(f.due, ['I went home early.'], 'and only once');
});

test('deleting the opening word in one go, then leaving the field', () => {
  const f = field('We had a long day. So I went home early. It was late.');
  f.moveAfter('So').deleteBefore(2).leave();
  assert.deepEqual(f.due, ['I went home early.']);
  const g = field('We had a long day. So I went home early. It was late.');
  g.moveAfter('So').deleteBefore(2, 'deleteByCut').moveTo(0);
  assert.deepEqual(g.due, ['I went home early.']);
});

test('replacing the opening word sends only the new sentence', () => {
  const f = field('We had a long day. So I went home early. It was late.');
  f.moveAfter('So').backspace(2).type('Then');
  f.moveTo(0).leave();
  assert.deepEqual(f.due, ['Then I went home early.']);
});

test('after deleting the opening word, moving into the rest of the sentence is still being there', () => {
  const f = field('We had a long day. So I went home early. It was late.');
  f.moveAfter('So').backspace(2);
  f.moveAfter(' I went');
  assert.deepEqual(f.due, []);
  f.type(' straight');
  f.moveAfter('It was');
  assert.deepEqual(f.due, ['I went straight home early.']);
});

test('deleting a whole sentence sends nothing', () => {
  const f = field('We had a long day. So I went home early. It was late.');
  f.moveAfter('So I went home early.').backspace('So I went home early.'.length);
  f.moveTo(0).leave();
  assert.deepEqual(f.due, []);
});

test('splitting a sentence in two sends both halves, each once', () => {
  const f = field('We went to the park and then we all went home together.');
  f.moveAfter('the park').type('. Then');
  assert.deepEqual(f.due, ['We went to the park.']);
  f.backspace(4).type('After that');
  f.leave();
  assert.deepEqual(f.due, ['We went to the park.', 'After that and then we all went home together.']);
});

// =========================================================== tracker: paste

test('a pasted paragraph is not checked', () => {
  const f = field().paste(PARAGRAPH);
  assert.deepEqual(f.due, []);
  f.idle().leave();
  assert.deepEqual(f.due, []);
});

test('typing on after a paste checks only what was typed', () => {
  const f = field().paste(PARAGRAPH).type(' Then it rained on us.').idle();
  assert.deepEqual(f.due, ['Then it rained on us.']);
});

test('a pasted sentence is checked once it is edited', () => {
  const f = field().paste(PARAGRAPH);
  f.moveAfter('We went').type(' happily');
  f.moveTo(0);
  assert.deepEqual(f.due, ['We went happily to the park.']);
});

test('a paste that finishes what they were typing leaves that sentence open', () => {
  const f = field().type('I went to the ').paste('shop with my friend.');
  assert.deepEqual(f.due, []);
  f.type(' ');
  assert.deepEqual(f.due, ['I went to the shop with my friend.']);
});

test('pasting into the middle of an existing sentence counts as changing it', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('We went to the ').paste('big ');
  f.moveTo(0);
  assert.deepEqual(f.due, ['We went to the big park.']);
});

test('a dropped paragraph is treated like a pasted one', () => {
  const f = field().paste(PARAGRAPH, 'insertFromDrop').idle().leave();
  assert.deepEqual(f.due, []);
});

test('pasting after the sentence being typed moves on from it', () => {
  const f = field().type('We went to the park.').paste(' The dog barked at the cat.');
  assert.deepEqual(f.due, ['We went to the park.']);
  f.leave();
  assert.deepEqual(f.due, ['We went to the park.'], 'the pasted one is not checked');
});

test('an editor that pastes for itself, with the caret unknown after: not checked', () => {
  // The paste lands on a new line; Backspace then joins the caret to the end
  // of the pasted paragraph, which must not make it the person's sentence.
  const f = field('My essay starts here today.').type(' I quote a book below.').type('\n');
  assert.deepEqual(f.due, ['I quote a book below.']);
  f.editorPaste('The dog barked at the cat all night long. It was very loud for all of us.\n');
  f.backspace(1).idle().moveTo(3).leave();
  assert.deepEqual(f.due, ['I quote a book below.']);
});

test('an editor that pastes for itself, with the caret known: the same as a paste', () => {
  const f = field().editorPaste(PARAGRAPH, true).idle().leave();
  assert.deepEqual(f.due, []);
  const g = field().type('We went to the park.').editorPaste(' The dog barked at the cat.', true);
  assert.deepEqual(g.due, ['We went to the park.']);
  g.leave();
  assert.deepEqual(g.due, ['We went to the park.']);
});

test('a paste reported twice - by its input event, then by the paste listener - is still a paste', () => {
  const f = field().type('We went to the park. ').paste('The dog barked at the cat.');
  f.tracker.input(f.text, f.caret, 'insertFromPaste');
  f.tracker.input(f.text, null, 'insertFromPaste');
  f.idle().leave();
  assert.deepEqual(f.due, ['We went to the park.']);
});

test('an editor paste with the caret unknown that finishes what they were typing leaves it open', () => {
  const f = field().type('I went to the ').editorPaste('shop with my friend.');
  assert.deepEqual(f.due, []);
  f.type(' ');
  assert.deepEqual(f.due, ['I went to the shop with my friend.']);
});

test('an editor paste with the caret unknown into the middle of a sentence counts as changing it', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('We went to the ').editorPaste('big ');
  f.moveTo(0);
  assert.deepEqual(f.due, ['We went to the big park.']);
  const g = field().editorPaste(PARAGRAPH).type(' Then it rained on us.').idle();
  assert.deepEqual(g.due, ['Then it rained on us.']);
});

test('a pasted unfinished sentence finished by typing is checked', () => {
  const f = field().paste('The dog barked at the cat').type('.').type(' ');
  assert.deepEqual(f.due, ['The dog barked at the cat.']);
});

// ======================================================== tracker: baseline

test('text already in the field is never checked unless it is changed', () => {
  const f = field(PARAGRAPH);
  for (let at = 0; at <= f.text.length; at += 5) f.moveTo(at).idle();
  f.leave();
  assert.deepEqual(f.due, []);
});

test('typing after text that was already there checks only the new sentence', () => {
  const f = field(PARAGRAPH).type(' Then it rained on us.').idle();
  assert.deepEqual(f.due, ['Then it rained on us.']);
});

test('text a site puts in the field without typing is never checked', () => {
  const f = field('');
  f.replaceText(PARAGRAPH);
  f.moveTo(10).idle();
  f.moveTo(f.text.length).idle();
  f.leave();
  assert.deepEqual(f.due, []);
});

test('baseline sentences across paragraphs and lists stay quiet too', () => {
  const doc = 'Dear Sam,\n\nThanks for the note.\n  - We will be there at 9 a.m. sharp.\n  1. Bring the cake please.\n\nBest wishes,\nJo';
  const f = field(doc);
  for (let at = 0; at <= doc.length; at += 3) f.moveTo(at).idle();
  f.leave();
  assert.deepEqual(f.due, []);
});

// ====================================================== tracker: shift etc.

test('shift: an edit Caret makes before the sentence being edited', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('Everyone').type(' else');
  // Caret applies a long fix in sentence 1, then reports it.
  const at = f.text.indexOf('quick');
  const fix = 'very, very, very, very, very, very quick';
  f.replaceText(f.text.slice(0, at) + fix + f.text.slice(at + 'quick'.length));
  f.tracker.shift(at, fix.length - 'quick'.length);
  f.moveAfter('went home');
  assert.deepEqual(f.due, ['Everyone else had fun there.']);
});

test('shift: an edit after the sentence being edited changes nothing', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('a sunny').backspace(5).type('rainy');
  const at = f.text.indexOf('went home');
  f.replaceText(`${f.text.slice(0, at)}walked home${f.text.slice(at + 'went home'.length)}`);
  f.tracker.shift(at, 'walked home'.length - 'went home'.length);
  f.moveTo(0);
  assert.deepEqual(f.due, ['It was a rainy day.']);
});

test('shift: a shorter fix before the sentence being edited', () => {
  const start = 'The quick brown fox jumps over the lazy sleeping dog. It was a sunny day.';
  const f = field(start);
  f.moveAfter('sunny').backspace(5).type('rainy');
  const at = f.text.indexOf(' over the lazy sleeping dog');
  f.replaceText(f.text.slice(0, at) + f.text.slice(at + ' over the lazy sleeping dog'.length));
  f.tracker.shift(at, -' over the lazy sleeping dog'.length);
  f.moveTo(0);
  assert.deepEqual(f.due, ['It was a rainy day.']);
});

test('shift with the text after it: the next keystroke is followed too', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('Everyone').type(' else');
  // Caret applies a fix in sentence 1 and reports it with the text after.
  const at = f.text.indexOf('quick');
  const fix = 'very, very, very, very, very, very quick';
  f.replaceText(f.text.slice(0, at) + fix + f.text.slice(at + 'quick'.length));
  f.tracker.shift(at, fix.length - 'quick'.length, f.text);
  // Without a click being reported, their very next keystroke is in sentence 1.
  f.caret = f.text.indexOf('fox');
  f.type('r');
  assert.deepEqual(f.due, ['Everyone else had fun there.']);
  f.type('ed ').leave();
  assert.deepEqual(f.due,
    ['Everyone else had fun there.', 'The very, very, very, very, very, very quick brown red fox jumps.']);
});

test('shift with the text after it: a fix inside the sentence being typed, then typing on', () => {
  const f = field().type('We has gone to the park');
  const at = f.text.indexOf('has');
  f.replaceText(f.text.replace('has', 'have'));
  f.tracker.shift(at, 1, f.text);
  f.caret += 1;
  f.type('. ');
  assert.deepEqual(f.due, ['We have gone to the park.']);
});

test('shift with the text after it, when that text was already seen, does not move twice', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('Everyone').type(' else');
  const at = f.text.indexOf('quick');
  const fix = 'very, very, very, very, very, very quick';
  f.replaceText(f.text.slice(0, at) + fix + f.text.slice(at + 'quick'.length));
  f.caret += fix.length - 'quick'.length;
  f.tracker.caret(f.text, f.caret);                 // the change was followed here
  f.tracker.shift(at, fix.length - 'quick'.length, f.text);
  f.moveAfter('went home');
  assert.deepEqual(f.due, ['Everyone else had fun there.']);
});

test('an edit before the sentence being edited is followed even without shift', () => {
  const f = field(PARAGRAPH);
  f.moveAfter('Everyone').type(' else');
  const at = f.text.indexOf('quick');
  const fix = 'very, very, very, very, very, very quick';
  f.replaceText(f.text.slice(0, at) + fix + f.text.slice(at + 'quick'.length));
  f.moveAfter('went home');
  assert.deepEqual(f.due, ['Everyone else had fun there.']);
});

test('settle and isSettled', () => {
  const tracker = createTracker('');
  assert.equal(tracker.isSettled('We went to the park.'), false);
  tracker.settle('We went to the park.');
  assert.equal(tracker.isSettled('We went to the park.'), true);
  assert.equal(tracker.isSettled('We went to the park!'), false);
  // The kind of space does not make it a different sentence.
  assert.equal(tracker.isSettled('We\u00a0went to the park.'), true);
  assert.equal(tracker.isSettled(null), false);
  tracker.settle('');
  assert.equal(tracker.isSettled(''), false);
});

test('a sentence settled from outside is not sent', () => {
  const f = field().type('We went to the park.');
  f.tracker.settle('We went to the park.');
  f.type(' ').leave();
  assert.deepEqual(f.due, []);
});

test('the baseline counts as settled; anything returned as due is settled at once', () => {
  const tracker = createTracker('The cat sat on the mat. Dear Sam,');
  assert.equal(tracker.isSettled('The cat sat on the mat.'), true);
  assert.equal(tracker.isSettled('Dear Sam,'), true);
  const due = tracker.input('The cat sat on the mat. Dear Sam,\nThe dog ran off. ', 51, 'insertText');
  assert.deepEqual(plain(due), []);
  const tracker2 = createTracker('');
  tracker2.input('The dog ran off.', 16, 'insertText');
  const out = tracker2.input('The dog ran off. ', 17, 'insertText');
  assert.deepEqual(plain(out), ['The dog ran off.']);
  assert.equal(tracker2.isSettled('The dog ran off.'), true);
});

test('the memory of checked sentences is capped, oldest first', () => {
  const tracker = createTracker('');
  for (let i = 0; i <= 2000; i += 1) tracker.settle(`Sentence number ${i} is here.`);
  assert.equal(tracker.isSettled('Sentence number 0 is here.'), false);
  assert.equal(tracker.isSettled('Sentence number 1 is here.'), true);
  assert.equal(tracker.isSettled('Sentence number 2000 is here.'), true);
  // Settling again counts as fresh.
  tracker.settle('Sentence number 1 is here.');
  for (let i = 2001; i <= 2010; i += 1) tracker.settle(`Sentence number ${i} is here.`);
  assert.equal(tracker.isSettled('Sentence number 1 is here.'), true);
  assert.equal(tracker.isSettled('Sentence number 2 is here.'), false);
});

test('very long text is remembered by a fingerprint, and still recognised', () => {
  const long = `${'word '.repeat(2000)}end`;
  const tracker = createTracker(long);
  assert.equal(tracker.isSettled(long), true);
  assert.equal(tracker.isSettled(`${long}s`), false);
});

test('bad arguments do nothing and return no sentences', () => {
  const tracker = createTracker(undefined);
  assert.deepEqual(plain(tracker.input(null, 3, 'insertText')), []);
  assert.deepEqual(plain(tracker.input('The cat sat on it.', null, 'insertText')), []);
  assert.deepEqual(plain(tracker.caret('The cat sat on it.', -1)), []);
  assert.deepEqual(plain(tracker.idle('The cat sat on it.', 'x')), []);
  assert.deepEqual(plain(tracker.leave(42)), []);
  tracker.shift('x', 'y');
  tracker.shift(0, NaN);
});

test('a caret beyond the end of the text counts as having left', () => {
  const tracker = createTracker('');
  tracker.input('We went to the park.', 20, 'insertText');
  assert.deepEqual(plain(tracker.caret('We went to the park.', 500)), ['We went to the park.']);
});

test('undo that puts a checked sentence back sends nothing', () => {
  const f = field().type('We went to the park. ');
  assert.deepEqual(f.due, ['We went to the park.']);
  const tracker = f.tracker;
  // Select all and delete, then undo.
  assert.deepEqual(plain(tracker.input('', 0, 'deleteContentBackward')), []);
  assert.deepEqual(plain(tracker.input('We went to the park. ', 21, 'historyUndo')), []);
  assert.deepEqual(plain(tracker.leave('We went to the park. ')), []);
});

test('typing at the very start of the field, before existing text', () => {
  const f = field('It was a sunny day.');
  f.moveTo(0).type('Today we went out. ');
  assert.deepEqual(f.due, ['Today we went out.']);
  f.leave();
  assert.deepEqual(f.due, ['Today we went out.']);
});

test('pressing Enter in the middle of a sentence changes both halves', () => {
  const f = field('We went to the park and then we all went home.');
  f.moveAfter('the park ').type('\n');
  f.moveTo(0);
  // The first half has no full stop now; the second half is a new sentence.
  assert.deepEqual(f.due, ['and then we all went home.']);
  f.moveAfter('then').type(' later');
  f.leave();
  assert.deepEqual(f.due, ['and then we all went home.', 'and then later we all went home.']);
});

test('every due sentence is a sentence of the text it was returned for', () => {
  const tracker = createTracker('');
  const typed = `${PARAGRAPH}\n\n  - Item one is here. Item two is here.`;
  const sent = [];
  let text = '';
  for (const ch of typed) {
    text += ch;
    for (const sentence of tracker.input(text, text.length, 'insertText')) {
      assert.ok(segments(text).some((s) => s.text === sentence), sentence);
      sent.push(sentence);
    }
  }
  sent.push(...tracker.leave(text));
  assert.deepEqual(sent, [...FIVE, 'Item one is here.', 'Item two is here.']);
});

// ======================================================== cost and safety

test('stays fast on a 30,000-character field', () => {
  const sentence = 'Mr. Smith went to the U.S. on Jan. 5, e.g. by boat... Then it rained! ';
  let big = '';
  while (big.length < 30000) big += sentence + (big.length % 7 === 0 ? '\n\n    ' : '');
  big = big.slice(0, 30000);
  const t0 = performance.now();
  const all = segments(big);
  const tracker = createTracker(big);
  let text = big;
  for (let i = 0; i < 200; i += 1) {
    text += 'x';
    tracker.input(text, text.length, 'insertText');
    tracker.caret(text, text.length - 1);
  }
  tracker.idle(text, text.length);
  tracker.leave(text);
  const elapsed = performance.now() - t0;
  assert.ok(all.length > 300);
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)}ms`);
});

test('no pathological slowdown on a field full of dots and spaces', () => {
  const nasty = [
    '.'.repeat(30000),
    '. '.repeat(15000),
    'a.'.repeat(15000),
    'a. '.repeat(10000),
    ' '.repeat(30000),
    `${'x'.repeat(29999)}.`,
  ];
  const t0 = performance.now();
  for (const text of nasty) {
    segments(text);
    segmentAt(text, text.length);
    const tracker = createTracker('');
    tracker.input(text, text.length, 'insertFromPaste');
    tracker.idle(text, text.length);
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 3000, `took ${Math.round(elapsed)}ms`);
});

test('loading the script twice keeps the first copy', () => {
  const first = sandbox.window.__caret.sentences;
  vm.runInContext(SOURCE, sandbox);
  assert.equal(sandbox.window.__caret.sentences, first);
});

test('pure: no DOM and no extension APIs', () => {
  assert.ok(!/\bdocument\.|\bchrome\.|\bnavigator\.|\blocalStorage\b/.test(SOURCE));
});
