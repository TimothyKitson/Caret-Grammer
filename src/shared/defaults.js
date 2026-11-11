// Settings shape, shared by the service worker, the popup and the options page.

export const STORAGE_KEY = 'settings';

// The free options run on an allowance somebody else is paying for, so Caret
// holds each install to a number of checks a day. It is counted here, in the
// extension, per person: the server is not asked to police it.
//
// Caret's own server shares one small free allowance between everybody, and
// its big model is the expensive part of it, so the full check is held to 20
// a day. Google's free tier belongs to the person's own Google account, so it
// gets more room. A paid key is the user's own money and their own decision,
// so it is not capped at all. 0 means no limit.
export const FREE_CEILINGS = { caret: 20, gemini: 50 };
export const MAX_FREE_DAILY = Math.max(...Object.values(FREE_CEILINGS));
export const FREE_PROVIDERS = new Set(Object.keys(FREE_CEILINGS));
export const PAID_PROVIDERS = new Set(['openai', 'anthropic']);

/**
 * The most checks a day this provider may be set to. 0 means no limit.
 * Only a known paid provider is uncapped; anything else, including "not
 * picked yet", gets the tightest free ceiling.
 */
export function dailyCeiling(provider) {
  if (PAID_PROVIDERS.has(provider)) return 0;
  return FREE_CEILINGS[provider] ?? FREE_CEILINGS.caret;
}

// The quick check: Caret's small model looks at each sentence as you finish
// it. It is cheap enough to allow far more of them than the full check, but it
// still comes out of the same shared allowance, so it has its own cap. New
// installs start at 30 a day; people can raise it, never past 80.
export const QUICK_DEFAULT_DAILY = 30;
export const QUICK_MAX_DAILY = 80;

/** A quick-check limit someone typed, made safe: a whole number from 1 to 80. */
export function clampQuickLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return n === 0 ? 1 : QUICK_DEFAULT_DAILY;
  return Math.min(QUICK_MAX_DAILY, n);
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  categories: {
    spelling: true,
    grammar: true,
    punctuation: true,
    style: true,
    advanced: false,     // passive voice, filler words, comma advice
  },
  // Fixing text without being asked is a bigger thing than underlining it, so
  // this is off until someone turns it on.
  autocorrect: {
    enabled: false,
    capitalizeI: true,
    sentenceCaps: true,
    apostrophes: true,
    commonTypos: true,
  },
  // Turn the browser's own red squiggles off in fields Caret is checking, so
  // there are not two sets of underlines disagreeing with each other.
  quietOthers: true,
  checkNames: false,     // flag capitalized words we do not recognize
  showBadge: true,       // the little count in the corner of the field
  underlineStyle: 'straight',   // or 'wavy'
  aiEnabled: false,
  // Left empty when the key is baked into src/shared/apikey.js, which is what
  // turns the settings page from a key box into a single switch.
  aiKey: '',
  // Cheapest model and lowest effort by default: this runs while you type, so
  // the bill is what matters most. The options page explains the trade.
  aiModel: '',           // empty = the cheapest one for whichever key is set
  aiEffort: 'low',
  // 'manual'   only when you ask - the keyboard shortcut, or the toolbar button
  // 'interval' every few minutes while you are typing in a field
  // 'auto'     after every pause in typing (the expensive one)
  aiTrigger: 'manual',
  aiIntervalMinutes: 1,
  // Which service to use. Empty means "work it out from the key", which is how
  // it behaved before there was a chooser.
  aiProvider: '',
  // Hard stop per day, whatever the trigger. 0 means "the default for this
  // provider": the free ceiling on a free option, no limit on a paid key.
  aiDailyLimit: 0,
  aiUsage: { day: '', count: 0 },
  // The quick check after each sentence. Off until someone turns it on: it
  // sends each finished sentence to Caret's server.
  quickAiEnabled: false,
  quickAiDailyLimit: QUICK_DEFAULT_DAILY,
  quickAiUsage: { day: '', count: 0 },
  // A caret_ key someone pasted, kept apart from aiKey so the quick check can
  // still use it while another AI is picked for the full check.
  caretKey: '',
  disabledSites: [],
  customWords: [],
  // Words added from a card where they started a sentence ("Jaxon went
  // home."), in lower case. Their capital may only be the sentence's, so a
  // lower-case use is only questioned where the sentence clearly means a name.
  softCapWords: [],
  ignored: [],
  stats: { checks: 0, issues: 0, aiCalls: 0, aiErrors: 0, quickCalls: 0 },
  lastAiError: '',
  lastQuickError: '',
};

export const AUTOCORRECT_INFO = [
  { key: 'capitalizeI', label: 'Capitalize “I”', hint: '“i” and “ive” become “I” and “I’ve”. Never “ill” or “id” — those are words.' },
  { key: 'sentenceCaps', label: 'Capitalize the first word of a sentence', hint: 'After a full stop, a question mark or a new line. Not after “Dr.” or an ellipsis.' },
  { key: 'apostrophes', label: 'Add missing apostrophes', hint: 'dont → don’t, wouldnt → wouldn’t, youre → you’re. Only where the word is not something else.' },
  { key: 'commonTypos', label: 'Fix well-known typos', hint: 'teh → the, recieve → receive. Only typos with a single documented correction.' },
];

export const AI_PROVIDER_INFO = [
  {
    value: 'caret',
    label: 'Caret',
    tag: 'free',
    hint: 'Free, and there is nothing to sign up for. It runs on a small shared '
      + 'allowance, so there is a limit on how many checks a day you get — and if '
      + 'everyone uses it up, it goes quiet until midnight UTC and the built-in '
      + 'checks carry on as normal. Needs a key starting caret_, unless this copy '
      + 'already has one.',
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    tag: 'free tier',
    hint: 'Your own key from aistudio.google.com/apikey. No card and no credits, '
      + 'with a cap per minute and per day that proofreading one field at a time '
      + 'does not come near. Keys start AIza.',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    tag: 'paid',
    hint: 'Your own key. Pay as you go — you have to buy credits before it does '
      + 'anything, and there is no free allowance. Keys start sk-.',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    tag: 'paid',
    hint: 'Your own key, also pay as you go. Keys start sk-ant-.',
  },
];

export const AI_TRIGGER_INFO = [
  {
    value: 'manual',
    label: 'Only when I ask',
    hint: 'Right-click and choose “Proofread with AI”, press Ctrl+Shift+. , or use the Caret button. Nothing is sent until you do.',
  },
  {
    value: 'interval',
    label: 'Every minute while I am typing',
    hint: 'One check a minute at most, and only in a field you are actually working in. Stops as soon as you leave it.',
  },
  {
    value: 'auto',
    label: 'After every pause in typing',
    hint: 'The most thorough and by far the most expensive. Watch the daily limit.',
  },
];

export const CATEGORY_INFO = [
  { key: 'spelling', label: 'Spelling', hint: 'Misspelled and unknown words.' },
  { key: 'grammar', label: 'Grammar', hint: 'Confused words, verb forms, agreement, articles, capitals.' },
  { key: 'punctuation', label: 'Punctuation', hint: 'Apostrophes, spacing, repeated marks.' },
  { key: 'style', label: 'Clarity', hint: 'Wordy or redundant phrases.' },
  { key: 'advanced', label: 'Extra picky', hint: 'Passive voice, filler words, missing commas. Noisier.' },
];

export function mergeSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  merged.categories = { ...DEFAULT_SETTINGS.categories, ...((stored && stored.categories) || {}) };
  merged.stats = { ...DEFAULT_SETTINGS.stats, ...((stored && stored.stats) || {}) };
  merged.aiUsage = { ...DEFAULT_SETTINGS.aiUsage, ...((stored && stored.aiUsage) || {}) };
  merged.quickAiUsage = { ...DEFAULT_SETTINGS.quickAiUsage, ...((stored && stored.quickAiUsage) || {}) };
  merged.quickAiDailyLimit = clampQuickLimit(merged.quickAiDailyLimit);
  merged.quickAiEnabled = merged.quickAiEnabled === true;
  merged.autocorrect = { ...DEFAULT_SETTINGS.autocorrect, ...((stored && stored.autocorrect) || {}) };
  merged.disabledSites = Array.isArray(merged.disabledSites) ? merged.disabledSites : [];
  merged.customWords = Array.isArray(merged.customWords) ? merged.customWords : [];
  merged.softCapWords = Array.isArray(merged.softCapWords) ? merged.softCapWords : [];
  merged.ignored = Array.isArray(merged.ignored) ? merged.ignored : [];
  return merged;
}

/** The hostname we key the per-site switch on. */
export function siteKey(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '') || 'local';
  } catch (_) {
    return 'local';
  }
}

/**
 * Whatever someone pasted into "Turn Caret off on these sites", as a bare
 * hostname: a full address, a domain, "www." or "*." in front, a path or a
 * port after - all of it comes down to "ignitiaschools.com". '' if it is not
 * something that could be a website.
 */
export function normalizeSite(input) {
  let text = String(input || '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^\*\./, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let host;
  try {
    host = new URL(text).hostname;
  } catch (_) {
    return '';
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // A dot and only the characters a hostname can have; or localhost.
  if (host !== 'localhost' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return '';
  return host;
}

/**
 * Is this address on the list? A site on the list covers every subdomain
 * under it, so "ignitiaschools.com" also turns Caret off on
 * "englewoodfl.ignitiaschools.com".
 */
export function siteBlocked(list, href) {
  return blockingEntries(list, href).length > 0;
}

/**
 * Does this list entry cover this host? 'local' stands for files and other
 * pages with no host at all, so it only ever matches itself - not every
 * printer.local and myapp.local on the network.
 */
export function entryCovers(entry, host) {
  if (!entry) return false;
  return host === entry || (entry !== 'local' && host.endsWith(`.${entry}`));
}

/** The entries on the list that cover this address. */
export function blockingEntries(list, href) {
  const host = siteKey(href);
  return (list || []).filter((entry) => entryCovers(entry, host));
}

/**
 * The word list with this word added, keeping the capitals it was typed with.
 * Words are matched without regard to case, so adding "Ignitia" when
 * "ignitia" is already there swaps in the capitalized one rather than keeping
 * both. Returns the same array when nothing changes.
 */
export function addCustomWord(list, word) {
  const form = String(word || '').trim();
  const current = Array.isArray(list) ? list : [];
  if (!form || form.length > 60) return current;
  const lower = form.toLowerCase();
  const existing = current.find((w) => String(w).toLowerCase() === lower);
  if (existing === form) return current;
  // An all-lower-case entry is replaced by one with capitals; one with
  // capitals is not undone by a lower-case add (that came from a card on a
  // lower-case use, which is exactly what the capital is there to catch).
  if (existing && form === lower) return current;
  return [...current.filter((w) => String(w).toLowerCase() !== lower), form]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
