// Sentences: where each one starts and ends, and which one is ready for the
// quick check.
//
// The quick check sends one finished sentence at a time to Caret's small
// model. Two questions decide what is sent, and both are answered here, with
// no DOM and no messaging, which is what makes them testable:
//
//   where are the sentences?   segments(text), segmentAt(text, offset)
//   which one is due now?      createTracker(text)
//
// A sentence is due once it has its full stop, question mark or exclamation
// mark AND the person has moved on from it: typed the space after it, gone to
// another sentence, stopped at its end, or left the field. It is sent once.
// It is sent again only if they change it and move on again, so clicking
// around, text that was already in the field and text a site puts there never
// cost a check. Every check comes out of a small shared free allowance, so
// "never send it twice" matters as much as "send it at the right moment".

(() => {
  const NS = (window.__caret = window.__caret || {});
  if (NS.sentences) return;

  // Longest sentence worth a quick check. Anything longer is a run-on the
  // small model would only mangle, or not prose at all.
  const MAX_SENTENCE = 600;
  // How many checked sentences one field remembers. The oldest go first.
  const SETTLED_MAX = 2000;

  // A full stop after one of these is an abbreviation, not the end of a
  // sentence. The same list autocorrect uses, so the two agree on where a
  // sentence starts.
  const ABBREVIATIONS = new Set([
    // titles
    'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'fr', 'hon', 'gov', 'sen',
    'rep', 'gen', 'col', 'capt', 'lt', 'sgt', 'jr', 'sr',
    // places and addresses
    'st', 'ave', 'blvd', 'rd', 'ln', 'ct', 'hwy', 'mt', 'ft', 'apt', 'ste',
    // organisations
    'inc', 'ltd', 'co', 'corp', 'dept', 'govt', 'univ', 'assn',
    // writing
    'vs', 'etc', 'eg', 'ie', 'cf', 'al', 'viz', 'ibid', 'approx', 'est',
    'fig', 'figs', 'vol', 'vols', 'pp', 'ch', 'sec', 'no', 'nos', 'misc',
    'ref', 'avg', 'tel', 'ext',
    // units
    'oz', 'lb', 'lbs', 'sq', 'hr', 'hrs', 'wk', 'wks', 'mo', 'yr', 'yrs',
    // dates
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri',
    'sat', 'sun', 'am', 'pm',
  ]);

  // These end a sentence after all when the next word has a capital:
  // "apples, pears, etc. Then we left."  "We met at 9 am. Then..."  "No. I
  // won't."  "It took 3 hrs. Then..." Before a number or a small letter they
  // are still abbreviations: "No. 5", "9 am. sharp", "5 lbs. of flour".
  const ENDS_BEFORE_CAPITAL = new Set([
    'etc', 'am', 'pm', 'no', 'oz', 'lb', 'lbs', 'hr', 'hrs', 'wk', 'wks', 'mo', 'yr', 'yrs',
  ]);
  // Everyday words that are abbreviations too. Written in small letters they
  // are the word - "The cat sat." "We sat in the sun." - and end a sentence
  // like any other. With a capital of their own they stay abbreviations:
  // "Open Sun. and Sat. only".
  const WORDS_IN_SMALL_LETTERS = new Set([
    'sun', 'sat', 'wed', 'mar', 'fig', 'figs', 'sec', 'ref', 'rep', 'hon', 'apt',
  ]);

  // e.g  i.e  a.m  U.S  Ph.D  J.R.R - one or two letters at a time, between dots.
  const DOTTED = /^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u;
  // Before a dotted word, these mean it is a web address or a file, not an
  // abbreviation: me@a.co, v2.e.g, ~/x.y
  const NOT_BEFORE_DOTTED = /[\p{L}\p{N}@/_:~-]/u;

  const LETTER = /\p{L}/u;
  const WORD_CHAR = /[\p{L}'’]/u;
  const CAPITAL = /\p{Lu}/u;
  const DIGIT = /\p{N}/u;
  // Spaces of every kind, including the no-break space rich editors type at
  // the end of a line, and the zero-width ones some editors leave behind.
  const SPACE = /[\s\u200b\u2060]/;
  const BREAKS = '\n\r\u2028\u2029\v\f';

  const STOPS = '.!?…‽⁇⁈⁉';
  const DEFINITE_STOP = /[!?‽⁇⁈⁉]/;
  // Closing quotes and brackets belong to the sentence they close.
  const CLOSERS = ')]}"\'”’»›';
  // Allowed between a full stop and the capital that starts the next sentence.
  const OPENERS = '"\'“‘«‹([{¿¡';

  // List markers, only ever at the start of a line: bullets, 1. 1) a. a) (1)
  // (a) iv. IV) and the like. A capital letter with a full stop is left alone
  // - "J. K. Rowling wrote it." starts with an initial far more often than a
  // list starts at "J." - but "A)" and "(A)" are markers.
  const NUMBER = String.raw`\d{1,3}(?:\.\d{1,3})*`;
  const ROMAN = String.raw`(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})|(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})`;
  const MARKER = new RegExp(
    String.raw`(?:[-*+–—]|(?:${NUMBER}|${ROMAN}|[a-z])[.)]|[A-Z]\)|\((?:${NUMBER}|${ROMAN}|[A-Za-z])\))(?=\s|$)`
    + '|[•◦‣⁃▪▫●○■□►▸▹➢➤✓✔☐☑]',
    'y',
  );
  // A to-do box after the bullet: "- [ ] call Sam", "- [x] done".
  const CHECKBOX = /\[[ xX]\](?=\s|$)/y;

  const isBreak = (ch) => ch !== undefined && BREAKS.includes(ch);
  const isSpace = (ch) => ch !== undefined && SPACE.test(ch);

  function skipSpaces(text, i, to) {
    while (i < to && isSpace(text[i])) i += 1;
    return i;
  }

  /** Past any indentation, "> " email quoting and one list marker. */
  function skipLineStart(text, from, to) {
    let i = skipSpaces(text, from, to);
    while (i < to && text[i] === '>') i = skipSpaces(text, i + 1, to);
    for (const marker of [MARKER, CHECKBOX]) {
      marker.lastIndex = i;
      const found = marker.exec(text);
      if (found && i + found[0].length <= to) i = skipSpaces(text, i + found[0].length, to);
    }
    return i;
  }

  /** A capital letter at `at`, perhaps after an opening quote or bracket. */
  function capitalAt(text, at) {
    let i = at;
    if (OPENERS.includes(text[i]) && i + 1 < text.length) i += 1;
    const code = text.codePointAt(i);
    return code !== undefined && CAPITAL.test(String.fromCodePoint(code));
  }

  /**
   * Is the full stop at `dot` part of an abbreviation or an initial, rather
   * than the end of the sentence? Only asked about a lone full stop that is
   * already followed by a space or the end of the text.
   */
  function abbreviated(text, lineStart, dot, capitalNext) {
    let w = dot;
    while (w > lineStart && WORD_CHAR.test(text[w - 1])) w -= 1;
    while (w < dot && !LETTER.test(text[w])) w += 1;   // a quote, not part of the word
    if (w === dot) return false;          // "It costs $5." - no word before the dot
    const word = text.slice(w, dot);
    const before = w > lineStart ? text[w - 1] : '';

    if (before === '.') {
      // Dots inside the word too. e.g. and U.S. are abbreviations; a file name
      // or a web address at the end of a sentence is not: "Open notes.txt."
      let t = w - 1;
      while (t > lineStart && (LETTER.test(text[t - 1]) || text[t - 1] === '.')) t -= 1;
      const token = text.slice(t, dot);
      const ahead = t > lineStart ? text[t - 1] : '';
      if (!DOTTED.test(token) || (ahead && NOT_BEFORE_DOTTED.test(ahead))) return false;
      // "We met at 9 a.m. Then we left." is two sentences.
      if (capitalNext && /^[ap]\.m$/i.test(token)) return false;
      return true;
    }

    // A single letter is an initial - J. K. Rowling - unless it is "I":
    // "so do I. Then we left." A letter after a number is not an initial
    // either: "We saw it in 3D."
    if (word.length === 1) return word !== 'I' && word !== 'i' && !DIGIT.test(before);

    const lower = word.toLowerCase();
    if (!ABBREVIATIONS.has(lower)) return false;
    if (word === lower && WORDS_IN_SMALL_LETTERS.has(lower)) return false;
    // "9 am." is the time; "Yes, I am." is the verb.
    if (lower === 'am' && !numberBefore(text, lineStart, w)) return false;
    if (capitalNext && ENDS_BEFORE_CAPITAL.has(lower)) return false;
    return true;
  }

  /** A number just before `at`, with or without a space: "9 am", "9am". */
  function numberBefore(text, lineStart, at) {
    let i = at;
    while (i > lineStart && isSpace(text[i - 1])) i -= 1;
    return i > lineStart && DIGIT.test(text[i - 1]);
  }

  /**
   * Does the run of stops at [runStart, runEnd), with any closing quotes up to
   * `after`, end the sentence? The caller has already made sure a space, a
   * line break or the end of the text follows.
   *
   * `closeLine` says the person is done with this line - they have moved to
   * another one, or left the field - so a stop at the very end of it ends the
   * sentence whatever the dots were for: "I wonder..." and "...at Acme Inc."
   * Without it, the end of a line is not enough on its own: a rich editor
   * reports a line break after the line being typed, and "I met Mr." there is
   * not finished.
   */
  function endsSentence(text, lineStart, runStart, runEnd, after, lineEnd, closeLine) {
    let next = after;
    while (next < lineEnd && isSpace(text[next])) next += 1;
    if (next === lineEnd && closeLine) return true;
    const run = text.slice(runStart, runEnd);
    if (DEFINITE_STOP.test(run)) return true;
    // The next word may be on a later line, past blank lines and indentation:
    // "...pears, etc.\nThen we left."
    while (next < text.length && isSpace(text[next])) next += 1;
    const capitalNext = next < text.length && capitalAt(text, next);
    // An ellipsis trails off: "Wait... then it rained" is one sentence, and
    // "Wait... Then it rained." is two. Two dots is a typo for three.
    if (run.length > 1 || run === '…') return capitalNext;
    return !abbreviated(text, lineStart, runStart, capitalNext);
  }

  function make(text, start, end, complete) {
    return { start, end, text: text.slice(start, end), complete };
  }

  /** The sentences on one line, [from, to), pushed onto `out` in order. */
  function scanLine(text, from, to, closeLine, out) {
    let i = skipLineStart(text, from, to);
    let start = -1;
    while (i < to) {
      const ch = text[i];
      if (start < 0) {
        if (isSpace(ch)) { i += 1; continue; }
        start = i;
      }
      if (!STOPS.includes(ch)) { i += 1; continue; }
      let runEnd = i + 1;
      while (runEnd < to && STOPS.includes(text[runEnd])) runEnd += 1;
      let after = runEnd;
      while (after < to && CLOSERS.includes(text[after])) after += 1;
      // A stop with no space after it is inside something: 3.5, example.com,
      // file.txt, a.m.x. It never ends a sentence.
      if ((after === to || isSpace(text[after]))
          && endsSentence(text, from, i, runEnd, after, to, closeLine)) {
        out.push(make(text, start, after, true));
        start = -1;
      }
      i = after;
    }
    if (start >= 0) {
      let end = to;
      while (end > start && isSpace(text[end - 1])) end -= 1;
      if (end > start) out.push(make(text, start, end, false));
    }
  }

  function lineStartOf(text, at) {
    let i = at;
    while (i > 0 && !isBreak(text[i - 1])) i -= 1;
    return i;
  }

  function lineEndOf(text, at) {
    let i = at;
    while (i < text.length && !isBreak(text[i])) i += 1;
    return i;
  }

  /** Every segment on the lines that touch [from, to]. */
  function segmentsBetween(text, from, to) {
    const out = [];
    let lineStart = lineStartOf(text, from);
    for (;;) {
      const lineEnd = lineEndOf(text, lineStart);
      scanLine(text, lineStart, lineEnd, false, out);
      if (lineEnd >= to || lineEnd >= text.length) break;
      lineStart = lineEnd + 1;
    }
    return out;
  }

  /**
   * Every sentence-like segment in the text, in order. `text` is always
   * exactly original.slice(start, end); `complete` says it ends with a real
   * sentence stop. A line break always ends a segment, so a heading or
   * "Dear Sam," is a segment of its own that is never complete.
   *
   * @returns {Array<{start: number, end: number, text: string, complete: boolean}>}
   */
  function segments(text) {
    if (typeof text !== 'string' || !text) return [];
    return segmentsBetween(text, 0, text.length);
  }

  function findAt(text, offset, closeLine) {
    if (typeof text !== 'string' || !Number.isInteger(offset) || offset < 0 || offset > text.length) {
      return null;
    }
    // Only the line holding the offset is read, so this costs the same on a
    // long document as on a short one. An offset on a line break belongs to
    // the line it ends.
    const lineStart = lineStartOf(text, offset);
    const line = [];
    scanLine(text, lineStart, lineEndOf(text, offset), closeLine, line);
    return line.find((segment) => segment.start <= offset && offset <= segment.end) || null;
  }

  /** The segment with start <= offset <= end, or null. */
  function segmentAt(text, offset) {
    return findAt(text, offset, false);
  }

  /**
   * Worth a quick check: finished, at least three words, not too long, and
   * mostly letters - phone numbers, links and code are not.
   */
  function isCheckable(segment) {
    if (!segment || !segment.complete || typeof segment.text !== 'string') return false;
    const { text } = segment;
    if (text.length > MAX_SENTENCE) return false;
    let words = 0;
    for (const token of text.split(/\s+/)) if (LETTER.test(token)) words += 1;
    if (words < 3) return false;
    const letters = (text.match(/\p{L}/gu) || []).length;
    const visible = text.replace(/\s/g, '').length;
    return letters * 2 >= visible;
  }

  /** An opening quote or bracket with no partner yet: they may still close it. */
  function stillOpen(sentence) {
    const count = (re) => (sentence.match(re) || []).length;
    return count(/"/g) % 2 === 1
      || count(/“/g) > count(/”/g)
      || count(/\(/g) > count(/\)/g)
      || count(/\[/g) > count(/]/g);
  }

  /** What changed between two versions of the text: [from, oldTo) became [from, newTo). */
  function diff(before, after) {
    const shortest = Math.min(before.length, after.length);
    let from = 0;
    while (from < shortest && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
    let same = 0;
    while (same < shortest - from
        && before.charCodeAt(before.length - 1 - same) === after.charCodeAt(after.length - 1 - same)) {
      same += 1;
    }
    return { from, oldTo: before.length - same, newTo: after.length - same };
  }

  // A sentence is remembered by its text, so a sentence is "the same" wherever
  // it moves. The kind of space in it does not count - a rich editor swaps a
  // no-break space for a plain one as you type next to it - and a sentence too
  // long to ever be checked is kept as a short fingerprint, so the memory
  // stays small.
  function keyFor(sentence) {
    const plain = sentence
      .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/[\u200b\u2060\ufeff]/g, '');
    if (plain.length <= MAX_SENTENCE) return `=${plain}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < plain.length; i += 1) {
      hash = Math.imul(hash ^ plain.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `#${plain.length}:${hash.toString(36)}`;
  }

  /**
   * Follows one field and says which sentence is due for a quick check, and
   * when. Everything in `initialText` counts as already checked: it was there
   * before the person started typing, so it is not sent unless they change it.
   *
   * Only the sentence the person is editing - the one their last keystroke
   * was in - can ever become due. It is remembered by where it starts.
   */
  function createTracker(initialText) {
    const settled = new Map();   // key -> true, oldest first
    let editStart = null;        // where the sentence being edited starts
    let seen = typeof initialText === 'string' ? initialText : '';
    let shifted = false;         // shift() has already allowed for the latest change

    function remember(sentence) {
      const key = keyFor(sentence);
      settled.delete(key);
      settled.set(key, true);
      if (settled.size > SETTLED_MAX) settled.delete(settled.keys().next().value);
    }

    function isSettled(sentence) {
      return typeof sentence === 'string' && settled.has(keyFor(sentence));
    }

    function settle(sentence) {
      if (typeof sentence === 'string' && sentence) remember(sentence);
    }

    for (const segment of segments(seen)) remember(segment.text);

    // Keep editStart on the same sentence whatever changed since the last call:
    // a site adding text above it, an edit Caret made, a click and a keystroke
    // somewhere else.
    function follow(text) {
      const before = seen;
      seen = text;
      if (shifted) { shifted = false; return; }
      if (editStart === null || before === text) return;
      const { from, oldTo, newTo } = diff(before, text);
      if (editStart < from) return;                          // changed after it
      if (editStart > from && editStart >= oldTo) {          // changed before it
        editStart += newTo - oldTo;
        return;
      }
      if (editStart === from && oldTo === from) {
        // Typed right at its start: a space or a line break pushes the
        // sentence along, a letter becomes part of it.
        if (newTo > from && isSpace(text[newTo - 1])) editStart = newTo;
        return;
      }
      editStart = from;                                      // its start was rewritten
    }

    /** Still on this sentence? Inside it, or in the spaces after an unfinished one. */
    function within(segment, caret, text) {
      if (caret >= segment.start && caret <= segment.end) return true;
      // "etc. " and "Wait... " are only decided by the next word, and "Mr. "
      // by the name after it: someone who has just typed the space has not
      // left yet.
      if (segment.complete || caret < segment.end || caret > text.length) return false;
      for (let i = segment.end; i < caret; i += 1) {
        if (!isSpace(text[i]) || isBreak(text[i])) return false;
      }
      return true;
    }

    /** Due now, unless it is unfinished, not worth a check, or already checked. */
    function claim(segment, out) {
      if (!segment || !isCheckable(segment) || isSettled(segment.text)) return;
      remember(segment.text);
      out.push(segment.text);
    }

    /** If the caret has left the sentence being edited, that sentence may be due. */
    function checkLeft(text, caret, out) {
      if (editStart === null) return;
      let segment = findAt(text, editStart, false);
      if (segment && within(segment, caret, text)) {
        editStart = segment.start;
        return;
      }
      // Gone to another line - Enter, a click, the arrow keys: that line is
      // finished, and so is a sentence ending "..." or "Inc." at the end of it.
      if (segment && !segment.complete
          && (caret < lineStartOf(text, segment.start) || caret > lineEndOf(text, segment.end))) {
        segment = findAt(text, editStart, true);
      }
      claim(segment, out);
      editStart = null;
    }

    // Pasted or dropped sentences are someone else's finished text, or the
    // person's own from elsewhere: not checked unless they are edited here.
    // The sentence the caret ends up in stays open if the paste only finished
    // what they were typing.
    function settlePasted(before, text) {
      const { from, newTo } = diff(before, text);
      for (const segment of segmentsBetween(text, from, newTo)) {
        if (segment.end <= from || segment.start >= newTo) continue;
        const wholly = segment.start >= from && segment.end <= newTo;
        if (segment.start === editStart && !wholly) continue;
        remember(segment.text);
      }
    }

    const validCaret = (caret) => Number.isInteger(caret) && caret >= 0;

    return {
      /**
       * After every input event the person caused (not mid-composition).
       * @returns {string[]} the sentences due now
       */
      input(text, caret, inputType) {
        if (typeof text !== 'string') return [];
        const before = seen;
        follow(text);
        if (!validCaret(caret)) return [];
        const out = [];
        checkLeft(text, caret, out);
        if (editStart === null) {
          const here = findAt(text, caret, false);
          editStart = here ? here.start : null;
        }
        if (/^insertFrom/.test(inputType || '')) settlePasted(before, text);
        return out;
      },

      /** The caret moved without an edit: a click, the arrow keys. */
      caret(text, caret) {
        if (typeof text !== 'string') return [];
        follow(text);
        if (!validCaret(caret)) return [];
        const out = [];
        checkLeft(text, caret, out);
        return out;
      },

      /** They stopped typing. A sentence they just finished, and stopped at, is due. */
      idle(text, caret) {
        if (typeof text !== 'string') return [];
        follow(text);
        if (!validCaret(caret)) return [];
        const out = [];
        checkLeft(text, caret, out);
        if (editStart !== null) {
          const segment = findAt(text, editStart, false);
          // An open quote or bracket means they may be about to close it,
          // which would change the sentence and cost a second check.
          if (segment && caret === segment.end && !stillOpen(segment.text)) claim(segment, out);
        }
        return out;
      },

      /**
       * The field lost focus. The text is as finished as it is going to get,
       * so a sentence ending in "..." or "Inc." at the end of its line counts
       * as done.
       */
      leave(text) {
        if (typeof text !== 'string') return [];
        follow(text);
        const out = [];
        if (editStart !== null) claim(findAt(text, editStart, true), out);
        editStart = null;
        return out;
      },

      /**
       * Caret changed the text itself (applying a suggestion): the length at
       * `at` changed by `delta`. Call it instead of passing that edit to input().
       */
      shift(at, delta) {
        shifted = true;
        if (editStart === null || !Number.isFinite(at) || !Number.isFinite(delta)) return;
        if (at < editStart) editStart = Math.max(at, editStart + delta);
      },

      /** Treat this sentence as checked for as long as it reads exactly like this. */
      settle,

      isSettled,
    };
  }

  NS.sentences = {
    segments,
    segmentAt,
    isCheckable,
    createTracker,
  };
})();
