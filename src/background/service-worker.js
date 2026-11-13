// The service worker owns everything the page must not touch: the dictionary
// (too big to load per frame), the API key, and the settings.
//
// It is a module worker, so it can import the engine directly. Chrome shuts it
// down when idle and starts it again on the next message; the dictionary is
// rebuilt on demand, which takes about half a second once per wake-up.

import {
  DEFAULT_SETTINGS, STORAGE_KEY, mergeSettings, siteKey, dailyCeiling, clampQuickLimit,
  siteBlocked, blockingEntries, addCustomWord, LEARN_DELAY_MS, LEARN_DAILY,
} from '../shared/defaults.js';
import { createDictionary } from '../engine/dictionary.js';
import { check } from '../engine/engine.js';
import {
  checkWithAi, checkQuick, learnStyle, looksSensitive, DEFAULT_MODEL, QUICK_MAX_SENTENCE,
} from '../engine/ai.js';
import { MAX_LEARN_CHANGES } from '../shared/proofread.js';
import { BUILT_IN_KEY, CARET_ENDPOINT, providerFor } from '../shared/apikey.js';

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

async function refundBudget() {
  const usage = (await getSettings()).aiUsage || {};
  if (usage.day !== today() || !usage.count) return;
  await patchSettings({ aiUsage: { day: today(), count: usage.count - 1 } });
}

/** Full checks left today for the page to show: a number, or null for no limit. */
function aiLeftFor(settings) {
  const left = budgetLeft(settings);
  return Number.isFinite(left) ? left : null;
}

/** The shortcut for "Proofread with AI", as the browser has it right now. */
async function checkShortcut() {
  try {
    const command = (await chrome.commands.getAll()).find((c) => c.name === 'check-now');
    return (command && command.shortcut) || '';
  } catch (_) {
    return '';
  }
}

// ------------------------------------------------------------- quick check

// The quick check runs on Caret's own server whatever AI is picked for the
// full check, so it needs a Caret key of its own: the one baked into this copy,
// or a caret_ key pasted into the settings.
function caretKey(settings) {
  if (providerFor(BUILT_IN_KEY) === 'caret') return BUILT_IN_KEY;
  // Kept on its own when pasted, so picking another AI for the full check
  // (and pasting that AI's key) does not take the quick check's key away.
  const saved = (settings.caretKey || '').trim();
  if (providerFor(saved) === 'caret') return saved;
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
  if (!settings.quickAiEnabled) return [];
  return pageAiIssues(text, list, settings, 'quick');
}

/** Full-check findings the page kept from an earlier run, made safe the same way. */
function fullIssuesFor(text, list, settings) {
  if (!settings.aiEnabled) return [];
  return pageAiIssues(text, list, settings, 'full');
}

function pageAiIssues(text, list, settings, kind) {
  if (!Array.isArray(list)) return [];
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
    const sentence = issue.category === 'sentence';
    // Switched off since: the amber bands go with it.
    if (sentence && !settings.aiSentences) continue;
    out.push({
      id: sentence ? 'ai-sentence' : typeof issue.id === 'string' ? issue.id : 'ai-grammar',
      category: sentence || ['spelling', 'grammar', 'punctuation', 'style'].includes(issue.category)
        ? issue.category
        : 'grammar',
      short: sentence ? 'Sentence' : 'AI',
      start,
      end,
      text: issue.text,
      message: String(issue.message || 'Suggested correction.').slice(0, 300),
      replacements,
      confidence: 'high',
      source: 'ai',
      aiKind: kind,
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
    // A sentence problem waved away is a whole sentence, not a word to leave
    // alone: it stays out of every request.
    if (String(entry).startsWith('ai-sentence:')) continue;
    const text = String(entry).slice(String(entry).indexOf(':') + 1).trim();
    if (text) out.push(text);
  }
  for (const word of [...(settings.customWords || [])].reverse()) {
    if (word) out.push(String(word));
  }
  return out;
}

/** @returns {{issues: object[], ran: boolean}} ran=false means try again later. */
const AI_TIMEOUT_MS = 45000;

/** Full-check findings carry where they came from, so the page can keep them. */
const asFull = (issues) => issues.map((issue) => ({ ...issue, aiKind: 'full' }));

/** The notes on how this person writes, if they are to be used at all. */
const notesFor = (settings) => (settings.aiLearn ? settings.aiNotes || '' : '');

// A full check's answer depends on more than the text: on whether sentences
// were asked about, and on the notes it was given. Both are in the key, so a
// switch flipped or a note learned never hands back an answer to a different
// question.
const aiCacheKey = (text, settings) => `${settings.aiSentences ? 's' : 'w'}\u0000${notesFor(settings)}\u0000${text}`;

async function aiIssuesFor(text, settings) {
  const cacheKey = aiCacheKey(text, settings);
  if (aiCache.has(cacheKey)) return { issues: aiCache.get(cacheKey), ran: true, cached: true };
  const now = Date.now();
  aiRecent = aiRecent.filter((t) => now - t < 60000);
  if (now - aiLastCall < AI_MIN_GAP_MS || aiRecent.length >= AI_MAX_PER_MINUTE) {
    return { issues: [], ran: false, busy: true };
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
  // Count the check before it goes out, from the stored count rather than the
  // copy this request started with: two checks in flight at once must not
  // both write "one more than before" and so count as one.
  await spendBudget(await getSettings());
  try {
    const { key, provider, model } = aiCredentials(settings);
    const result = await checkWithAi(text, {
      apiKey: key,
      provider,
      model,
      effort: settings.aiEffort,
      leaveAlone: leaveAloneList(settings),
      sentences: !!settings.aiSentences,
      notes: notesFor(settings),
      // A check that has not answered in this long is not going to; say so
      // rather than leave the page waiting forever.
      signal: globalThis.AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    result.issues = asFull(result.issues);
    if (aiCache.size >= AI_CACHE_MAX) aiCache.clear();
    // An answer that could not be read is not this text's result: asking
    // again should really ask again.
    if (!result.unparsed) aiCache.set(cacheKey, result.issues);
    bumpStats({ aiCalls: 1 });
    if (settingsCache && settingsCache.lastAiError) {
      await patchSettings({ lastAiError: '' });
    }
    return { issues: result.issues, ran: true };
  } catch (error) {
    // Running out of a shared free allowance is an ordinary pause, not a
    // fault: the local checks carry on and it works again tomorrow. Showing it
    // as an error every time would train people to ignore the error line.
    if (error.code === 'quiet') {
      // Nothing ran, so it does not count against the person.
      await refundBudget();
      await patchSettings({ lastAiError: '' });
      return { issues: [], ran: false, quiet: true, message: error.message };
    }
    bumpStats({ aiErrors: 1 });       // a failed call still counted: it was a request
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'The AI took too long to answer. Try again in a minute.'
      : error.message;
    await patchSettings({ lastAiError: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${message}` });
    return { issues: [], ran: false, error: message };
  }
}

// ------------------------------------------------------------------ learning
//
// The model keeps nothing between requests, so Caret does the remembering.
// For each field it notes the suggestions the writer took and the ones they
// ignored. Once a full AI check has run in that field, a timer starts; when it
// goes off, those changes and the field as it is then go to the AI, which
// answers with nothing but a few lines of notes on how this person writes.
// The notes are kept in the settings, on this computer, and go with every
// full check after that (see notesFor).
//
// What is waiting to be sent lives in session storage - memory, not disk - so
// a field's text is never written down, and the timer is a browser alarm, so
// it still goes off if the tab is closed or this worker has been shut down.

const LEARN_STORE = 'learnFields';
const LEARN_ALARM = 'caret-learn';
const LEARN_MAX_FIELDS = 30;
const LEARN_MAX_TEXT = 6000;          // what the AI is sent of a field, as with a full check
// Learning from nothing but the writing, with no choices to go on, is only
// worth it the first time, and only for something longer than a line or two.
const LEARN_MIN_TEXT = 200;
const LEARN_HEALTH_TTL = 60 * 60 * 1000;

let learnChain = Promise.resolve();
let learnPass = Promise.resolve();   // one learning pass at a time
// Bumped by Forget and by a reset: a pass already under way must not save
// notes built from what was collected before.
let learnGeneration = 0;
let learnHealth = { ok: false, at: 0 };
// Returned by a change that changed nothing, so nothing is written back.
const UNCHANGED = Symbol('unchanged');

const learnSession = () => (chrome.storage && chrome.storage.session) || null;

/**
 * Read, change and write what is waiting, one change at a time: two messages
 * landing together must not both read the same list and each write back their
 * own half of it.
 */
function learnUpdate(change) {
  const run = learnChain.then(async () => {
    const area = learnSession();
    if (!area) return null;
    const store = (await area.get(LEARN_STORE))[LEARN_STORE] || {};
    const result = await change(store);
    if (result === UNCHANGED) return null;
    await area.set({ [LEARN_STORE]: store });
    return result;
  });
  learnChain = run.catch(() => {});
  return run;
}

function learningOn(settings) {
  return !!(settings.enabled && settings.aiEnabled && settings.aiLearn && aiCredentials(settings).key);
}

/** Learning requests left today. */
function learnLeft(settings) {
  const usage = settings.aiLearnUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  return Math.max(0, LEARN_DAILY - used);
}

/** Which field a message is about: this tab, this frame, this box in it. */
function learnKey(sender, fieldId) {
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number') return '';
  const field = typeof fieldId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(fieldId) ? fieldId : '';
  if (!field) return '';
  return `${sender.tab.id}:${sender.frameId || 0}:${field}`;
}

function freshRecord(hrefs) {
  return { hrefs: Array.isArray(hrefs) ? hrefs.slice(0, 2).map(String) : [], text: '', accepted: [], ignored: [], due: 0, touched: Date.now() };
}

/** Keep the store small: the fields touched least recently, and not due, go first. */
function trimLearnStore(store) {
  const keys = Object.keys(store);
  if (keys.length <= LEARN_MAX_FIELDS) return;
  keys.sort((a, b) => (Number(!!store[a].due) - Number(!!store[b].due)) || (store[a].touched - store[b].touched));
  for (const key of keys.slice(0, keys.length - LEARN_MAX_FIELDS)) delete store[key];
}

async function armLearnAlarm(store) {
  if (!chrome.alarms) return;
  const dues = Object.values(store || {}).map((r) => r.due).filter((d) => d > 0);
  if (!dues.length) {
    await chrome.alarms.clear(LEARN_ALARM);
    return;
  }
  // Replaces any alarm by the same name: one alarm, for whichever is next.
  await chrome.alarms.create(LEARN_ALARM, { when: Math.max(Date.now() + 1000, Math.min(...dues)) });
}

/** A suggestion the writer took or waved away, from the page. */
async function noteLearnEvent(message, sender) {
  const settings = await getSettings();
  if (!learningOn(settings) || !siteEnabled(settings, message.hrefs || '')) return;
  const key = learnKey(sender, message.fieldId);
  const change = message.change;
  if (!key || !change || typeof change !== 'object') return;
  const list = message.action === 'accepted' ? 'accepted' : message.action === 'ignored' ? 'ignored' : '';
  if (!list) return;
  const part = (value, max) => String(typeof value === 'string' ? value : '').slice(0, max);
  const item = {
    original: part(change.original, 160),
    replacement: part(change.replacement, 160),
    kind: part(change.kind, 20),
    note: part(change.note, 160),
  };
  if (!item.original.trim()) return;
  if ([item.original, item.replacement, item.note].some(looksSensitive)) return;
  await learnUpdate((store) => {
    const page = Array.isArray(message.hrefs) ? String(message.hrefs[0] || '') : '';
    // A record from another page is never added to: see noteLearnCheck.
    const record = store[key] && store[key].hrefs[0] === page ? store[key] : freshRecord(message.hrefs);
    // The most recent ones: what they did this minute says more than what
    // they did an hour ago, if there is only room for some.
    record[list] = [...record[list], item].slice(-MAX_LEARN_CHANGES);
    record.touched = Date.now();
    store[key] = record;
    trimLearnStore(store);
  });
}

/**
 * Called with every check of a field. A full AI check that ran starts the
 * field's timer, if it is not already going; after that, every check keeps
 * the text that will be sent up to date, so what goes is the field as it is
 * when the timer goes off.
 */
async function noteLearnCheck(message, sender, text, settings, aiRan) {
  if (!learningOn(settings)) return;
  const key = learnKey(sender, message.fieldId);
  if (!key) return;
  const clipped = text.slice(0, LEARN_MAX_TEXT);
  // Text Caret would refuse to send for a full check is not kept either: the
  // record remembers only that it cannot go, until the field is clean again.
  const secret = looksSensitive(clipped);
  const hrefs = message.hrefs || [message.href || ''];
  const page = String(hrefs[0] || '');
  await learnUpdate(async (store) => {
    let record = store[key];
    // The same tab, frame and field name on a different page is a different
    // field. (Field names are unique per page load; this is the backstop.)
    if (record && record.hrefs[0] !== page) {
      if (!aiRan) return UNCHANGED;
      record = null;
    }
    if (!aiRan) {
      // Only a field already waiting needs its text kept up to date.
      if (!record || !record.due) return UNCHANGED;
      if (record.text === (secret ? '' : clipped) && !!record.secret === secret) return UNCHANGED;
      record.text = secret ? '' : clipped;
      record.secret = secret;
      record.touched = Date.now();
      return undefined;
    }
    const next = record || freshRecord(hrefs);
    next.text = secret ? '' : clipped;
    next.secret = secret;
    next.touched = Date.now();
    if (!next.due) next.due = Date.now() + LEARN_DELAY_MS;
    store[key] = next;
    trimLearnStore(store);
    await armLearnAlarm(store);
  });
}

/** Does Caret's server know how to learn? A copy from before would run a full check instead. */
async function serverCanLearn() {
  if (Date.now() - learnHealth.at < LEARN_HEALTH_TTL) return learnHealth.ok;
  let ok = false;
  try {
    const response = await fetch(`${CARET_ENDPOINT.replace(/\/$/, '')}/health`, {
      signal: globalThis.AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    ok = !!(payload && payload.learn === true);
  } catch (_) { ok = false; }
  learnHealth = { ok, at: Date.now() };
  return ok;
}

/** Send one field's changes and text, and keep the notes that come back. */
async function learnFrom(record, generation = learnGeneration) {
  if (generation !== learnGeneration) return { skipped: 'changed' };
  const settings = await getSettings();
  if (!learningOn(settings) || !siteEnabled(settings, record.hrefs)) return { skipped: 'off' };
  const accepted = Array.isArray(record.accepted) ? record.accepted : [];
  const ignored = Array.isArray(record.ignored) ? record.ignored : [];
  const text = typeof record.text === 'string' ? record.text : '';
  // Nothing new to go on: no choices made, and notes already written.
  if (!accepted.length && !ignored.length && (settings.aiNotes || text.trim().length < LEARN_MIN_TEXT)) {
    return { skipped: 'nothing-new' };
  }
  // The full check refuses to send a field with a card number, a key or a
  // "password:" in it; so does this, rather than send it blanked out.
  if (record.secret || looksSensitive(text)
      || [...accepted, ...ignored].some((c) => [c.original, c.replacement, c.note].some(looksSensitive))) {
    return { skipped: 'secret' };
  }
  if (learnLeft(settings) <= 0) return { skipped: 'capped' };
  const { key, provider, model } = aiCredentials(settings);
  if (!key) return { skipped: 'no-key' };
  if (provider === 'caret' && (!CARET_ENDPOINT || !(await serverCanLearn()))) return { skipped: 'old-server' };

  const usage = settings.aiLearnUsage || {};
  const used = usage.day === today() ? (usage.count || 0) : 0;
  await patchSettings({ aiLearnUsage: { day: today(), count: used + 1 } });
  const before = settings.aiNotes || '';
  try {
    const result = await learnStyle(text, {
      apiKey: key,
      provider,
      model,
      effort: settings.aiEffort,
      notes: before,
      accepted,
      ignored,
      signal: globalThis.AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    const now = await getSettings();
    // Switched off, or the notes forgotten or changed, while this was out:
    // what came back was built on notes that are no longer wanted.
    if (generation !== learnGeneration || !learningOn(now) || (now.aiNotes || '') !== before) {
      return { skipped: 'changed' };
    }
    // Nothing usable came back: keep what there was rather than lose it.
    if (!result.notes) return { skipped: 'empty' };
    await patchSettings({ aiNotes: result.notes, aiNotesAt: Date.now(), lastLearnError: '' });
    aiCache.clear();
    return { learned: true };
  } catch (error) {
    if (error.code === 'quiet' || error.code === 'old-server') {
      // Nothing was learned and nothing was spent: it does not count.
      const fresh = (await getSettings()).aiLearnUsage || {};
      if (fresh.day === today() && fresh.count) {
        await patchSettings({ aiLearnUsage: { day: today(), count: fresh.count - 1 } });
      }
      if (error.code === 'old-server') learnHealth = { ok: false, at: Date.now() };
      return { skipped: error.code };
    }
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'The AI took too long to answer.'
      : error.message;
    await patchSettings({ lastLearnError: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${message}` });
    return { error: message };
  }
}

/**
 * Everything whose timer has gone off, one after another. Whole passes run
 * one at a time too: an alarm that goes off while a pass is still sending
 * waits for it, so each learn builds on the notes the one before saved.
 */
function runDueLearning() {
  const run = learnPass.then(runDueLearningNow);
  learnPass = run.catch(() => {});
  return run;
}

async function runDueLearningNow() {
  const generation = learnGeneration;
  const due = await learnUpdate(async (store) => {
    const now = Date.now();
    const ready = [];
    for (const [key, record] of Object.entries(store)) {
      // Taken out before it is sent, so a worker shut down halfway through
      // never sends the same thing twice.
      if (record.due && record.due <= now + 1000) {
        ready.push(record);
        delete store[key];
      }
    }
    await armLearnAlarm(store);
    return ready;
  });
  const results = [];
  for (const record of due || []) {
    if (generation !== learnGeneration) break;
    results.push(await learnFrom(record, generation));
  }
  return results;
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LEARN_ALARM) runDueLearning().catch(() => {});
  });
}

// A closed tab's fields with nothing waiting have nothing left to learn from.
// One that is waiting still goes when its timer does.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!learnSession()) return;
  learnUpdate((store) => {
    for (const key of Object.keys(store)) {
      if (key.startsWith(`${tabId}:`) && !store[key].due) delete store[key];
    }
  }).catch(() => {});
});

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
  dictionary.setUserWords(settings.customWords, settings.softCapWords);

  let extra = [];
  let aiRan = false;
  let ai = null;        // what happened to a full check that was asked for
  let aiFull = null;    // a fresh set of full-check findings, for the page to keep
  // What the page kept from the last full check, moved along with any edits.
  const kept = fullIssuesFor(text, message.aiIssues, settings);
  if (message.wantAi && settings.aiEnabled && aiCredentials(settings).key) {
    const outcome = await aiIssuesFor(text, settings);
    aiRan = outcome.ran;
    if (outcome.ran) {
      extra = outcome.issues;
      aiFull = outcome.issues;
    } else {
      extra = kept;      // nothing new: keep showing what was found before
    }
    ai = {
      ran: outcome.ran,
      found: outcome.ran ? outcome.issues.length : 0,
      capped: !!outcome.capped,
      quiet: !!outcome.quiet,
      busy: !!outcome.busy,
      error: outcome.error || '',
    };
  } else if (Array.isArray(message.aiIssues)) {
    extra = kept;
  } else if (settings.aiEnabled && aiCredentials(settings).key && aiCache.has(aiCacheKey(text, settings))) {
    extra = aiCache.get(aiCacheKey(text, settings));
    aiFull = extra;
  }
  extra = extra.concat(quickIssuesFor(text, message.quickIssues, settings));

  const result = check(text, { dict: dictionary }, {
    categories: settings.categories,
    checkNames: settings.checkNames,
    ignored: new Set(settings.ignored),
  }, extra);

  bumpStats({ checks: 1, issues: result.issues.length });
  await setTabBadge(sender, result.issues.length);
  await noteLearnCheck(message, sender, text, settings, aiRan).catch(() => {});
  return {
    issues: result.issues,
    stats: result.stats,
    aiRan,
    ai,
    aiFull,
    aiLeft: aiLeftFor(await getSettings()),
  };
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
            // Whether to tell the background which suggestions were taken.
            aiLearn: learningOn(settings),
          },
          siteEnabled: siteEnabled(settings, message.hrefs || message.href || ''),
          site: siteKey((message.hrefs && message.hrefs[0]) || message.href || ''),
          // The entries on the list that turn this page off, for the popup to
          // name when it is a parent domain rather than this exact site.
          blockedBy: (message.hrefs || [message.href || ''])
            .flatMap((href) => (href ? blockingEntries(settings.disabledSites, href) : [])),
          checkKeys: await checkShortcut(),
          aiLeftToday: aiLeftFor(settings),
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
        dictionary.setUserWords(settings.customWords, settings.softCapWords);
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
        // Added from a sentence start: the capital may be the sentence's.
        const lower = word.toLowerCase();
        const soft = message.atSentenceStart && /^[A-Z][a-z'’-]*$/.test(word);
        const softCapWords = soft
          ? [...settings.softCapWords.filter((w) => w !== lower), lower]
          : settings.softCapWords;
        if (next !== settings.customWords || softCapWords !== settings.softCapWords) {
          await saveSettings({ ...settings, customWords: next, softCapWords });
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
        const { key, provider, baked, chosen } = aiCredentials(settings);
        respond({
          settings,
          aiLeftToday: budgetLeft(settings, provider),
          quickLeftToday: quickLeft(settings),
          learnLeftToday: learnLeft(settings),
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
        learnGeneration += 1;
        // A reset puts the settings back, not the day's allowance: the checks
        // already used today stay used, and so does a pause for an old server.
        const current = await getSettings();
        const saved = await saveSettings({
          ...DEFAULT_SETTINGS,
          aiUsage: current.aiUsage,
          quickAiUsage: current.quickAiUsage,
          quickServerOldAt: current.quickServerOldAt,
          aiLearnUsage: current.aiLearnUsage,
        });
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
          dictionary.setUserWords(settings.customWords, settings.softCapWords);
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
      case 'learn-event':
        await noteLearnEvent(message, sender);
        respond({ ok: true });
        return;
      case 'forget-notes': {
        learnGeneration += 1;
        await patchSettings({ aiNotes: '', aiNotesAt: 0, lastLearnError: '' });
        // What was waiting to be sent was collected for the notes being
        // forgotten; it goes too.
        await learnUpdate((store) => {
          for (const key of Object.keys(store)) delete store[key];
        });
        if (chrome.alarms) await chrome.alarms.clear(LEARN_ALARM);
        aiCache.clear();
        respond({ settings: await getSettings() });
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
