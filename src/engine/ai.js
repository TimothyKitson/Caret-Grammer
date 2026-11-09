// Optional second opinion from the Claude API.
//
// Off unless you put your own API key in the options page. The local checks
// above catch spelling and the mechanical mistakes; this catches the rest -
// tense, agreement across a long sentence, awkward phrasing - the things a
// regular expression cannot see.
//
// Runs in the service worker, never in the page: the key must not be reachable
// from any web page's JavaScript, and cross-origin requests from a content
// script would be attributed to the page's own origin.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_CHARS = 6000;

export const AI_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 - cheapest, about $1 per million words in' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 - middle' },
  { id: 'claude-opus-5', label: 'Opus 5 - most careful, most expensive' },
];

// Effort is an Opus/Sonnet control. Haiku 4.5 rejects it with a 400, so the
// parameter is left off for models that do not take it.
const NO_EFFORT_MODELS = new Set(['claude-haiku-4-5']);

// A correction may swap a word or two. Anything bigger is a rewrite, and this
// extension does not rewrite what you wrote.
const MAX_ORIGINAL_CHARS = 60;
const MAX_ORIGINAL_WORDS = 6;

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

/** Turn one model correction into an issue with real offsets, or null. */
function locate(text, correction, taken) {
  const { original, before } = correction;
  if (!original) return null;

  const candidates = [];
  if (before) {
    let from = 0;
    const needle = before + original;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      candidates.push(at + before.length);
      from = at + 1;
    }
  }
  if (candidates.length === 0) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(original, from);
      if (at === -1) break;
      candidates.push(at);
      from = at + 1;
      if (candidates.length > 20) break;
    }
  }

  for (const start of candidates) {
    const end = start + original.length;
    if (taken.some(([s, e]) => start < e && s < end)) continue;
    taken.push([start, end]);
    return { start, end };
  }
  return null;
}

/** Reject anything that is a rewrite rather than a word swap. */
function isWordSwap(original, replacement) {
  if (typeof original !== 'string' || typeof replacement !== 'string') return false;
  if (!original.trim()) return false;
  if (original.length > MAX_ORIGINAL_CHARS) return false;
  if (original.trim().split(/\s+/).length > MAX_ORIGINAL_WORDS) return false;
  if (/\n/.test(original) || /\n/.test(replacement)) return false;
  // A "fix" several times longer than what it replaces is new prose.
  if (replacement.length > original.length * 2 + 12) return false;
  return true;
}

export function toIssues(text, corrections) {
  const taken = [];
  const issues = [];
  for (const correction of corrections || []) {
    if (typeof correction.original !== 'string') continue;
    if (correction.replacement === correction.original) continue;
    if (!isWordSwap(correction.original, correction.replacement)) continue;
    // Never let one suggestion swallow the whole field.
    if (correction.original.trim() === text.trim()) continue;
    const at = locate(text, correction, taken);
    if (!at) continue;
    const category = ['spelling', 'grammar', 'punctuation', 'style'].includes(correction.kind)
      ? correction.kind
      : 'grammar';
    issues.push({
      id: `ai-${category}`,
      category,
      short: 'Claude',
      start: at.start,
      end: at.end,
      text: text.slice(at.start, at.end),
      message: String(correction.explanation || 'Suggested correction.').slice(0, 300),
      replacements: [String(correction.replacement ?? '')],
      confidence: 'high',
      source: 'ai',
    });
  }
  return issues;
}

/**
 * @returns {Promise<{issues: object[], truncated: boolean, usage: object}>}
 * @throws {Error} with .status set for HTTP failures
 */
export async function checkWithClaude(text, {
  apiKey,
  model = 'claude-opus-5',
  effort = 'low',
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!apiKey) throw Object.assign(new Error('No API key set.'), { code: 'no-key' });
  const truncated = text.length > MAX_CHARS;
  const supportsEffort = !NO_EFFORT_MODELS.has(model);
  const body = {
    model,
    max_tokens: supportsEffort ? 6000 : 2000,
    system: SYSTEM_PROMPT,
    output_config: {
      ...(supportsEffort ? { effort } : {}),
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{
      role: 'user',
      content: `Proofread the text between the markers.\n\n<text>\n${truncated ? text.slice(0, MAX_CHARS) : text}\n</text>`,
    }],
  };

  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Required for requests that carry an Origin header, which everything
      // from an extension does.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const error = await response.json();
      detail = error?.error?.message || '';
    } catch (_) { /* body was not JSON */ }
    const message = response.status === 401 || response.status === 403
      ? 'Claude rejected the API key.'
      : `Claude API error ${response.status}${detail ? `: ${detail}` : ''}`;
    throw Object.assign(new Error(message), { status: response.status });
  }

  const payload = await response.json();
  if (payload.stop_reason === 'refusal') {
    throw Object.assign(new Error('Claude declined to check that text.'), { code: 'refusal' });
  }
  const textBlock = (payload.content || []).find((block) => block.type === 'text' && block.text);
  if (!textBlock) return { issues: [], truncated, usage: payload.usage || {} };

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (_) {
    // output_config.format guarantees valid JSON, but never trust a remote
    // shape: a bad response should be a no-op, not a broken field.
    return { issues: [], truncated, usage: payload.usage || {} };
  }

  return {
    issues: toIssues(text, parsed.corrections),
    truncated,
    usage: payload.usage || {},
    model: payload.model || model,
  };
}
