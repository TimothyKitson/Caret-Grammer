// Spell checking: decide whether a word is wrong, then find the words the
// writer probably meant.
//
// Candidates come from Norvig's edit-distance approach (every one-edit
// variation of the word, then two-edit if that found nothing) filtered against
// the dictionary and ranked by how common each candidate is in real English.

import { matchCase } from './text-util.js';

const ALPHABET = "abcdefghijklmnopqrstuvwxyz'";
const MAX_CACHE = 3000;
const MAX_WORD = 40;              // longer than any English word: not a word
const suggestionCache = new Map();

// Searching two edits out costs 50-150ms per word. A paste of names or of
// another language is all unknown words, so the depth is rationed per check
// rather than per word: the first few get the deep search, the rest make do
// with one edit and the typo list.
let deepBudget = 0;
export function resetDeepSearchBudget(n = 12) {
  deepBudget = n;
}

function edits1(word) {
  const out = new Set();
  for (let i = 0; i <= word.length; i += 1) {
    const head = word.slice(0, i);
    const tail = word.slice(i);
    if (tail) out.add(head + tail.slice(1));                              // delete
    if (tail.length > 1) out.add(head + tail[1] + tail[0] + tail.slice(2)); // transpose
    for (const c of ALPHABET) {
      if (tail) out.add(head + c + tail.slice(1));                        // replace
      out.add(head + c + tail);                                           // insert
    }
  }
  out.delete(word);
  return out;
}

/** Words that are one insertion of a space away: "alot" -> "a lot". */
function splitCandidates(word, dict) {
  const out = [];
  for (let i = 2; i <= word.length - 2; i += 1) {
    const a = word.slice(0, i);
    const b = word.slice(i);
    if (dict.hasExact(a) && dict.hasExact(b) && dict.rankOf(a) < 30000 && dict.rankOf(b) < 30000) {
      out.push(`${a} ${b}`);
    }
  }
  return out;
}

/**
 * Best corrections for a misspelled word, most likely first.
 * @param {string} word raw word as typed
 * @param {object} dict from createDictionary
 * @param {number} limit
 * @returns {string[]}
 */
/** "tim" -> "Tim", but only for words that are always names. */
function canonical(candidate, dict) {
  const name = dict.properForm ? dict.properForm(candidate) : null;
  return name && !name.ambiguous ? name.form : candidate;
}

/**
 * @param {string} word     the word as typed
 * @param {object} dict
 * @param {number} limit
 * @param {boolean} preferNames  put names first: the sentence is introducing one
 */
export function suggest(word, dict, limit = 5, preferNames = false) {
  const lower = word.toLowerCase().replace(/’/g, "'");
  const cacheKey = `${lower}|${limit}|${preferNames ? 'n' : ''}`;
  const cached = suggestionCache.get(cacheKey);
  if (cached) return cached.map((s) => matchCase(word, canonical(s, dict)));

  // Lower score wins. The tier (how far the candidate is from what was typed)
  // dominates; inside a tier the more common word wins. Rank is compared on a
  // log scale, so "the" beating "he" does not depend on the exact counts.
  const TIER = 1e6;
  const scored = new Map();
  const add = (candidate, tier) => {
    if (candidate === lower) return;
    const name = dict.properForm ? dict.properForm(candidate) : null;
    const score = tier * TIER
      + Math.round(Math.log(Math.min(dict.rankOf(candidate), 2e6)) * 10000)
      + (candidate[0] === lower[0] ? 0 : 20000)
      + Math.min(Math.abs(candidate.length - lower.length), 5) * 3000
      + (candidate.includes(' ') ? 15000 : 0)
      // "my name is timm" wants Tim, not time.
      + (preferNames && name && !name.ambiguous ? -90000 : 0);
    const previous = scored.get(candidate);
    if (previous === undefined || score < previous) scored.set(candidate, score);
  };

  // A documented typo is the best answer there is, in the order listed.
  // Tiers are spaced far enough apart that ranking never crosses them.
  const known = dict.correctionsFor(lower);
  if (known) known.forEach((fix, i) => add(fix.toLowerCase(), -3 + i * 0.5));

  const first = edits1(lower);
  for (const candidate of first) {
    if (dict.hasExact(candidate)) add(candidate, 0);
  }
  for (const candidate of splitCandidates(lower, dict)) add(candidate, 0.5);

  // Two edits away is expensive, so only when one edit found nothing at all.
  if (scored.size === 0 && lower.length <= 12 && deepBudget > 0) {
    deepBudget -= 1;
    let budget = 180000;
    for (const middle of first) {
      for (const candidate of edits1(middle)) {
        if ((budget -= 1) < 0) break;
        if (candidate.length > 1 && dict.hasExact(candidate)) add(candidate, 1);
      }
      if (budget < 0) break;
    }
  }

  const best = [...scored.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([candidate]) => candidate);

  if (suggestionCache.size > MAX_CACHE) suggestionCache.clear();
  suggestionCache.set(cacheKey, best);
  return best.map((s) => matchCase(word, canonical(s, dict)));
}

// Is the next word a name? Two very different questions, so two tests.
//
// An INTRODUCTION says so outright - "my name is Will", "Dear Rose", "Mr. Good"
// - and it is worth acting on however ordinary the word usually is.
export const NAME_INTRODUCTION = new RegExp(
  '\\b(?:'
  + "names?\\s*['’]?s?\\s+(?:is|are|was|were)"
  + '|call(?:ed)?\\s+me|goes\\s+by|named|signed'
  + '|yours\\s+(?:truly|sincerely)|sincerely|regards|attn'
  + '|dear'
  + '|m[rs]|mrs|mx|dr|prof|rev|sgt|capt|lt|gov|sen|rep|hon|fr|st'
  + ')\\s*\\.?[\\s,]*$', 'i',
);

// A GREETING only names someone when that is the whole of what is said to them:
// "Hi rose," is Rose, but "Hi, good to hear from you" is not Mr Good. So the
// word has to be followed by a comma or the end of the line.
export const NAME_GREETING = /\b(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))[\s,]*$/i;
export const NAME_ADDRESSED = /^\s*(?:[,!?:]|$)/;

// Deliberately NOT here: "this is", "I am", "it's", "thanks", "from", "tell",
// "met", "ask", "love". Each of them reads as an introduction about as often as
// it reads as an ordinary sentence, and the ordinary sentence is far more
// common - "this is good", "I am rich", "it's may already". Treating those as
// introductions is what used to turn every one of them into a surname.

// Looser than either of the above. Only used to nudge spelling suggestions for
// a word that is already unknown, where guessing "name" costs nothing.
export const NAME_HINT = /\b(?:names?\s*['’]?s?\s+is|call\s+me|named|signed|dear|sincerely|regards|hi|hello|hey|m[rs]|mrs|mx|dr|prof|sir|madam|meet|met|contact)\s*\.?[\s,]*$/i;

/**
 * Should this token be spell checked at all, and if so is it wrong?
 * Returns null for "fine", or an issue-shaped object.
 * `doc` is optional and only used to read the words just before the token.
 */
export function checkToken(token, dict, options = {}, doc = null) {
  if (token.skip || token.glued || token.mixedCase) return null;
  if (!token.hasVowel && token.text.length > 2) return null;   // rhythm is fine, HTML is not a word
  if (/(.)\1{2,}/.test(token.lower)) return null;              // hmmmm, ahhhh
  if (token.lower.length < 2 || token.lower.length > MAX_WORD) return null;

  const lower = token.lower.replace(/’/g, "'");

  // Acronyms: PTO, IEP, GPA. A short all-caps word is never a typo. Longer
  // ones fall through and are checked against their lower-case form.
  if (token.allCaps && token.text.length <= 3) return null;

  const typo = dict.correctionsFor(lower);
  if (typo) {
    return {
      id: 'spelling-known-typo',
      category: 'spelling',
      start: token.start,
      end: token.end,
      text: token.text,
      short: 'Spelling',
      message: `“${token.text}” is a common misspelling.`,
      replacements: typo.map((fix) => matchCase(token.text, fix)),
      confidence: 'high',
    };
  }

  if (dict.isKnown(lower)) return null;

  const before = doc ? (doc.normalized || doc.text).slice(Math.max(0, token.start - 24), token.start) : '';
  const replacements = suggest(token.text, dict, 5, NAME_HINT.test(before));

  // A capitalized word we do not know, with nothing close to it in the
  // dictionary, is almost always a name or a piece of jargon. Leave it alone
  // unless the user asked for those to be flagged too.
  // An unknown run of capitals is an acronym - IEP, ADHD, FAFSA, HVAC. There is
  // no way to spell-check one, and guessing at it is pure noise.
  if (token.allCaps && token.text.length > 1 && !options.checkNames) return null;

  if (token.capitalized && !options.checkNames) {
    // Only flag a capitalized word when there is a common word right next to
    // it ("Teh" -> "The"). Otherwise it is a name or a piece of jargon.
    const best = replacements.find((r) => !r.includes(' '));
    if (!best || dict.rankOf(best.toLowerCase()) > 20000) return null;
  }

  return {
    id: 'spelling-unknown',
    category: 'spelling',
    start: token.start,
    end: token.end,
    text: token.text,
    short: 'Spelling',
    message: replacements.length
      ? `“${token.text}” is not in the dictionary.`
      : `“${token.text}” is not in the dictionary. No close match was found.`,
    replacements,
    confidence: replacements.length ? 'high' : 'low',
  };
}

export function clearSuggestionCache() {
  suggestionCache.clear();
}
