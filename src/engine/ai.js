// Optional second opinion from an AI model - OpenAI or Anthropic, whichever
// the key belongs to.
//
// Off unless there is a key: either one pasted into the options page or one
// baked into src/shared/apikey.js. The local checks
// above catch spelling and the mechanical mistakes; this catches the rest -
// tense, agreement across a long sentence, awkward phrasing - the things a
// regular expression cannot see.
//
// Runs in the service worker, never in the page: the key must not be reachable
// from any web page's JavaScript, and cross-origin requests from a content
// script would be attributed to the page's own origin.

import {
  SYSTEM_PROMPT, SCHEMA, userPrompt, parseCorrections, leaveAloneNote,
} from '../shared/proofread.js';
import { CARET_ENDPOINT } from '../shared/apikey.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const API_VERSION = '2023-06-01';
const MAX_CHARS = 6000;

export const AI_MODELS = {
  // The shared Worker picks its own model, so there is nothing to choose here.
  caret: [{ id: '', label: 'Chosen by the Caret server' }],
  // Google is first because its free tier is the only one that will proofread
  // all day without a card on file. Both of these are on it.
  gemini: [
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite - free tier, plenty for this' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash - free tier, more careful' },
  ],
  openai: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna - cheapest, fine for proofreading' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra - more careful, about ten times the price' },
  ],
  anthropic: [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5 - cheapest, fine for proofreading' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 - middle' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 - most careful, most expensive' },
  ],
};

export const DEFAULT_MODEL = {
  caret: '',
  gemini: 'gemini-3.5-flash-lite',
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
};

// Models an earlier version offered, mapped to the one that replaces them at
// the same tier. Gemini 2.0 Flash is shut down, 2.5 Flash is closed to new
// keys, and GPT-4o mini shuts down in January 2027; the older Claude models
// still answer, but their replacements are cheaper and better.
const MODEL_UPGRADES = {
  'gemini-2.0-flash': 'gemini-3.5-flash-lite',
  'gemini-2.5-flash': 'gemini-3.5-flash-lite',
  'gpt-4o-mini': 'gpt-6-luna',
  'gpt-4o': 'gpt-6.1-terra',
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-opus-5-5',
};

/** The model to actually call: a saved choice if it is still offered, else its replacement, else the default. */
export function resolveModel(provider, model) {
  const offered = (AI_MODELS[provider] || []).map((m) => m.id);
  if (model && offered.includes(model)) return model;
  const upgraded = MODEL_UPGRADES[model];
  if (upgraded && offered.includes(upgraded)) return upgraded;
  return DEFAULT_MODEL[provider] ?? '';
}

/** Gemini's responseSchema is an OpenAPI subset: no additionalProperties. */
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    out[key] = geminiSchema(value);
  }
  return out;
}

// Haiku 4.5 rejects the effort parameter with a 400. Every model offered now
// takes it; this stays for a request made with an old saved model id.
const NO_EFFORT_MODELS = new Set(['claude-haiku-4-5']);

// A correction may swap a word or two. Anything bigger is a rewrite, and this
// extension does not rewrite what you wrote.
const MAX_ORIGINAL_CHARS = 60;
const MAX_ORIGINAL_WORDS = 6;



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

// Words that carry the meaning of a sentence rather than decorate it. Losing
// one of these does not correct a sentence, it contradicts it.
const NEGATIONS = /\b(?:not|never|no|none|nothing|nobody|nowhere|neither|nor|cannot|hardly|barely|scarcely|rarely|seldom|without|can't|cant|won't|wont|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent|haven't|havent|hasn't|hasnt|hadn't|hadnt|shouldn't|shouldnt|wouldn't|wouldnt|couldn't|couldnt|ain't|aint)\b|n['’]t\b/gi;

const countNegations = (text) => (String(text).match(NEGATIONS) || []).length;

// Every number, time, price and phone fragment, in order. A proofreader has no
// business changing any of them: "15:30" -> "16:30" is a different meeting.
const numbersIn = (text) => (String(text).match(/\d+/g) || []).join(' ');

// "unclear" -> "clear", "nonprofit" -> "profit", "incorrect" -> "correct": a
// negative prefix taken off a word turns it into its opposite.
const NEG_PREFIX = /^(?:un|non-?|dis|in|im|il|ir)([a-z]{3,})$/i;
function dropsANegativePrefix(original, replacement) {
  const kept = new Set(String(replacement).toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) || []);
  for (const word of String(original).toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) || []) {
    const m = word.match(NEG_PREFIX);
    if (m && !kept.has(word) && kept.has(m[1])) return true;
  }
  return false;
}
const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** Reject anything that is a rewrite rather than a word swap. */
function isWordSwap(original, replacement) {
  if (typeof original !== 'string' || typeof replacement !== 'string') return false;
  if (!original.trim()) return false;
  if (original.length > MAX_ORIGINAL_CHARS) return false;
  if (wordCount(original) > MAX_ORIGINAL_WORDS) return false;
  if (/\n/.test(original) || /\n/.test(replacement)) return false;
  // A "fix" several times longer than what it replaces is new prose.
  if (replacement.length > original.length * 2 + 12) return false;

  // Losing a "didn't" turns "I didn't get one" into "I got one". That is not a
  // correction at any confidence, so it is refused here rather than trusted to
  // the model's instructions. Gaining one can be right - "could care less"
  // really does want "couldn't" - so only losing is refused.
  if (countNegations(replacement) < countNegations(original)) return false;
  if (numbersIn(replacement) !== numbersIn(original)) return false;
  if (dropsANegativePrefix(original, replacement)) return false;

  // Dropping one word is a real fix: "the the" -> "the". Dropping two or more
  // is a sentence being rewritten, whatever it claims to be.
  if (wordCount(original) - wordCount(replacement) >= 2) return false;

  return true;
}

// Things that must never leave the computer, AI pass or not. Each match is
// blanked character for character (separators kept) so the text keeps its
// shape and length; a correction that touches a blank cannot be found in the
// real text and is dropped.
const SECRETS = [
  // card numbers: 13 to 19 digits, spaces or dashes allowed between
  /\b(?:\d[ -]?){12,18}\d\b/g,
  // US social security numbers
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // API keys and tokens with a known shape
  new RegExp('(?:\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|\\bAIza[0-9A-Za-z_-]{30,}|\\bcaret_[A-Za-z0-9_-]{8,}'
    + '|\\bgh[pousr]_[A-Za-z0-9]{20,}|\\bgithub_pat_[A-Za-z0-9_]{20,}|\\bxox[abprs]-[A-Za-z0-9-]{10,}'
    + '|\\bAKIA[0-9A-Z]{16}\\b|\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})', 'g'),
  // anything else long and random-looking: 32+ letters and digits, both kinds
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];
// "my password is hunter2", "PIN: 4821" - the value, not the label.
const SECRET_AFTER_LABEL = /(\b(?:password|passwd|passcode|pwd|pin)\s*(?:is\s+|[:=]\s*))(\S+?)(?=[.,;!?]?(?:\s|$))/gi;

const blank = (s) => s.replace(/[^\s-]/g, '•');

/** The text with anything secret-looking blanked out. Same length as the input. */
export function maskSecrets(text) {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, blank);
  return out.replace(SECRET_AFTER_LABEL, (_, label, value) => label + blank(value));
}

const isSecret = (s) => maskSecrets(s) !== s;

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
      short: 'AI',
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
const REASONING_OPENAI = /^(?:gpt-(?:[5-9]|\d{2,})|o\d)/;

/** Ask OpenAI. Returns the raw JSON string the model produced. */
async function callOpenAi(text, { apiKey, model, system, fetchImpl, signal }) {
  const response = await fetchImpl(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      // Proofreading is not a reasoning task; keep it cheap and literal. The
      // GPT-5 and later models are reasoning models: they reject a temperature
      // other than the default, and take "none" to skip the thinking.
      ...(REASONING_OPENAI.test(model) ? { reasoning_effort: 'none' } : { temperature: 0 }),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt(text) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'corrections', strict: true, schema: SCHEMA },
      },
    }),
    signal,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const error = await response.json();
      detail = error?.error?.message || '';
    } catch (_) { /* body was not JSON */ }
    const message = response.status === 401 || response.status === 403
      ? 'OpenAI rejected the API key.'
      : response.status === 429
        ? 'OpenAI says you are out of quota or going too fast.'
        : `OpenAI error ${response.status}${detail ? `: ${detail}` : ''}`;
    throw Object.assign(new Error(message), { status: response.status });
  }

  const payload = await response.json();
  const choice = (payload.choices || [])[0];
  if (choice?.message?.refusal) {
    throw Object.assign(new Error('The model declined to check that text.'), { code: 'refusal' });
  }
  return {
    json: choice?.message?.content || '',
    usage: payload.usage || {},
    model: payload.model || model,
  };
}

/** Ask Anthropic. Returns the raw JSON string the model produced. */
async function callAnthropic(text, { apiKey, model, effort, system, fetchImpl, signal }) {
  const supportsEffort = !NO_EFFORT_MODELS.has(model);
  const response = await fetchImpl(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Required for requests that carry an Origin header, which everything
      // from an extension does.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: supportsEffort ? 6000 : 2000,
      system,
      output_config: {
        ...(supportsEffort ? { effort } : {}),
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [{
        role: 'user',
        content: userPrompt(text),
      }],
    }),
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
  const block = (payload.content || []).find((b) => b.type === 'text' && b.text);
  return {
    json: block ? block.text : '',
    usage: payload.usage || {},
    model: payload.model || model,
  };
}

/**
 * Ask the shared Caret Worker, which runs the model on its own account.
 *
 * The point of this one is that the person has no API key of their own and no
 * account anywhere: they paste a short caret_ key and that is the whole setup.
 * The allowance behind it is small and shared, so a refusal here is normal and
 * has to read like an ordinary pause rather than a fault.
 */
async function callCaret(text, { apiKey, leaveAlone, mode, fetchImpl, signal }) {
  if (!CARET_ENDPOINT) {
    throw Object.assign(
      new Error('This build has no Caret server set, so a caret_ key has nothing to talk to.'),
      { code: 'no-endpoint' },
    );
  }
  const response = await fetchImpl(`${CARET_ENDPOINT.replace(/\/$/, '')}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-caret-key': apiKey },
    body: JSON.stringify({
      text,
      ...(mode === 'quick' ? { mode } : {}),
      ...(leaveAlone && leaveAlone.length ? { leaveAlone } : {}),
    }),
    signal,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) { /* handled below */ }

  if (!response.ok) {
    const detail = (payload && payload.error) || `error ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    // Out of allowance is not a fault to shout about: the local checks carry
    // on, and tomorrow it works again.
    if (response.status === 429) error.code = 'quiet';
    throw error;
  }

  return {
    json: JSON.stringify({ corrections: (payload && payload.corrections) || [] }),
    usage: payload && typeof payload.left === 'number' ? { left: payload.left } : {},
    model: (payload && payload.model) || 'caret',
    mode: (payload && payload.mode) || '',
  };
}

/** Ask Google. Returns the raw JSON string the model produced. */
async function callGemini(text, { apiKey, model, system, fetchImpl, signal }) {
  // The key goes in a header, not the query string: a URL can end up in logs.
  const response = await fetchImpl(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(text) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: geminiSchema(SCHEMA),
      },
    }),
    signal,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const error = await response.json();
      detail = error?.error?.message || '';
    } catch (_) { /* body was not JSON */ }
    const message = response.status === 400 && /API key/i.test(detail)
      ? 'Google rejected the API key.'
      : response.status === 401 || response.status === 403
        ? 'Google rejected the API key.'
        : response.status === 429
          ? 'Google free tier limit reached. It resets on its own - try again in a minute.'
          : `Google API error ${response.status}${detail ? `: ${detail}` : ''}`;
    throw Object.assign(new Error(message), { status: response.status });
  }

  const payload = await response.json();
  const candidate = (payload.candidates || [])[0];
  if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
    throw Object.assign(new Error('The model declined to check that text.'), { code: 'refusal' });
  }
  const part = (candidate?.content?.parts || []).find((p) => typeof p.text === 'string');
  return {
    json: part ? part.text : '',
    usage: payload.usageMetadata || {},
    model,
  };
}

/**
 * Proofread `text` with whichever provider the key belongs to.
 *
 * @returns {Promise<{issues: object[], truncated: boolean, usage: object}>}
 * @throws {Error} with .status set for HTTP failures
 */
export async function checkWithAi(text, {
  apiKey,
  provider,
  model,
  effort = 'low',
  // Words this writer has already said to leave alone: their own dictionary,
  // and the corrections they have dismissed.
  leaveAlone = [],
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!apiKey) throw Object.assign(new Error('No API key set.'), { code: 'no-key' });
  if (!provider) {
    throw Object.assign(
      new Error('That key does not look like a Caret, Google, OpenAI or Anthropic key.'),
      { code: 'bad-key' },
    );
  }
  const truncated = text.length > MAX_CHARS;
  const body = maskSecrets(truncated ? text.slice(0, MAX_CHARS) : text);
  // A word pressed Ignore on can itself be a key that got underlined.
  leaveAlone = leaveAlone.filter((word) => !isSecret(String(word)));
  const call = {
    caret: callCaret, openai: callOpenAi, gemini: callGemini, anthropic: callAnthropic,
  }[provider];
  const result = await call(body, {
    apiKey,
    model: resolveModel(provider, model),
    effort,
    system: SYSTEM_PROMPT + leaveAloneNote(leaveAlone),
    leaveAlone,
    fetchImpl,
    signal,
  });

  // The schema is meant to guarantee valid JSON, but never trust a remote
  // shape: a bad response should be a no-op, not a broken field.
  const corrections = parseCorrections(result.json);
  if (!corrections) return { issues: [], truncated, usage: result.usage };

  return {
    issues: toIssues(text, corrections),
    truncated,
    usage: result.usage,
    model: result.model,
  };
}

// ------------------------------------------------------------- quick check

// One sentence is all a quick check ever sends. Anything longer than this is
// not a sentence somebody just typed, it is a run-on or a pasted block, and
// the full check is the right tool for it.
export const QUICK_MAX_SENTENCE = 600;

/**
 * The words from the leave-alone list that actually appear in this sentence.
 * The quick check runs on every sentence, so sending the whole list each time
 * would be most of the request; a word that is not in the sentence cannot be
 * corrected in it anyway.
 */
export function leaveAloneFor(sentence, leaveAlone = []) {
  const lower = sentence.toLowerCase();
  return leaveAlone.filter((word) => {
    const w = String(word || '').trim().toLowerCase();
    return w && lower.includes(w) && !isSecret(w);
  });
}

/**
 * Caret's quick check: one finished sentence, sent to the Caret server's small
 * model. Issues come back with offsets relative to the sentence, so the caller
 * can place them wherever that sentence is in the field now.
 *
 * @returns {Promise<{issues: object[], model: string, left: number|undefined}>}
 * @throws {Error} with .code 'quiet' when the shared allowance or this key's
 *   quick allowance for today is used up
 */
export async function checkQuick(sentence, {
  apiKey,
  leaveAlone = [],
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!apiKey) throw Object.assign(new Error('No Caret key.'), { code: 'no-key' });
  const text = String(sentence || '');
  if (!text.trim()) return { issues: [] };
  if (text.length > QUICK_MAX_SENTENCE) {
    throw Object.assign(new Error('That is too long to be one sentence.'), { code: 'too-long' });
  }
  const result = await callCaret(maskSecrets(text), {
    apiKey,
    mode: 'quick',
    leaveAlone: leaveAloneFor(text, leaveAlone),
    fetchImpl,
    signal,
  });
  // A server from before the quick check ignores "mode" and answers with the
  // big model, which costs twenty times as much out of the shared allowance.
  // Say so instead of quietly carrying on like that.
  if (result.mode !== 'quick') {
    throw Object.assign(
      new Error("Caret's server has not been updated for the quick check yet."),
      { code: 'old-server' },
    );
  }
  const corrections = parseCorrections(result.json);
  return {
    issues: corrections ? toIssues(text, corrections) : [],
    model: result.model,
    left: result.usage && result.usage.left,
  };
}
