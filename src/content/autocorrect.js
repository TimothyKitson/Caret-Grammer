// Autocorrect: the handful of fixes that have exactly one right answer, applied
// the moment you finish the word instead of waiting to be clicked.
//
// The bar for changing someone's text without asking is much higher than the
// bar for underlining it, so this only ever acts on:
//   "i" and its contractions        i'll -> I'll
//   missing apostrophes             dont -> don't
//   the first word of a sentence    hello -> Hello
//   documented typos with one fix   teh  -> the   (looked up in the worker)
//
// Everything ambiguous - their/there, your/you're, to/too - stays underlined
// and waits for a human. Every correction is an ordinary edit, so Ctrl+Z undoes
// it, and a word you undo is left alone for the rest of the session.

(() => {
  const NS = (window.__caret = window.__caret || {});
  if (NS.autocorrect) return;

  // Written without the apostrophe. Only forms that are not themselves words,
  // or that practically never mean the other thing.
  const APOSTROPHES = {
    dont: "don't", doesnt: "doesn't", didnt: "didn't", isnt: "isn't",
    arent: "aren't", wasnt: "wasn't", werent: "weren't", hasnt: "hasn't",
    havent: "haven't", hadnt: "hadn't", couldnt: "couldn't",
    wouldnt: "wouldn't", shouldnt: "shouldn't", mustnt: "mustn't",
    neednt: "needn't", wont: "won't", cant: "can't", cannt: "can't",
    aint: "ain't", im: "I'm", ive: "I've", ill: null, id: null,
    youre: "you're", youve: "you've", youll: "you'll", youd: "you'd",
    theyre: "they're", theyve: "they've", theyll: "they'll", theyd: "they'd",
    weve: "we've", wed: null, were: null, whos: "who's", whove: "who've",
    thats: "that's", whats: "what's", wheres: "where's", whens: "when's",
    hows: "how's", heres: "here's", theres: "there's", lets: null,
    shes: "she's", hes: null, its: null, oclock: "o'clock", yall: "y'all",
    couldve: "could've", wouldve: "would've", shouldve: "should've",
    mightve: "might've", mustve: "must've", shant: "shan't",
  };

  // "I" on its own, and the contractions built on it.
  // Deliberately missing "ill" and "id": both are ordinary words.
  const LONE_I = {
    i: 'I', im: "I'm", ive: "I've",
    "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd",
  };

  // A full stop after one of these is an abbreviation, not the end of a
  // sentence, so the next word does not get a capital.
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

  // Before a lone "i", these mean it is a name for something - a loop
  // variable, the letter itself - and not the pronoun: "the variable i",
  // "for i in range", "dot the i".
  const I_AS_A_NAME = /(?:^|[^A-Za-z])(?:the|a|an|each|every|variable|var|let|int|index|iterator|counter|letter|for|foreach|from|by|to)\s+$/i;

  // An operator or bracket either side of a lone "i" means maths or code.
  // Not a hyphen: "well - i think" is how a lot of people write a dash.
  const OPERATOR_BEFORE = /[=+*/<>()[\]{}%^&|!~]\s*$/;

  // Text that is plainly code. Autocorrect has no business there at all.
  // Every pattern needs real code syntax, not just a keyword: "For example:"
  // and "Let me know" start lines of ordinary prose.
  const LOOKS_LIKE_CODE = new RegExp([
    String.raw`==|!=|<=|>=|=>|\+=|-=|&&|\|\|`,
    String.raw`\w\s*=\s*[\w'"(\[{]`,                        // x = 1
    String.raw`[{}]\s*$|;\s*$`,                            // a line ending in { } or ;
    String.raw`^\s*(?:def|class|function|fn|func)\s+\w+\s*[(:{<]`,
    String.raw`^\s*(?:const|let|var)\s+\w+\s*[=:;]`,
    String.raw`^\s*(?:from\s+[\w.]+\s+import\b|import\s+[\w.]+\s*$|#include\b)`,
    String.raw`^\s*for\s+\w+(?:,\s*\w+)*\s+in\s+\S+:\s*$`,     // python for
    String.raw`^\s*(?:else|try|finally):\s*$`,
    String.raw`\w\(\)`,                                       // call()
    String.raw`\b(?:print|printf|println|console\.log)\(`,
    String.raw`^\s*` + '```',
  ].join('|'), 'im');

  /** Code anywhere near the word? Only nearby text is looked at, so a long
   *  document costs the same as a short one on every keystroke. */
  function looksLikeCode(text, at) {
    return LOOKS_LIKE_CODE.test(text.slice(Math.max(0, at - 1500), at + 500));
  }

  // Typing one of these ends a word. No colon, slash or dash: those appear
  // mid-URL and mid-path, and "https:" must never become "Https:".
  const TERMINATORS = /[\s.,;!?)\]}"”]/;
  const WORD_CHAR = /[A-Za-z'’]/;

  /** The word that was just finished, or null. */
  function wordBefore(text, caret) {
    if (caret < 2) return null;
    const terminator = text[caret - 1];
    if (!TERMINATORS.test(terminator)) return null;
    // "i." might be the start of "i.e.", so a lone i before a full stop is
    // decided at the space after it instead, once that is clear.
    if (/\s/.test(terminator) && caret >= 3 && text[caret - 2] === '.' && text[caret - 3] === 'i'
        && (caret === 3 || !WORD_CHAR.test(text[caret - 4]))) {
      return { word: 'i', start: caret - 3, end: caret - 2, terminator: '.', late: true };
    }
    let end = caret - 1;
    let start = end;
    while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
    if (start === end) return null;
    const word = text.slice(start, end);
    if (!/[A-Za-z]/.test(word)) return null;
    return { word, start, end, terminator };
  }

  /** Is the character before this word something that means "leave it alone"? */
  function inAwkwardPlace(text, start) {
    const before = start > 0 ? text[start - 1] : '';
    return /[\w@#$%/\\_.\d]/.test(before);
  }

  /** Does a new sentence start here? */
  function startsSentence(text, start) {
    let i = start - 1;
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
    if (i < 0) return true;                       // very beginning of the field
    if (text[i] === '\n') return true;            // new line
    if (!'.!?'.includes(text[i])) return false;
    // "wait... then" is one thought, not two sentences.
    let dots = 0;
    while (i - dots >= 0 && text[i - dots] === '.') dots += 1;
    if (dots >= 2) return false;               // "wait.. then" - a typo, not a stop
    const before = text.slice(Math.max(0, i - 12), i);
    const abbreviation = /([A-Za-z]+)$/.exec(before);
    if (abbreviation && ABBREVIATIONS.has(abbreviation[1].toLowerCase())) return false;
    // Initials: J. Smith. But "so do I." is the end of a sentence.
    if (/(^|[^A-Za-z])[A-HJ-Za-hj-z]$/.test(before)) return false;
    return true;
  }

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /**
   * What, if anything, this word should become. Pure: no DOM, no settings
   * lookups beyond the object it is handed, which is what makes it testable.
   *
   * @returns {{fixed: string, reason: string}|null}
   */
  function decide({ word, start, terminator, late }, text, options) {
    const plain = word.replace(/’/g, "'");
    const lower = plain.toLowerCase();
    const settings = options.autocorrect || {};
    const field = options.field || {};
    if (options.skip && options.skip.has(lower)) return null;
    // Addresses, links and phone numbers are not sentences.
    if (field.type === 'email' || field.type === 'url' || field.type === 'tel') return null;
    if (field.code || looksLikeCode(text, start)) return null;
    if (inAwkwardPlace(text, start)) return null;
    if (/[A-Z]/.test(word.slice(1))) return null;        // iPhone, McDonald, HTML
    if (options.known && options.known.has(lower)) return null;   // user's own word
    // "im" is German for "in the"; "i" is Catalan for "and". The page says
    // what language it is in, and the English-only fixes respect that.
    const english = !field.lang || /^en\b/i.test(field.lang);
    const before = text.slice(Math.max(0, start - 40), start);

    // "i" and its contractions, whatever else is going on.
    if (english && settings.capitalizeI !== false && LONE_I[lower] && /^i/.test(plain)) {
      const pronoun = lower !== 'i'
        || (!(terminator === '.' && !late)             // wait: could be "i.e."
          && !I_AS_A_NAME.test(before)                 // the variable i
          && !OPERATOR_BEFORE.test(before));           // x = i + 1
      const fixed = LONE_I[lower];
      if (pronoun && fixed !== word) return { fixed, reason: 'capitalize-i' };
      if (lower === 'i') return null;
    }
    if (late) return null;

    // dont -> don't
    if (english && settings.apostrophes !== false && word === plain && !plain.includes("'")) {
      const fixed = APOSTROPHES[lower];
      if (fixed) {
        const cased = /^[A-Z]/.test(word) && !/^I/.test(fixed) ? capitalize(fixed) : fixed;
        if (cased !== word) return { fixed: cased, reason: 'apostrophe' };
      }
    }

    // first word of a sentence
    if (settings.sentenceCaps !== false && /^[a-z]/.test(word) && sentenceCapsAllowed(field, text, start, lower)
        && startsSentence(text, start)) {
      return { fixed: capitalize(word), reason: 'sentence-capital' };
    }

    return null;
  }

  /** Does this field want its sentences capitalized at all? */
  function sentenceCapsAllowed(field, text, start, lower) {
    if (field.autocapitalize === 'off' || field.autocapitalize === 'none') return false;
    // A search box, a name, a username: one line, not a sentence.
    if (field.type === 'search') return false;
    if (field.kind === 'input' && !/\S/.test(text.slice(0, start))) return false;
    // A single letter on its own is a variable or a label far more often than
    // the start of a sentence. "a" is the exception.
    if (lower.length === 1 && lower !== 'a') return false;
    // A line indented with spaces is code or a quoted block, not a paragraph.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^ {2,}/.test(text.slice(lineStart, start))) return false;
    return true;
  }

  NS.autocorrect = {
    wordBefore,
    decide,
    startsSentence,
    looksLikeCode,
    APOSTROPHES,
  };
})();
