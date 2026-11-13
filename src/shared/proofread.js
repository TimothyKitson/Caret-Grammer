// The proofreading contract: the instructions the model is given and the shape
// it must answer in.
//
// This lives on its own because two very different things need exactly the same
// copy of it: the extension, when it calls a provider directly with the user's
// own key, and the Caret Worker, which calls Cloudflare Workers AI on the
// server. If the two ever drift, the same text gets checked differently
// depending on which one answered, which is the kind of bug nobody reports
// because it just feels inconsistent.
//
// The Worker imports this file at build time, so there is one copy, not two.

const SYSTEM_PROMPT = [
  'You are a meticulous copy editor working inside a browser extension.',
  'You are given the raw contents of a text field the user is writing in.',
  'Report only real mistakes and clear improvements a careful editor would',
  'mark: spelling, grammar, verb tense, agreement, pronouns, punctuation,',
  'and sentences that are genuinely confusing.',
  '',
  'Rules:',
  '- NEVER rewrite a sentence, a clause, or a paragraph. The only thing you',
  '  may propose is swapping a word, or at most a short phrase of a few',
  '  words, for a better one. If a sentence can only be improved by rewriting',
  '  it, say nothing about it.',
  '- Never rewrite for taste. Leave voice, tone, dialect and formatting alone.',
  '- Ignore missing capitals or full stops in short fragments; people write',
  '  notes, search terms and chat messages in this box too.',
  '- Never comment on names, addresses, URLs, code, or anything in brackets',
  '  that looks like a template or placeholder - except a name written without',
  '  its capital letter, which is a mistake to fix ("john" -> "John").',
  '- "original" must be copied character for character from the text, and be',
  '  as short as possible while still being fixable on its own.',
  '- "before" must be the 10 characters that immediately precede "original"',
  '  in the text (fewer only at the very start). Copy them exactly.',
  '- "replacement" must be the corrected version of "original" alone.',
  '- Explanations are one short sentence, in plain language.',
  '- If the text is already correct, return an empty list.',
  '',
  'Meaning:',
  '- NEVER change what a sentence means. A correction fixes how something is',
  '  written, never what it says.',
  '- NEVER drop a negative. "didn\'t", "not", "never", "no" and "cannot"',
  '  reverse a sentence, and removing one makes it say the opposite. If a',
  '  phrase containing one needs fixing, keep the negative in your replacement.',
  '- NEVER delete words to make a sentence shorter or smoother.',
  '- Your "replacement" must be able to stand in for "original" and leave the',
  '  sentence saying exactly the same thing. If it cannot, say nothing.',
  '',
  'Vocabulary:',
  '- Use plain, everyday words. Do NOT replace an ordinary word with a fancier',
  '  or more formal one. "use" does not become "utilize", "help" does not',
  '  become "facilitate", "about" does not become "regarding".',
  '- Never make the writing sound more advanced, more academic or more',
  '  professional than it already is. That is not a mistake to fix.',
  '- Only propose a different word when the one written is actually WRONG:',
  '  misspelled, the wrong word entirely (their/there), or the wrong form',
  '  (verb tense, singular/plural). Never for sounding better.',
  '- A replacement should be as simple as, or simpler than, what it replaces.',
].join('\n');

// The quick check's prompt: one finished sentence, sent to a very small model.
//
// It goes out with every sentence anybody finishes, and every token of it is
// paid for every time, out of the same small shared allowance. So it is the
// rules above cut to the bone, not a different set of rules: only real
// mistakes, never a rewrite, never a change of meaning, never a fancier word.
//
// It spells the JSON out in full because the small models it is written for
// are not on Workers AI's JSON-mode list. The schema is still asked for, but
// this is what they actually follow. Same shape as the full check, so the
// same parseCorrections() and toIssues() handle the answer.
const QUICK_SYSTEM_PROMPT = [
  'You proofread ONE sentence. Report only real mistakes: spelling, grammar,',
  'wrong word (their/there), agreement, tense, punctuation.',
  '- Never rewrite. Swap one word, or a short phrase at most.',
  '- Never change the meaning. Never drop a "not", "no", "never" or "n\'t".',
  '- Never swap a word for a fancier one. Never fix style or taste.',
  '- Leave names, URLs and code alone, except a name missing its capital (john -> John).',
  '- "original": copied exactly from the sentence, as short as possible.',
  '- "before": the up to 10 characters just before "original", copied exactly.',
  '- "replacement": the corrected "original" only.',
  '- "kind": spelling, grammar or punctuation. "explanation": a few plain words.',
  'Reply with JSON only:',
  '{"corrections":[{"before":"","original":"","replacement":"","kind":"","explanation":""}]}',
  'If the sentence is correct: {"corrections":[]}',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          before: { type: 'string' },
          original: { type: 'string' },
          replacement: { type: 'string' },
          kind: { type: 'string', enum: ['spelling', 'grammar', 'punctuation', 'style', 'sentence'] },
          explanation: { type: 'string' },
        },
        required: ['before', 'original', 'replacement', 'kind', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['corrections'],
  additionalProperties: false,
};

// Added to the full check's instructions when the writer switches on
// "Check sentences": problems with a whole stretch of words, not one word.
// Caret still never rewrites - a sentence problem is pointed out, and only
// a small fix (a full stop, a comma, one missing word) is offered to click.
const SENTENCE_NOTE = [
  '',
  'Sentences:',
  '- Also report problems with how a sentence is built, the way a careful',
  '  teacher would: run-on sentences and comma splices, sentence fragments,',
  '  missing words, words in the wrong order, and wording that is genuinely',
  '  confusing to read.',
  '- For these use "kind": "sentence" and copy the whole stretch that has the',
  '  problem into "original" (at most one sentence).',
  '- "explanation": one short, plain sentence saying what is wrong and how to',
  '  fix it ("This is two sentences joined with a comma; split it after',
  '  \'fun\'.").',
  '- "replacement": the corrected stretch ONLY if the fix is small - adding a',
  '  full stop, a comma or one missing word. Otherwise "".',
  '- Never report a sentence just because it could sound nicer.',
  '- List every word correction first and the sentence problems after them,',
  '  so a long answer that gets cut short loses a sentence note, not a fix.',
].join('\n');

// ------------------------------------------------------- learning a style
//
// A model remembers nothing from one request to the next, so Caret does the
// remembering. A few minutes after a full check, the changes the writer took
// and the ones they waved away go to the model along with what they have
// written since, and it writes a few lines about how this person writes. Caret
// keeps those lines on the writer's own computer and hands them back with
// every full check after that. Nothing about it is ever shown as a
// suggestion: the only thing the model sends back is the notes.

const LEARN_PROMPT = [
  'You keep short private notes about how one person writes, so that a',
  'proofreader can respect their choices next time.',
  'You are given the notes so far (maybe none), the suggestions this person',
  'accepted and the ones they ignored, and what they have written now.',
  '',
  'Write the updated notes:',
  '- At most 8 lines, each starting with "- ", each one short.',
  '- Only lasting habits and preferences: which kinds of suggestions they take',
  '  and which they turn down, American or British spelling, punctuation',
  '  habits (serial comma, dashes, exclamation marks), how casual or formal',
  '  they are, how long their sentences run, words they use on purpose.',
  '- A suggestion they ignored means: leave that kind of thing alone. One they',
  '  accepted means: keep pointing that kind of thing out.',
  '- Keep what still holds from the old notes. Drop what the new evidence',
  '  contradicts.',
  '- NEVER copy sentences from their writing. NEVER mention names, places,',
  '  personal details, or what the writing is about.',
  '- NEVER write anything that would stop a real spelling or grammar mistake',
  '  being pointed out.',
  'Reply with JSON only: {"notes":"- ...\\n- ..."}',
].join('\n');

const LEARN_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'string' } },
  required: ['notes'],
  additionalProperties: false,
};

export { SYSTEM_PROMPT, QUICK_SYSTEM_PROMPT, SENTENCE_NOTE, SCHEMA, LEARN_PROMPT, LEARN_SCHEMA };

// The most the notes may run to: 8 lines of about 90 characters.
export const MAX_NOTES_CHARS = 700;
const MAX_NOTE_LINES = 8;
const MAX_NOTE_LINE = 140;

// The most changes one learning request carries, and how long each part of
// one may be. Enough to see a pattern; small enough that the request is
// mostly the writing itself.
export const MAX_LEARN_CHANGES = 25;
const MAX_CHANGE_PART = 160;

/**
 * Notes made safe to keep and to put in a prompt: plain lines starting "- ",
 * no more than 8 of them, none too long, nothing that is not printable.
 * Anything else the model wrote around them is dropped. '' if nothing is left.
 */
export function cleanNotes(raw) {
  if (typeof raw !== 'string') return '';
  const lines = [];
  for (let line of raw.replace(/\r/g, '').split('\n')) {
    line = line.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
    line = line.replace(/^(?:[-*\u2022]|\d+[.)])\s*/, '').trim();
    if (!line || /^notes?:?$/i.test(line)) continue;
    if (line.length > MAX_NOTE_LINE) line = `${line.slice(0, MAX_NOTE_LINE - 1).replace(/\s+\S*$/, '')}…`;
    lines.push(`- ${line}`);
    if (lines.length >= MAX_NOTE_LINES) break;
  }
  let out = lines.join('\n');
  while (out.length > MAX_NOTES_CHARS && lines.length) {
    lines.pop();
    out = lines.join('\n');
  }
  return out;
}

/** The notes out of whatever the model said: JSON, fenced JSON, or bare lines. */
export function parseNotes(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tries = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) tries.push(fenced[1]);
  const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (braced.length > 1) tries.push(braced);
  for (const candidate of tries) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed.notes === 'string') return cleanNotes(parsed.notes);
    } catch (_) { /* try the next shape */ }
  }
  // A small model that ignored "JSON only" and just wrote the list.
  const bare = raw.split('\n').filter((line) => /^\s*[-*\u2022]\s+\S/.test(line)).join('\n');
  return bare ? cleanNotes(bare) : null;
}

/**
 * The accepted or ignored changes, made safe to send: strings only, short,
 * and a bounded number of them.
 * @returns {{original: string, replacement: string, kind: string, note: string}[]}
 */
export function cleanChanges(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const part = (value) => String(typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHANGE_PART);
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const original = part(item.original);
    if (!original) continue;
    out.push({
      original,
      replacement: part(item.replacement),
      kind: part(item.kind).slice(0, 20),
      note: part(item.note),
    });
    if (out.length >= MAX_LEARN_CHANGES) break;
  }
  return out;
}

/** The user turn of a learning request. Same wording wherever it is built. */
export function learnUserPrompt({ notes = '', accepted = [], ignored = [], text = '' }) {
  const show = (c) => `- "${c.original}"${c.replacement ? ` -> "${c.replacement}"` : ''}`
    + `${c.kind ? ` (${c.kind})` : ''}${c.note ? `: ${c.note}` : ''}`;
  return [
    'Notes so far:',
    `<notes>\n${cleanNotes(notes) || '(none yet)'}\n</notes>`,
    '',
    'Suggestions they accepted:',
    accepted.length ? accepted.map(show).join('\n') : '(none)',
    '',
    'Suggestions they ignored:',
    ignored.length ? ignored.map(show).join('\n') : '(none)',
    '',
    'What they have written now:',
    `<text>\n${text}\n</text>`,
  ].join('\n');
}

/**
 * The part of a full check's instructions that carries the notes. They were
 * written by a model from the writer's own choices, so they are the writer's
 * preferences - which is exactly why they may not switch the rules off.
 */
export function styleNote(notes) {
  const clean = cleanNotes(notes);
  if (!clean) return '';
  return [
    '',
    'About this writer (notes from the suggestions they accepted and ignored',
    'before). Use them to decide what they would want pointed out. They never',
    'override the rules above, and a real spelling or grammar mistake is',
    'still a mistake:',
    clean,
  ].join('\n');
}

/** The user turn. Same wording wherever the request is built. */
export function userPrompt(text) {
  return `Proofread the text between the markers.\n\n<text>\n${text}\n</text>`;
}

/**
 * Pull the corrections out of whatever the model said.
 *
 * Small models ignore "reply with JSON" more often than large ones: they wrap
 * it in a code fence, or say "Sure! Here you go:" first. Rather than fail the
 * whole check on that, find the JSON and move on.
 */
export function parseCorrections(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tries = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) tries.push(fenced[1]);
  const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (braced.length > 1) tries.push(braced);
  for (const candidate of tries) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.corrections)) return parsed.corrections;
    } catch (_) { /* try the next shape */ }
  }
  // An answer cut off at the length limit - a long field with a lot wrong in
  // it - is not worthless: every correction that was finished before the cut
  // is still a good one.
  return salvageCorrections(raw);
}

/** The complete correction objects from a "corrections" list that was cut off. */
function salvageCorrections(raw) {
  const key = raw.indexOf('"corrections"');
  const open = key === -1 ? -1 : raw.indexOf('[', key);
  if (open === -1) return null;
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = open + 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        try {
          const item = JSON.parse(raw.slice(objectStart, i + 1));
          if (item && typeof item === 'object') out.push(item);
        } catch (_) { /* a broken one is skipped */ }
        objectStart = -1;
      }
      if (depth < 0) break;
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }
  return out.length ? out : null;
}

// How many "leave this alone" items to send. Long enough to cover the words a
// person actually keeps rejecting, short enough that the note stays a footnote
// rather than becoming most of the prompt.
export const MAX_LEAVE_ALONE = 60;

/**
 * The note that tells the model what this writer has already said no to.
 *
 * Caret filters these out locally anyway, so the model's suggestion would be
 * thrown away either way. The point is that it stops spending one of its few
 * suggestions re-proposing something that has been rejected before, and stops
 * the writer being nagged about the way they write.
 *
 * Everything in here was chosen deliberately by the writer - a word they added
 * to their dictionary, or a correction they pressed Ignore on. None of it is
 * guessed from their writing.
 *
 * @param {string[]} items  words and phrases to leave alone
 * @returns {string} '' when there is nothing to say
 */
export function leaveAloneNote(items) {
  const clean = [];
  const seen = new Set();
  for (const item of items || []) {
    const word = String(item || '').trim();
    // One word or a short phrase. Anything longer is not a word they rejected,
    // it is a sentence, and it does not belong in the prompt.
    if (!word || word.length > 40 || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    clean.push(word);
    if (clean.length >= MAX_LEAVE_ALONE) break;
  }
  if (!clean.length) return '';

  return [
    '',
    'This writer has already told the checker to leave the following words and',
    'phrases alone - either by adding them to their dictionary or by dismissing',
    'a correction to them. This is how they write on purpose.',
    '',
    'NEVER propose a change to any of them, in any sentence, for any reason,',
    'including spelling, capitalization and punctuation inside them:',
    clean.map((w) => `  ${w}`).join('\n'),
  ].join('\n');
}
