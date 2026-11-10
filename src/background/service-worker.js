// The service worker owns everything the page must not touch: the dictionary
// (too big to load per frame), the API key, and the settings.
//
// It is a module worker, so it can import the engine directly. Chrome shuts it
// down when idle and starts it again on the next message; the dictionary is
// rebuilt on demand, which takes about half a second once per wake-up.

import { DEFAULT_SETTINGS, STORAGE_KEY, mergeSettings, siteKey } from '../shared/defaults.js';
import { createDictionary } from '../engine/dictionary.js';
import { check } from '../engine/engine.js';
import { checkWithAi, DEFAULT_MODEL } from '../engine/ai.js';
import { BUILT_IN_KEY, providerFor } from '../shared/apikey.js';

const DATA = {
  words: 'data/words.txt',
  frequency: 'data/frequency.txt',
  properNouns: 'data/propernouns.txt',
  misspellings: 'data/misspellings.json',
};

let dictionaryPromise = null;
let settingsCache = null;
let statsDirty = false;
let statsTimer = null;

// ---------------------------------------------------------------- dictionary

// Plain text on purpose: an extension package may not contain a compressed
// file, and the browser has already decompressed the download by the time
// these are read anyway.
async function readList(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`cannot read ${path}`);
  return response.text();
}

function getDictionary() {
  if (!dictionaryPromise) {
    dictionaryPromise = (async () => {
      const [wordsText, frequencyText, properNounsText, misspellings] = await Promise.all([
        readList(DATA.words),
        readList(DATA.frequency),
        readList(DATA.properNouns),
        fetch(chrome.runtime.getURL(DATA.misspellings)).then((r) => r.json()),
      ]);
      return createDictionary({ wordsText, frequencyText, properNounsText, misspellings });
    })().catch((error) => {
      dictionaryPromise = null;
      throw error;
    });
  }
  return dictionaryPromise;
}

// ------------------------------------------------------------------ settings

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settingsCache = mergeSettings(stored[STORAGE_KEY]);
  return settingsCache;
}

async function saveSettings(next) {
  settingsCache = mergeSettings(next);
  await chrome.storage.local.set({ [STORAGE_KEY]: settingsCache });
  return settingsCache;
}

async function patchSettings(patch) {
  const current = await getSettings();
  return saveSettings({ ...current, ...patch });
}

function bumpStats(patch) {
  if (!settingsCache) return;
  const stats = settingsCache.stats;
  for (const [key, value] of Object.entries(patch)) {
    stats[key] = (stats[key] || 0) + value;
  }
  statsDirty = true;
  if (!statsTimer) {
    // Counters are not worth a storage write per keystroke.
    statsTimer = setTimeout(async () => {
      statsTimer = null;
      if (!statsDirty || !settingsCache) return;
      statsDirty = false;
      await chrome.storage.local.set({ [STORAGE_KEY]: settingsCache });
    }, 10000);
  }
}

/** hrefs is [this frame, the page embedding it]; either one can turn it off. */
function siteEnabled(settings, hrefs) {
  const list = Array.isArray(hrefs) ? hrefs : [hrefs || ''];
  return !list.some((href) => href && settings.disabledSites.includes(siteKey(href)));
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (tab.id
    ? chrome.tabs.sendMessage(tab.id, message).catch(() => {})
    : Promise.resolve())));
}

// ------------------------------------------------------------------ AI layer

const aiCache = new Map();       // text -> issues
const AI_CACHE_MAX = 40;
const AI_MIN_GAP_MS = 1200;
let aiLastCall = 0;
let aiRecent = [];               // timestamps, for a per-minute ceiling
const AI_MAX_PER_MINUTE = 20;

/**
 * Which key, which provider, which model.
 *
 * A key pasted into the options page wins over one baked into the build, so a
 * baked-in key can always be overridden without editing the extension. The
 * provider comes from the key itself - sk-ant-… is Anthropic, anything else
 * starting sk- is OpenAI - so there is no provider setting to get wrong.
 */
function aiCredentials(settings) {
  const key = (settings.aiKey || '').trim() || BUILT_IN_KEY;
  const provider = providerFor(key);
  const model = settings.aiModel || (provider ? DEFAULT_MODEL[provider] : '');
  return { key, provider, model, baked: !settings.aiKey && !!BUILT_IN_KEY };
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/** How many AI requests are left today. */
function budgetLeft(settings) {
  const usage = settings.aiUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  return Math.max(0, (settings.aiDailyLimit || 0) - used);
}

async function spendBudget(settings) {
  const usage = settings.aiUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  await patchSettings({ aiUsage: { day: today(), count: used + 1 } });
}

/**
 * The words this writer has already said to leave alone.
 *
 * Two deliberate signals, never a guess: words they added to their dictionary,
 * and the exact text of corrections they pressed Ignore on. The ignore list is
 * stored as "rule-id:text", so the text is everything after the first colon.
 *
 * Newest first, because the thing they dismissed this morning matters more
 * than one from six months ago if the list has to be cut short.
 */
function leaveAloneList(settings) {
  const out = [];
  for (const entry of [...(settings.ignored || [])].reverse()) {
    const text = String(entry).slice(String(entry).indexOf(':') + 1).trim();
    if (text) out.push(text);
  }
  for (const word of [...(settings.customWords || [])].reverse()) {
    if (word) out.push(String(word));
  }
  return out;
}

/** @returns {{issues: object[], ran: boolean}} ran=false means try again later. */
async function aiIssuesFor(text, settings) {
  if (aiCache.has(text)) return { issues: aiCache.get(text), ran: true };
  const now = Date.now();
  aiRecent = aiRecent.filter((t) => now - t < 60000);
  if (now - aiLastCall < AI_MIN_GAP_MS || aiRecent.length >= AI_MAX_PER_MINUTE) {
    return { issues: [], ran: false };
  }
  if (budgetLeft(settings) <= 0) {
    await patchSettings({
      lastAiError: `Daily limit of ${settings.aiDailyLimit} AI checks reached. It resets tomorrow, or raise it in settings.`,
    });
    return { issues: [], ran: false, capped: true };
  }
  aiLastCall = now;
  aiRecent.push(now);
  try {
    const { key, provider, model } = aiCredentials(settings);
    const result = await checkWithAi(text, {
      apiKey: key,
      provider,
      model,
      effort: settings.aiEffort,
      leaveAlone: leaveAloneList(settings),
    });
    if (aiCache.size >= AI_CACHE_MAX) aiCache.clear();
    aiCache.set(text, result.issues);
    bumpStats({ aiCalls: 1 });
    await spendBudget(settings);
    if (settingsCache && settingsCache.lastAiError) {
      await patchSettings({ lastAiError: '' });
    }
    return { issues: result.issues, ran: true };
  } catch (error) {
    // Running out of a shared free allowance is an ordinary pause, not a
    // fault: the local checks carry on and it works again tomorrow. Showing it
    // as an error every time would train people to ignore the error line.
    if (error.code === 'quiet') {
      await patchSettings({ lastAiError: '' });
      return { issues: [], ran: false };
    }
    bumpStats({ aiErrors: 1 });
    await spendBudget(settings);      // a failed call still costs a request
    await patchSettings({ lastAiError: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${error.message}` });
    return { issues: [], ran: false };
  }
}

// ------------------------------------------------------------------ checking

async function setTabBadge(sender, count) {
  if (!sender || !sender.tab || sender.frameId !== 0) return;
  try {
    await chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: count > 0 ? String(Math.min(count, 99)) : '',
    });
    await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#c0332e' });
  } catch (_) { /* tab closed */ }
}

async function handleCheck(message, sender) {
  const settings = await getSettings();
  if (!settings.enabled || !siteEnabled(settings, message.hrefs || message.href || '')) {
    await setTabBadge(sender, 0);
    return { issues: [], stats: null };
  }
  const text = typeof message.text === 'string' ? message.text : '';
  if (!text.trim()) {
    await setTabBadge(sender, 0);
    return { issues: [], stats: null };
  }

  let dictionary;
  try {
    dictionary = await getDictionary();
  } catch (error) {
    return { issues: [], error: `dictionary: ${error.message}` };
  }
  dictionary.setUserWords(settings.customWords);

  let extra = [];
  let aiRan = false;
  if (message.wantAi && settings.aiEnabled && aiCredentials(settings).key) {
    const outcome = await aiIssuesFor(text, settings);
    extra = outcome.issues;
    aiRan = outcome.ran;
  } else if (settings.aiEnabled && aiCredentials(settings).key && aiCache.has(text)) {
    extra = aiCache.get(text);
  }

  const result = check(text, { dict: dictionary }, {
    categories: settings.categories,
    checkNames: settings.checkNames,
    ignored: new Set(settings.ignored),
  }, extra);

  bumpStats({ checks: 1, issues: result.issues.length });
  await setTabBadge(sender, result.issues.length);
  return { issues: result.issues, stats: result.stats, aiRan };
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    switch (message && message.type) {
      case 'get-state': {
        const settings = await getSettings();
        respond({
          settings: {
            enabled: settings.enabled,
            categories: settings.categories,
            checkNames: settings.checkNames,
            quietOthers: settings.quietOthers,
            showBadge: settings.showBadge,
            underlineStyle: settings.underlineStyle,
            autocorrect: settings.autocorrect,
            customWords: settings.customWords,
            aiEnabled: !!(settings.aiEnabled && aiCredentials(settings).key),
            aiTrigger: settings.aiTrigger,
            aiIntervalMinutes: settings.aiIntervalMinutes,
          },
          siteEnabled: siteEnabled(settings, message.hrefs || message.href || ''),
          site: siteKey((message.hrefs && message.hrefs[0]) || message.href || ''),
        });
        return;
      }
      case 'check':
        respond(await handleCheck(message, sender));
        return;
      case 'autocorrect-word': {
        // One documented correction, and the word is not a word in its own
        // right. Anything less certain than that stays an underline.
        const settings = await getSettings();
        const word = String(message.word || '');
        const lower = word.toLowerCase();
        if (!settings.autocorrect || !settings.autocorrect.enabled
            || settings.autocorrect.commonTypos === false
            || settings.customWords.includes(lower)
            || settings.ignored.includes(`spelling-known-typo:${lower}`)) {
          respond({ fix: null });
          return;
        }
        let dictionary;
        try {
          dictionary = await getDictionary();
        } catch (_) {
          respond({ fix: null });
          return;
        }
        dictionary.setUserWords(settings.customWords);
        const corrections = dictionary.correctionsFor(lower);
        if (!corrections || corrections.length !== 1 || dictionary.hasExact(lower)) {
          respond({ fix: null });
          return;
        }
        const fix = corrections[0];
        // Keep the writer's capitalization: Teh -> The.
        const cased = word === word.toUpperCase() && word.length > 1
          ? fix.toUpperCase()
          : (/^[A-Z]/.test(word) ? fix.charAt(0).toUpperCase() + fix.slice(1) : fix);
        respond({ fix: cased === word ? null : cased });
        return;
      }
      case 'add-word': {
        const settings = await getSettings();
        const word = String(message.word || '').trim();
        if (word && !settings.customWords.includes(word.toLowerCase())) {
          await saveSettings({
            ...settings,
            customWords: [...settings.customWords, word.toLowerCase()].sort(),
          });
        }
        aiCache.clear();
        respond({ ok: true });
        return;
      }
      case 'ignore-issue': {
        const settings = await getSettings();
        const key = `${message.id}:${String(message.text || '').toLowerCase()}`;
        if (!settings.ignored.includes(key)) {
          await saveSettings({ ...settings, ignored: [...settings.ignored, key] });
        }
        respond({ ok: true });
        return;
      }
      case 'get-settings': {
        const settings = await getSettings();
        const { key, provider, baked } = aiCredentials(settings);
        respond({
          settings,
          aiLeftToday: budgetLeft(settings),
          // Never the key itself - only what the settings page needs to know
          // to decide between a switch and a key box.
          ai: { provider, baked, hasKey: !!key },
        });
        return;
      }
      case 'reset-settings': {
        const saved = await saveSettings({ ...DEFAULT_SETTINGS });
        aiCache.clear();
        await broadcast({ type: 'settings-changed' });
        respond({ settings: saved });
        return;
      }
      case 'preview': {
        // The settings page checks one fixed sentence so it can show what the
        // current settings actually do. No stats, no badge, no AI.
        const settings = await getSettings();
        const text = typeof message.text === 'string' ? message.text : '';
        if (!settings.enabled || !text.trim()) { respond({ issues: [] }); return; }
        try {
          const dictionary = await getDictionary();
          dictionary.setUserWords(settings.customWords);
          const result = check(text, { dict: dictionary }, {
            categories: settings.categories,
            checkNames: settings.checkNames,
            ignored: new Set(settings.ignored),
          });
          respond({ issues: result.issues });
        } catch (error) {
          respond({ issues: [], error: error.message });
        }
        return;
      }
      case 'patch-settings': {
        // Merge, never replace: the options page may be holding a snapshot
        // from before you added a word from a card on some other tab.
        const current = await getSettings();
        const patch = message.patch || {};
        const next = { ...current, ...patch };
        if (patch.categories) next.categories = { ...current.categories, ...patch.categories };
        if (patch.autocorrect) next.autocorrect = { ...current.autocorrect, ...patch.autocorrect };
        const saved = await saveSettings(next);
        aiCache.clear();
        await broadcast({ type: 'settings-changed' });
        respond({ settings: saved });
        return;
      }
      case 'toggle-site': {
        const settings = await getSettings();
        const key = siteKey((message.hrefs && message.hrefs[0]) || message.href || '');
        const disabled = settings.disabledSites.includes(key);
        await saveSettings({
          ...settings,
          disabledSites: disabled
            ? settings.disabledSites.filter((s) => s !== key)
            : [...settings.disabledSites, key],
        });
        await broadcast({ type: 'settings-changed' });
        respond({ siteEnabled: disabled, site: key });
        return;
      }
      case 'test-ai': {
        const settings = await getSettings();
        if (!aiCredentials(settings).key) { respond({ error: 'No API key. Put one in the box, or bake one into src/shared/apikey.js.' }); return; }
        try {
          const { key, provider, model } = aiCredentials(settings);
          const result = await checkWithAi(
            'Their is to many mistake in this sentance, and i has not fixed it yet.',
            { apiKey: key, provider, model, effort: settings.aiEffort, leaveAlone: leaveAloneList(settings) },
          );
          await patchSettings({ lastAiError: '' });
          respond({ ok: true, found: result.issues.length, model: result.model });
        } catch (error) {
          respond({ error: error.message });
        }
        return;
      }
      case 'open-options':
        await chrome.runtime.openOptionsPage();
        respond({ ok: true });
        return;
      default:
        respond({ ok: false });
    }
  })().catch((error) => respond({ error: String(error && error.message) }));
  return true;   // keep the channel open for the async work above
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    settingsCache = mergeSettings(changes[STORAGE_KEY].newValue);
  }
});

// ------------------------------------------------------------- menus and keys

const MENUS = [
  // Named for what it does rather than what it is, because this is the one
  // people reach for when they do not want to learn a shortcut.
  { id: 'gc-proofread-ai', title: 'Proofread with AI', contexts: ['editable'] },
  { id: 'gc-check-now', title: 'Check this field now', contexts: ['editable'] },
  { id: 'gc-toggle-site', title: 'Turn checking on or off for this site', contexts: ['editable', 'page'] },
  { id: 'gc-options', title: 'Caret settings…', contexts: ['editable', 'page', 'action'] },
];

// Uninstalling opens the feedback page, with the version so a report says
// which build it came from. Nothing else is attached: no id, no history.
function setUninstallPage() {
  try {
    const version = chrome.runtime.getManifest().version;
    chrome.runtime.setUninstallURL(
      `https://caretgrammar.com/report?from=uninstall&v=${encodeURIComponent(version)}`,
    );
  } catch (_) { /* not fatal */ }
}

chrome.runtime.onStartup.addListener(setUninstallPage);

chrome.runtime.onInstalled.addListener(async (details) => {
  setUninstallPage();
  chrome.contextMenus.removeAll(() => {
    for (const menu of MENUS) chrome.contextMenus.create(menu);
  });
  await getSettings();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  getDictionary().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'gc-options') {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'gc-proofread-ai') {
    const settings = await getSettings();
    // Asking for the AI pass with no AI set up should say so, not look broken.
    if (!settings.aiEnabled || !aiCredentials(settings).key) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'check-now' }, { frameId: info.frameId })
      .catch(() => {});
    return;
  }
  if (info.menuItemId === 'gc-check-now') {
    chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'check-now' }, { frameId: info.frameId })
      .catch(() => {});
    return;
  }
  if (info.menuItemId === 'gc-toggle-site') {
    const settings = await getSettings();
    const key = siteKey(info.pageUrl || tab.url || '');
    const disabled = settings.disabledSites.includes(key);
    await saveSettings({
      ...settings,
      disabledSites: disabled
        ? settings.disabledSites.filter((s) => s !== key)
        : [...settings.disabledSites, key],
    });
    await broadcast({ type: 'settings-changed' });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-enabled') {
    const settings = await getSettings();
    await saveSettings({ ...settings, enabled: !settings.enabled });
    await broadcast({ type: 'settings-changed' });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'command', name: command }).catch(() => {});
});
