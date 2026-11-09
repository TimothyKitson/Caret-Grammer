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
    'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'inc', 'ltd', 'co',
    'vs', 'etc', 'eg', 'ie', 'no', 'approx', 'dept', 'est', 'fig', 'vol',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'am', 'pm',
  ]);

  // Typing one of these ends a word. No colon, slash or dash: those appear
  // mid-URL and mid-path, and "https:" must never become "Https:".
  const TERMINATORS = /[\s.,;!?)\]}"”]/;
  const WORD_CHAR = /[A-Za-z'’]/;

  /** The word that was just finished, or null. */
  function wordBefore(text, caret) {
    if (caret < 2) return null;
    const terminator = text[caret - 1];
    if (!TERMINATORS.test(terminator)) return null;
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
    if (dots >= 3) return false;
    const before = text.slice(Math.max(0, i - 12), i);
    const abbreviation = /([A-Za-z]+)$/.exec(before);
    if (abbreviation && ABBREVIATIONS.has(abbreviation[1].toLowerCase())) return false;
    if (/(^|[^A-Za-z])[A-Za-z]$/.test(before)) return false;   // initials: J. Smith
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
  function decide({ word, start }, text, options) {
    const plain = word.replace(/’/g, "'");
    const lower = plain.toLowerCase();
    const settings = options.autocorrect || {};
    if (options.skip && options.skip.has(lower)) return null;
    if (inAwkwardPlace(text, start)) return null;
    if (/[A-Z]/.test(word.slice(1))) return null;        // iPhone, McDonald, HTML
    if (options.known && options.known.has(lower)) return null;   // user's own word

    // "i" and its contractions, whatever else is going on.
    if (settings.capitalizeI !== false && LONE_I[lower] && /^i/.test(plain)) {
      const fixed = LONE_I[lower];
      if (fixed !== word) return { fixed, reason: 'capitalize-i' };
    }

    // dont -> don't
    if (settings.apostrophes !== false && word === plain && !plain.includes("'")) {
      const fixed = APOSTROPHES[lower];
      if (fixed) {
        const cased = /^[A-Z]/.test(word) && !/^I/.test(fixed) ? capitalize(fixed) : fixed;
        if (cased !== word) return { fixed: cased, reason: 'apostrophe' };
      }
    }

    // first word of a sentence
    if (settings.sentenceCaps !== false && /^[a-z]/.test(word) && startsSentence(text, start)) {
      return { fixed: capitalize(word), reason: 'sentence-capital' };
    }

    return null;
  }

  NS.autocorrect = {
    wordBefore,
    decide,
    startsSentence,
    APOSTROPHES,
  };
})();
