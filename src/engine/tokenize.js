// Turns a block of text into the pieces every check needs: words with their
// exact offsets, sentence boundaries, and the ranges that must be left alone
// (links, e-mail addresses, code, anything with a digit stuck to it).
//
// Offsets are always indexes into the original string, so an issue found here
// can be underlined without any further mapping.

// "Mr." does not end a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'fr', 'st', 'jr', 'sr', 'hon',
  'gen', 'col', 'lt', 'sgt', 'capt', 'cmdr', 'adm', 'gov', 'sen', 'rep',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'vol', 'no', 'ed',
  'vs', 'etc', 'eg', 'ie', 'cf', 'al', 'approx', 'appt', 'apt', 'ave',
  'blvd', 'rd', 'mt', 'ft', 'sq', 'min', 'max', 'sec', 'hr', 'hrs',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri',
  'sat', 'sun', 'am', 'pm', 'pp', 'ca', 'circa', 'op', 'ref', 'tel', 'ext',
]);

// Everything inside one of these is skipped: it is not prose.
const SKIP_PATTERNS = [
  /\bhttps?:\/\/\S+/gi,             // links
  /\bwww\.\S+/gi,
  /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, // e-mail addresses
  /\b[\w-]+\.(?:com|org|net|edu|gov|mil|int|io|co|us|uk|ca|de|fr|au|nz|dev|app|me|info|biz|tv|xyz|ai|so|sh)\b(?:\/\S*)?/gi,
  /[@#][\w-]{2,}/g,                 // @mentions and #hashtags
  /`[^`\n]*`/g,                     // `code`
  /<\/?[a-z][^>\n]*>/gi,            // <html tags>
  /\{\{[^}]*\}\}|\$\{[^}]*\}/g,     // {{template}} / ${template}
  /\b[a-z]:\\[^\s]*/gi,             // C:\paths
  /(?:^|\s)\/[\w./-]{2,}/g,         // /unix/paths
  /#[0-9a-f]{3,8}\b/gi,             // #hex colours
  /\b[\w'-]*\d[\w'-]*\b/g,          // anything with a digit in it: 3rd, h1, x2
  /\b\w+_\w+\b|\b_\w+\b/g,          // snake_case / _private
  /:[a-z_]+:/g,                     // :emoji_codes:
];

const VOWELS = /[aeiouy]/;

// Curly quotes, non-breaking spaces and friends, mapped to their plain
// equivalents one character for one character, so every offset still lines up
// with the original string. Rules match against this copy; anything shown to
// the user is sliced out of the original.
const SMART_CHARS = /[\u2018\u2019\u201B\u2032\u201C\u201D\u00A0\u2013\u2014]/g;
const PLAIN = {
  '\u2018': "'", '\u2019': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u00A0': ' ', '\u2013': '-', '\u2014': '-',
};

export function normalize(text) {
  if (!SMART_CHARS.test(text)) { SMART_CHARS.lastIndex = 0; return text; }
  SMART_CHARS.lastIndex = 0;
  return text.replace(SMART_CHARS, (ch) => PLAIN[ch] || ch);
}

function buildSkipRanges(text) {
  const ranges = [];
  for (const pattern of SKIP_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length > 4000) break;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Merge overlaps so lookups stay cheap.
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// True when [start, end) touches a skipped range. Binary search: this runs for
// every word in the field on every keystroke pause.
export function inSkipRange(ranges, start, end) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (e <= start) lo = mid + 1;
    else if (s >= end) hi = mid - 1;
    else return true;
  }
  return false;
}

// A word is letters, optionally joined by apostrophes or hyphens. Hyphenated
// compounds are split so "well-know" reports only the bad half.
const WORD_RE = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  let afterEllipsis = false;
  const push = (from, to) => {
    while (from < to && /\s/.test(text[from])) from += 1;
    let end = to;
    while (end > from && /\s/.test(text[end - 1])) end -= 1;
    if (end > from) sentences.push({ start: from, end, afterEllipsis });
    afterEllipsis = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    // Swallow "?!" and "...".
    let j = i;
    while (j + 1 < text.length && '.!?'.includes(text[j + 1])) j += 1;
    const after = text.slice(j + 1);
    if (!/^(\s|$)/.test(after)) continue;                 // 3.5, foo.bar
    if (ch === '.') {
      const before = text.slice(Math.max(0, i - 12), i);
      const word = /([A-Za-z]+)$/.exec(before);
      if (word && ABBREVIATIONS.has(word[1].toLowerCase())) continue;
      if (/(^|[^A-Za-z])[A-Za-z]$/.test(before)) continue; // initials: J. Smith
    }
    push(start, j + 1);
    // "I waited... then left." is one thought: the next fragment is not a new
    // sentence that needs a capital letter.
    afterEllipsis = j > i && text.slice(i, j + 1) === '.'.repeat(j - i + 1);
    start = j + 1;
    i = j;
  }
  push(start, text.length);
  return sentences;
}

/**
 * @param {string} text
 * @returns {{text: string, tokens: object[], sentences: object[],
 *            skipRanges: number[][], wordCount: number, isProse: boolean}}
 */
export function analyze(text) {
  const normalized = normalize(text);
  const skipRanges = buildSkipRanges(normalized);
  const sentences = splitSentences(normalized);
  const tokens = [];

  let sentenceIndex = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(normalized)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    while (sentenceIndex < sentences.length - 1 && sentences[sentenceIndex].end <= start) {
      sentenceIndex += 1;
    }
    const sentence = sentences[sentenceIndex];
    const before = start > 0 ? normalized[start - 1] : '';
    const after = end < normalized.length ? normalized[end] : '';
    const word = text.slice(start, end);      // shown to the user as typed
    const plain = m[0];                       // matched with plain quotes
    const token = {
      text: word,
      lower: plain.toLowerCase(),
      start,
      end,
      sentence: sentence && start >= sentence.start && end <= sentence.end ? sentenceIndex : -1,
      // Position in its sentence is what tells a name apart from a typo.
      first: !!sentence && start === firstWordStart(normalized, sentence),
      // Only a digit or code punctuation means "not a word": a hyphen, a quote
      // or a full stop next to a word must still be spell checked, so
      // "well-recieved" and 'recieved' are caught.
      glued: /[\d@#$%/\\_]/.test(before) || /[\d@#$%/\\_]/.test(after),
      allCaps: plain.length > 1 && plain === plain.toUpperCase(),
      capitalized: /^[A-Z]/.test(plain),
      // JavaScript, iPhone, McDonald - product and code names, not typos.
      mixedCase: /[A-Z]/.test(plain.slice(1)) && /[a-z]/.test(plain),
      hasVowel: VOWELS.test(plain.toLowerCase()),
      skip: inSkipRange(skipRanges, start, end),
    };
    tokens.push(token);
    if (tokens.length > 20000) break;
  }

  const wordCount = tokens.length;
  return {
    text,
    normalized,
    tokens,
    sentences,
    skipRanges,
    wordCount,
    // Short scraps - a search box, a username - get only the checks that make
    // sense out of context. No "start your sentence with a capital" nagging.
    isProse: wordCount >= 6 || /[.!?]/.test(text),
  };
}

const firstWordCache = new WeakMap();
function firstWordStart(text, sentence) {
  let cache = firstWordCache.get(sentence);
  if (cache !== undefined) return cache;
  const slice = text.slice(sentence.start, sentence.end);
  const m = /[A-Za-z]/.exec(slice);
  cache = m ? sentence.start + m.index : -1;
  firstWordCache.set(sentence, cache);
  return cache;
}
