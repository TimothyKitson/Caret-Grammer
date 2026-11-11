// The service worker owns everything the page must not touch: the dictionary
// (too big to load per frame), the API key, and the settings.
//
// It is a module worker, so it can import the engine directly. Chrome shuts it
// down when idle and starts it again on the next message; the dictionary is
// rebuilt on demand, which takes about half a second once per wake-up.

import {
  DEFAULT_SETTINGS, STORAGE_KEY, mergeSettings, siteKey, dailyCeiling, clampQuickLimit,
  siteBlocked, blockingEntries, addCustomWord,
} from '../shared/defaults.js';
import { createDictionary } from '../engine/dictionary.js';
import { check } from '../engine/engine.js';
import {
  checkWithAi, checkQuick, DEFAULT_MODEL, QUICK_MAX_SENTENCE,
} from '../engine/ai.js';
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
  return !list.some((href) => href && siteBlocked(settings.disabledSites, href));
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
  const typed = (settings.aiKey || '').trim();
  const chosen = settings.aiProvider || '';

  // Nothing chosen: work it out from whatever key there is, which is how this
  // behaved before there was a chooser.
  if (!chosen) {
    const key = typed || BUILT_IN_KEY;
    const provider = providerFor(key);
    return {
      key, provider, chosen,
      model: settings.aiModel || (provider ? DEFAULT_MODEL[provider] : ''),
      baked: !typed && !!BUILT_IN_KEY,
    };
  }

  // Caret's own server. A key baked into this copy is used first, so most
  // people never see a key box at all.
  if (chosen === 'caret') {
    const key = providerFor(BUILT_IN_KEY) === 'caret' ? BUILT_IN_KEY
      : providerFor(typed) === 'caret' ? typed : '';
    return { key, provider: 'caret', chosen, model: '', baked: key === BUILT_IN_KEY && !!key };
  }

  // A named provider needs a key that belongs to it. Pasting a Google key
  // while OpenAI is selected should read as "no key yet", not fail at the API.
  const key = providerFor(typed) === chosen ? typed : '';
  return {
    key,
    provider: chosen,
    chosen,
    model: settings.aiModel || DEFAULT_MODEL[chosen] || '',
    baked: false,
  };
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/**
 * How many AI requests are left today. Infinity means no limit.
 *
 * The ceiling is applied here as well as in the settings page, so a stored
 * number from an older version - or an edited one - cannot lift a free
 * provider's cap.
 */
function budgetLeft(settings, provider) {
  const ceiling = dailyCeiling(provider || aiCredentials(settings).provider);
  let limit = Number(settings.aiDailyLimit) || 0;
  if (ceiling > 0) limit = limit > 0 ? Math.min(limit, ceiling) : ceiling;
  if (limit <= 0) return Infinity;
  const usage = settings.aiUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  return Math.max(0, limit - used);
}

async function spendBudget(settings) {
  const usage = settings.aiUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  await patchSettings({ aiUsage: { day: today(), count: used + 1 } });
}

// ------------------------------------------------------------- quick check

// The quick check runs on Caret's own server whatever AI is picked for the
// full check, so it needs a Caret key of its own: the one baked into this copy,
// or a caret_ key pasted into the settings.
function caretKey(settings) {
  if (providerFor(BUILT_IN_KEY) === 'caret') return BUILT_IN_KEY;
  const typed = (settings.aiKey || '').trim();
  return providerFor(typed) === 'caret' ? typed : '';
}

/** Quick checks left today, never more than the person's own limit (1-80). */
function quickLeft(settings) {
  const limit = clampQuickLimit(settings.quickAiDailyLimit);
  const usage = settings.quickAiUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  return Math.max(0, limit - used);
}

const quickCache = new Map();        // sentence -> issues relative to it
const QUICK_CACHE_MAX = 400;
const QUICK_MIN_GAP_MS = 300;
const QUICK_MAX_PER_MINUTE = 30;     // a burst guard; the daily limit is the real cap
const QUICK_OLD_SERVER_WAIT = 6 * 60 * 60 * 1000;
let quickRecent = [];
let quickChain = Promise.resolve();  // one quick check at a time, in order

/**
 * Check one sentence with the quick model. Requests are run one after another
 * so two finished sentences cannot both read the same "left today" and both
 * spend the last check.
 */
function quickCheck(sentence) {
  const run = quickChain.then(() => runQuickCheck(sentence));
  quickChain = run.catch(() => {});
  return run;
}

async function runQuickCheck(sentence) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.quickAiEnabled) return { skipped: true };
  const text = typeof sentence === 'string' ? sentence : '';
  if (!text.trim() || text.length > QUICK_MAX_SENTENCE) return { skipped: true };
  if (quickCache.has(text)) return { issues: quickCache.get(text), cached: true };
  const key = caretKey(settings);
  if (!key) return { error: 'This copy has no Caret key, so the quick check cannot run.' };
  if (quickLeft(settings) <= 0) return { capped: true };
  // The server answered a quick check with the big model recently: it has not
  // been updated. Every further try would spend the expensive allowance, so
  // wait a few hours before asking again.
  if (Date.now() - (Number(settings.quickServerOldAt) || 0) < QUICK_OLD_SERVER_WAIT) return { paused: true };

  const since = Date.now() - QUICK_MIN_GAP_MS;
  const last = quickRecent[quickRecent.length - 1] || 0;
  if (last > since) await new Promise((r) => setTimeout(r, last - since));
  // More than a person could type in a minute: wait for the window to clear
  // rather than drop the sentence, which would never be asked about again.
  quickRecent = quickRecent.filter((t) => Date.now() - t < 60000);
  if (quickRecent.length >= QUICK_MAX_PER_MINUTE) {
    await new Promise((r) => setTimeout(r, 60000 - (Date.now() - quickRecent[0]) + 10));
    quickRecent = quickRecent.filter((t) => Date.now() - t < 60000);
  }
  quickRecent.push(Date.now());

  try {
    const result = await checkQuick(text, { apiKey: key, leaveAlone: leaveAloneList(settings) });
    if (quickCache.size >= QUICK_CACHE_MAX) quickCache.delete(quickCache.keys().next().value);
    quickCache.set(text, result.issues);
    const usage = settings.quickAiUsage || {};
    const used = usage.day === today() ? (usage.count || 0) : 0;
    await patchSettings({
      quickAiUsage: { day: today(), count: used + 1 },
      ...(settings.lastQuickError ? { lastQuickError: '' } : {}),
    });
    bumpStats({ quickCalls: 1 });
    return { issues: result.issues };
  } catch (error) {
    // Out of the shared allowance, or this key's quick checks for today: an
    // ordinary pause, not a fault. It does not count against the person.
    if (error.code === 'quiet') return { paused: true };
    if (error.code === 'old-server') {
      await patchSettings({ quickServerOldAt: Date.now(), lastQuickError: error.message });
      return { paused: true };
    }
    await patchSettings({
      lastQuickError: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${error.message}`,
    });
    return { error: error.message };
  }
}

/**
 * Quick-check issues the page sent along with a check, made safe: each one
 * must sit inside the text and match it, and words the person has since added
 * to their dictionary are dropped.
 */
function quickIssuesFor(text, list, settings) {
  if (!settings.quickAiEnabled || !Array.isArray(list)) return [];
  const mine = new Set((settings.customWords || []).map((w) => String(w).toLowerCase()));
  const out = [];
  for (const issue of list.slice(0, 200)) {
    if (!issue || typeof issue !== 'object') continue;
    const { start, end } = issue;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) continue;
    if (text.slice(start, end) !== issue.text) continue;
    if (mine.has(String(issue.text).toLowerCase())) continue;
    const replacements = Array.isArray(issue.replacements)
      ? issue.replacements.filter((r) => typeof r === 'string').slice(0, 3)
      : [];
    out.push({
      id: typeof issue.id === 'string' ? issue.id : 'ai-grammar',
      category: ['spelling', 'grammar', 'punctuation', 'style'].includes(issue.category) ? issue.category : 'grammar',
      short: 'AI',
      start,
      end,
      text: issue.text,
      message: String(issue.message || 'Suggested correction.').slice(0, 300),
      replacements,
      confidence: 'high',
      source: 'ai',
    });
  }
  return out;
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
    const ceiling = dailyCeiling(aiCredentials(settings).provider);
    const limit = ceiling > 0
      ? Math.min(Number(settings.aiDailyLimit) || ceiling, ceiling)
      : Number(settings.aiDailyLimit) || 0;
    await patchSettings({
      lastAiError: `That is ${limit} AI checks today. It resets tomorrow, `
        + `${ceiling > 0 ? 'or use your own paid key for no limit.' : 'or raise the limit in settings.'}`,
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
  extra = extra.concat(quickIssuesFor(text, message.quickIssues, settings));

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
            // Only true when it can actually run: switched on and a Caret key
            // to run it with.
            quickAiEnabled: !!(settings.quickAiEnabled && caretKey(settings)),
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
            || settings.customWords.some((w) => String(w).toLowerCase() === lower)
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
        const next = addCustomWord(settings.customWords, word);
        if (next !== settings.customWords) await saveSettings({ ...settings, customWords: next });
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
        const { key, provider, baked, chosen } = aiCredentials(settings);
        respond({
          settings,
          aiLeftToday: budgetLeft(settings, provider),
          quickLeftToday: quickLeft(settings),
          quick: { available: !!caretKey(settings) },
          // Never the key itself - only what the settings page needs to know
          // to decide between a switch and a key box.
          ai: {
            provider,
            chosen,
            baked,
            hasKey: !!key,
            // A key is stored but does not belong to the chosen provider.
            keyMismatch: !!(settings.aiKey || '').trim() && !key && chosen !== 'caret',
          },
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
        const href = (message.hrefs && message.hrefs[0]) || message.href || '';
        const key = siteKey(href);
        const covering = blockingEntries(settings.disabledSites, href);
        const disabled = covering.length > 0;
        await saveSettings({
          ...settings,
          // Turning it back on here lifts whatever entry was covering this
          // address, the parent domain included - otherwise the switch would
          // flip and nothing would change.
          disabledSites: disabled
            ? settings.disabledSites.filter((s) => !covering.includes(s))
            : [...settings.disabledSites, key],
        });
        await broadcast({ type: 'settings-changed' });
        respond({ siteEnabled: disabled, site: key });
        return;
      }
      case 'quick-check': {
        respond(await quickCheck(message.sentence));
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
    const href = info.pageUrl || tab.url || '';
    const key = siteKey(href);
    const covering = blockingEntries(settings.disabledSites, href);
    await saveSettings({
      ...settings,
      disabledSites: covering.length
        ? settings.disabledSites.filter((s) => !covering.includes(s))
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
