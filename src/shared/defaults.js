// Settings shape, shared by the service worker, the popup and the options page.

export const STORAGE_KEY = 'settings';

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
  checkNames: false,     // flag capitalized words we do not recognize
  showBadge: true,       // the little count in the corner of the field
  underlineStyle: 'straight',   // or 'wavy'
  aiEnabled: false,
  aiKey: '',
  // Cheapest model and lowest effort by default: this runs while you type, so
  // the bill is what matters most. The options page explains the trade.
  aiModel: 'claude-haiku-4-5',
  aiEffort: 'low',
  aiTrigger: 'manual',   // 'manual' = only when you ask; 'auto' = as you type
  aiDailyLimit: 40,      // hard stop, per day, whatever the trigger
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
