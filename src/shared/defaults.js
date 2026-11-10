// Settings shape, shared by the service worker, the popup and the options page.

export const STORAGE_KEY = 'settings';

// The free options run on an allowance somebody else is paying for - Caret's
// own server shares one between everybody, and Google rate limits its free
// tier - so Caret holds each install to this many checks a day. It is counted
// here, in the extension, per person: the server is not asked to police it.
//
// A paid key is the user's own money and their own decision, so it is not
// capped at all. 0 means no limit.
export const MAX_FREE_DAILY = 50;
export const FREE_PROVIDERS = new Set(['caret', 'gemini']);

/** The most checks a day this provider may be set to. 0 means no limit. */
export function dailyCeiling(provider) {
  return FREE_PROVIDERS.has(provider) ? MAX_FREE_DAILY : 0;
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
  // Hard stop per day, whatever the trigger. The free options are shared or
  // rate limited, so this is capped rather than open-ended.
  aiDailyLimit: MAX_FREE_DAILY,
  aiUsage: { day: '', count: 0 },
  disabledSites: [],
  customWords: [],
  ignored: [],
  stats: { checks: 0, issues: 0, aiCalls: 0, aiErrors: 0 },
  lastAiError: '',
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
  merged.autocorrect = { ...DEFAULT_SETTINGS.autocorrect, ...((stored && stored.autocorrect) || {}) };
  merged.disabledSites = Array.isArray(merged.disabledSites) ? merged.disabledSites : [];
  merged.customWords = Array.isArray(merged.customWords) ? merged.customWords : [];
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
