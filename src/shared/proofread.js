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
  '  that looks like a template or placeholder.',
  '- "original" must be copied character for character from the text, and be',
  '  as short as possible while still being fixable on its own.',
  '- "before" must be the 10 characters that immediately precede "original"',
  '  in the text (fewer only at the very start). Copy them exactly.',
  '- "replacement" must be the corrected version of "original" alone.',
  '- Explanations are one short sentence, in plain language.',
  '- If the text is already correct, return an empty list.',
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
          kind: { type: 'string', enum: ['spelling', 'grammar', 'punctuation', 'style'] },
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

export { SYSTEM_PROMPT, SCHEMA };

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
  return null;
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
