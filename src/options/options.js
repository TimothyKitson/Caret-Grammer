import {
  CATEGORY_INFO, AUTOCORRECT_INFO, AI_TRIGGER_INFO, AI_PROVIDER_INFO,
  DEFAULT_SETTINGS, MAX_FREE_DAILY, dailyCeiling,
  QUICK_DEFAULT_DAILY, QUICK_MAX_DAILY, clampQuickLimit, normalizeSite, addCustomWord, entryCovers,
} from '../shared/defaults.js';
import { AI_MODELS, resolveModel } from '../engine/ai.js';
import { providerFor } from '../shared/apikey.js';

const $ = (id) => document.getElementById(id);
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

let settings = { ...DEFAULT_SETTINGS };
let aiLeftToday = 0;
let aiInfo = { provider: null, baked: false, hasKey: false };
// The quick check's side of the same answer. null means the extension did not
// say, and then the "left today" line is simply not shown.
let quickLeftToday = null;
let quickInfo = { available: true };
let toastTimer = null;
let previewTimer = null;

// The sentence the preview is run on. Every underline it shows is a real
// finding from the real engine, so it cannot drift away from what Caret does.
const PREVIEW_TEXT = 'Teh meeting is definately on tuesday. '
  + 'Their going to send recieve the agenda, and me and him will of looked at it. '
  + 'This is good.';

function toast(text = 'Saved') {
  const node = $('saved');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1500);
}

async function save(patch) {
  // Paint the change straight away, then reconcile. The service worker shuts
  // down when idle, and waking it means loading a four megabyte word list
  // first - so waiting for it before anything moves on screen makes a toggle
  // look broken for as long as that takes.
  settings = { ...settings, ...patch };
  paint();

  // Send only what changed. The worker merges it into whatever is stored now,
  // so this page cannot undo a word added from a card in another tab.
  const response = await ask({ type: 'patch-settings', patch });
  if (response && response.settings) settings = response.settings;
  await readAiStatus();
  toast();
  paint();
}

async function readAiStatus() {
  const fresh = await ask({ type: 'get-settings' });
  if (!fresh) return;
  if (typeof fresh.aiLeftToday === 'number') aiLeftToday = fresh.aiLeftToday;
  if (fresh.ai) aiInfo = fresh.ai;
  quickLeftToday = typeof fresh.quickLeftToday === 'number' ? fresh.quickLeftToday : null;
  if (fresh.quick) quickInfo = fresh.quick;
}

/**
 * True when a daily limit is only a free ceiling, which was never the person's
 * own choice: carried over to their own paid key it would cap them for no
 * reason. That is the ceiling of the free option they are leaving, or the
 * highest free ceiling, which every free option was held to before Caret's own
 * came down to its smaller number.
 */
function isOnlyACeiling(limit, leaving) {
  const n = Number(limit);
  return n > 0 && (n === dailyCeiling(leaving) || n === MAX_FREE_DAILY);
}

// --------------------------------------------------------------- builders

function chipList(node, items, onRemove, emptyText) {
  node.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    node.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.append(document.createTextNode(item));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${item}`;
    remove.addEventListener('click', () => onRemove(item));
    li.appendChild(remove);
    node.appendChild(li);
  }
}

/** One switch row: label, hint, and the toggle on the right. */
function switchRow({ label, hint, checked, disabled, search, onChange }) {
  const row = document.createElement('label');
  row.className = 'row';
  if (search) row.dataset.search = search;

  const text = document.createElement('span');
  text.className = 'text';
  const strong = document.createElement('b');
  strong.textContent = label;
  text.appendChild(strong);
  if (hint) {
    const small = document.createElement('i');
    small.textContent = hint;
    text.appendChild(small);
  }

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'sw';
  input.checked = checked;
  input.disabled = !!disabled;
  input.addEventListener('change', () => onChange(input.checked));

  const track = document.createElement('span');
  track.className = 'track';
  track.setAttribute('aria-hidden', 'true');

  row.append(text, input, track);
  return row;
}

function paintCategories() {
  const host = $('categories');
  host.textContent = '';
  for (const category of CATEGORY_INFO) {
    host.appendChild(switchRow({
      label: category.label,
      hint: category.hint,
      checked: settings.categories[category.key] !== false,
      search: `${category.label} ${category.hint}`.toLowerCase(),
      onChange: (on) => save({ categories: { ...settings.categories, [category.key]: on } }),
    }));
  }
}

function paintAutocorrect() {
  const host = $('autocorrect-options');
  const on = !!(settings.autocorrect && settings.autocorrect.enabled);
  host.textContent = '';
  host.classList.toggle('dim', !on);
  for (const item of AUTOCORRECT_INFO) {
    host.appendChild(switchRow({
      label: item.label,
      hint: item.hint,
      checked: settings.autocorrect[item.key] !== false,
      disabled: !on,
      search: `autocorrect ${item.label} ${item.hint}`.toLowerCase(),
      onChange: (checked) => save({
        autocorrect: { ...settings.autocorrect, [item.key]: checked },
      }),
    }));
  }
}

function paintProviders() {
  const host = $('aiProvider');
  host.textContent = '';
  const current = settings.aiProvider || aiInfo.provider || '';
  for (const option of AI_PROVIDER_INFO) {
    const label = document.createElement('label');
    label.classList.toggle('on', option.value === current);

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'aiProvider';
    input.value = option.value;
    input.checked = option.value === current;
    input.disabled = !settings.aiEnabled;
    input.addEventListener('change', () => {
      const patch = { aiProvider: option.value };
      const leaving = settings.aiProvider || aiInfo.provider || '';
      if (dailyCeiling(option.value) === 0 && isOnlyACeiling(settings.aiDailyLimit, leaving)) {
        patch.aiDailyLimit = 0;
      }
      save(patch);
    });

    const text = document.createElement('span');
    const strong = document.createElement('b');
    strong.textContent = option.label;
    const tag = document.createElement('span');
    tag.className = `tag ${option.tag === 'paid' ? 'paid' : 'free'}`;
    tag.textContent = option.tag;
    strong.appendChild(tag);
    const hint = document.createElement('i');
    hint.textContent = option.hint;
    text.append(strong, hint);

    label.append(input, text);
    host.appendChild(label);
  }
}

function paintTriggers() {
  const host = $('aiTrigger');
  host.textContent = '';
  const current = settings.aiTrigger || 'manual';
  for (const option of AI_TRIGGER_INFO) {
    const label = document.createElement('label');
    label.classList.toggle('on', option.value === current);

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'aiTrigger';
    input.value = option.value;
    input.checked = option.value === current;
    input.addEventListener('change', () => save({ aiTrigger: option.value }));

    const text = document.createElement('span');
    const strong = document.createElement('b');
    strong.textContent = option.label;
    const hint = document.createElement('i');
    hint.textContent = option.hint;
    text.append(strong, hint);

    label.append(input, text);
    host.appendChild(label);
  }
}

function paintModels() {
  const select = $('aiModel');
  // An id from an older version shows as the model that replaced it.
  const chosen = aiInfo.provider ? resolveModel(aiInfo.provider, settings.aiModel) : settings.aiModel;
  select.textContent = '';
  // With no key yet there is no way to know which provider you will use, so
  // show both lists. Once a key is in, only its own models are offered.
  const providers = aiInfo.provider ? [aiInfo.provider] : Object.keys(AI_MODELS);
  for (const provider of providers) {
    const group = document.createElement('optgroup');
    group.label = { caret: 'Caret', gemini: 'Google', openai: 'OpenAI', anthropic: 'Anthropic' }[provider] || provider;
    for (const model of AI_MODELS[provider]) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  select.value = chosen;
  if (!select.value && select.options.length) select.selectedIndex = 0;
}

/**
 * The quick check after each sentence. It has nothing to do with the full
 * check's switch, provider or key box: it always runs on Caret's own server,
 * so the only thing that can stop it is this copy having no Caret key.
 */
function paintQuick() {
  const on = !!settings.quickAiEnabled;
  const available = quickInfo.available !== false;

  const box = $('quickAiEnabled');
  box.checked = on;
  // Nothing to switch on without a key - but a switch that is already on can
  // always be turned off.
  box.disabled = !available && !on;
  $('quick-state').textContent = available
    ? 'Works with the full check above on or off. It always uses Caret’s own '
      + 'server, whichever AI you picked there.'
    : 'This copy has no Caret key, so the quick check cannot run. If someone '
      + 'gave you one, switch on AI proofreading above, pick Caret and paste it there.';

  const live = on && available;
  $('quick-body').classList.toggle('dim', !live);
  const limit = $('quickAiDailyLimit');
  limit.disabled = !live;
  limit.value = String(clampQuickLimit(settings.quickAiDailyLimit));

  // Only when the extension said how many: an older service worker does not.
  const left = $('quick-left');
  left.hidden = !live || quickLeftToday === null;
  left.classList.toggle('out', quickLeftToday === 0);
  left.textContent = quickLeftToday === 0
    ? '0 left today. They come back tomorrow.'
    : `${quickLeftToday} left today`;

  const error = $('quick-error');
  error.hidden = !live || !settings.lastQuickError;
  error.textContent = settings.lastQuickError ? `Last problem: ${settings.lastQuickError}` : '';
}

// --------------------------------------------------------------- preview

function renderPreview(issues) {
  const host = $('preview');
  host.textContent = '';
  const wavy = settings.underlineStyle === 'wavy';

  if (!settings.enabled) {
    const note = document.createElement('span');
    note.className = 'none';
    note.textContent = 'Caret is switched off, so nothing is being checked. '
      + 'Turn it back on from the toolbar button.';
    host.appendChild(note);
    return;
  }

  const spans = [...issues]
    .filter((i) => i.start < PREVIEW_TEXT.length)
    .sort((a, b) => a.start - b.start);

  let at = 0;
  for (const issue of spans) {
    if (issue.start < at) continue;
    host.append(PREVIEW_TEXT.slice(at, issue.start));
    const mark = document.createElement('span');
    mark.className = `u ${issue.category}${wavy ? ' wavy' : ''}`;
    mark.textContent = PREVIEW_TEXT.slice(issue.start, issue.end);
    mark.title = issue.message || '';
    host.appendChild(mark);
    at = issue.end;
  }
  host.append(PREVIEW_TEXT.slice(at));

  const count = $('preview-count');
  if (count) count.textContent = spans.length ? `${spans.length} found` : '';

  if (!spans.length) {
    const note = document.createElement('span');
    note.className = 'none';
    note.textContent = '\n\nNothing flagged — every category that would catch '
      + 'something here is switched off.';
    host.appendChild(note);
  }
}

let previewReady = false;

function schedulePreview() {
  clearTimeout(previewTimer);
  if (!previewReady) {
    const host = $('preview');
    if (!host.textContent.trim()) host.textContent = 'Checking…';
  }
  previewTimer = setTimeout(async () => {
    const response = await ask({ type: 'preview', text: PREVIEW_TEXT });
    previewReady = true;
    renderPreview((response && response.issues) || []);
  }, 60);
}

// ----------------------------------------------------------------- paint

function paint() {
  paintCategories();
  paintAutocorrect();
  paintProviders();
  paintTriggers();
  paintModels();

  $('autocorrectEnabled').checked = !!(settings.autocorrect && settings.autocorrect.enabled);
  $('checkNames').checked = !!settings.checkNames;
  $('quietOthers').checked = settings.quietOthers !== false;
  $('showBadge').checked = settings.showBadge !== false;
  $('aiEnabled').checked = !!settings.aiEnabled;
  $('aiKey').value = settings.aiKey || '';
  $('aiEffort').value = settings.aiEffort || 'low';
  $('aiIntervalMinutes').value = String(settings.aiIntervalMinutes ?? 1);
  $('aiDailyLimit').value = String(settings.aiDailyLimit ?? DEFAULT_SETTINGS.aiDailyLimit);

  for (const button of $('underlineStyle').querySelectorAll('button')) {
    const on = button.dataset.value === (settings.underlineStyle || 'straight');
    button.setAttribute('aria-checked', String(on));
  }

  // The AI block only makes sense once it is switched on, and the key box is
  // pointless when the build already carries a key.
  const on = !!settings.aiEnabled;
  $('ai-body').classList.toggle('dim', !on);
  for (const field of $('ai-body').querySelectorAll('input, select, button')) {
    field.disabled = !on;
  }
  const picked = settings.aiProvider || aiInfo.provider || '';

  // Nothing to paste when this copy already carries a Caret key.
  $('ai-key-row').hidden = picked === 'caret' && aiInfo.baked;
  $('effort-row').hidden = picked !== 'anthropic';
  $('model-row').hidden = picked === 'caret' || !picked;
  $('interval-row').hidden = settings.aiTrigger !== 'interval';

  const KEY_SHAPE = {
    caret: ['Caret key', 'caret_…', 'Someone gives you this. Nothing to sign up for and nothing to pay.'],
    gemini: ['Google API key', 'AIza…', 'From aistudio.google.com/apikey — no card, no credits.'],
    openai: ['OpenAI API key', 'sk-…', 'From platform.openai.com. You have to buy credits first.'],
    anthropic: ['Anthropic API key', 'sk-ant-…', 'From console.anthropic.com. Pay as you go.'],
  }[picked] || ['API key', 'sk-…', 'Pick which AI you are using first.'];
  $('key-label').textContent = KEY_SHAPE[0];
  $('aiKey').placeholder = KEY_SHAPE[1];
  $('key-hint').textContent = `${KEY_SHAPE[2]} Kept in this browser profile and sent nowhere else.`;

  // A key for the wrong service is the most likely mistake once there is a
  // chooser, and the API's own error for it is not a helpful one.
  $('key-warn').hidden = !aiInfo.keyMismatch;
  $('key-warn').textContent = aiInfo.keyMismatch
    ? `That key does not look like a ${KEY_SHAPE[0].replace(' key', '')}. Check which AI is selected above.`
    : '';
  $('interval-row').hidden = settings.aiTrigger !== 'interval';

  const PROVIDER_NAME = {
    caret: 'Caret', gemini: 'Google', openai: 'OpenAI', anthropic: 'Anthropic',
  };
  $('ai-host').textContent = aiInfo.provider === 'caret'
    ? 'the Caret server, which runs on Cloudflare and uses Cloudflare’s AI'
    : aiInfo.provider ? `the ${PROVIDER_NAME[aiInfo.provider]} API` : 'an AI provider';

  $('ai-state').textContent = aiInfo.baked
    ? 'Key is built into this copy — nothing to paste.'
    : aiInfo.hasKey
      ? `Using your ${PROVIDER_NAME[aiInfo.provider] || ''} key.`.replace(/\s+/g, ' ')
      : 'Needs an API key, below.';

  // A free allowance belongs to somebody else, so Caret holds each person to a
  // number. A paid key is the user's own money, so it does not.
  const ceiling = dailyCeiling(picked);
  const limitBox = $('aiDailyLimit');
  limitBox.value = ceiling > 0
    ? String(Math.min(Number(settings.aiDailyLimit) || ceiling, ceiling))
    : String(Number(settings.aiDailyLimit) || 0);
  $('limit-label').textContent = ceiling > 0 ? 'Full checks a day' : 'Full checks a day (optional)';
  $('ai-budget').textContent = ceiling > 0
    ? `Free, with a limit: at most ${ceiling} full AI checks a day on this computer, `
      + `and you can set it lower. ${settings.aiEnabled ? `${aiLeftToday} left today. ` : ''}`
      + 'When it runs out the built-in checks carry on as normal.'
    : 'Your own key, so Caret does not limit it. Set a number to stop a runaway '
      + 'from costing you, or 0 for no limit at all.';

  // On a free option a run costs a check, not money. Caret's own allows so few
  // full checks a day that the two automatic choices get a warning of their own.
  $('trigger-hint').textContent = ceiling > 0
    ? 'Each run uses one of the day’s checks, so this decides how long they last.'
    : 'Each run costs money, so this is the setting that decides your bill.';
  $('trigger-note').hidden = picked !== 'caret';
  $('trigger-note').textContent = `Caret gives you ${dailyCeiling('caret')} full checks a day — `
    + '“every minute” or “after every pause” will use them up quickly.';

  paintQuick();

  $('master-dot').classList.toggle('off', !settings.enabled);
  $('master-text').textContent = settings.enabled ? 'Checking' : 'Switched off';

  chipList($('words'), settings.customWords, (word) => {
    save({ customWords: settings.customWords.filter((w) => w !== word) });
  }, 'Nothing added yet.');
  $('words-count').textContent = `${settings.customWords.length}`;

  chipList($('sites'), settings.disabledSites, (site) => {
    save({ disabledSites: settings.disabledSites.filter((s) => s !== site) });
  }, 'No sites — checking everywhere.');
  $('sites-count').textContent = `${settings.disabledSites.length}`;
  $('sites-empty').hidden = settings.disabledSites.length > 0;

  $('ignored-count').textContent = `${settings.ignored.length}`;
  $('clear-ignored').disabled = settings.ignored.length === 0;

  const stats = settings.stats || {};
  $('stats').textContent = [
    `${(stats.checks || 0).toLocaleString()} checks run`,
    `${(stats.issues || 0).toLocaleString()} things found`,
    `${(stats.aiCalls || 0).toLocaleString()} AI calls`,
    `${(stats.aiErrors || 0).toLocaleString()} AI errors`,
    `${(stats.quickCalls || 0).toLocaleString()} quick checks`,
  ].join(' · ');

  schedulePreview();
}

// ---------------------------------------------------------------- wiring

$('autocorrectEnabled').addEventListener('change', (e) => {
  save({ autocorrect: { ...settings.autocorrect, enabled: e.target.checked } });
});
$('checkNames').addEventListener('change', (e) => save({ checkNames: e.target.checked }));
$('quietOthers').addEventListener('change', (e) => save({ quietOthers: e.target.checked }));
$('showBadge').addEventListener('change', (e) => save({ showBadge: e.target.checked }));
$('aiEnabled').addEventListener('change', (e) => save({ aiEnabled: e.target.checked }));
$('aiModel').addEventListener('change', (e) => save({ aiModel: e.target.value }));
$('aiEffort').addEventListener('change', (e) => save({ aiEffort: e.target.value }));
$('aiKey').addEventListener('change', (e) => {
  const aiKey = e.target.value.trim();
  const patch = { aiKey };
  // A Caret key is also kept on its own, for the quick check, so it survives
  // picking another AI for the full check later.
  if (providerFor(aiKey) === 'caret') patch.caretKey = aiKey;
  // Same reasoning as switching provider: a free ceiling left over from
  // before should not cap a paid key that was just pasted.
  const provider = settings.aiProvider || providerFor(aiKey) || '';
  const leaving = settings.aiProvider || aiInfo.provider || '';
  if (dailyCeiling(provider) === 0 && isOnlyACeiling(settings.aiDailyLimit, leaving)) {
    patch.aiDailyLimit = 0;
  }
  save(patch);
});

$('underlineStyle').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (button) save({ underlineStyle: button.dataset.value });
});

const clampNumber = (id, key, min, max, fallback) => {
  $(id).addEventListener('change', (e) => {
    const value = Math.max(min, Math.min(max, Number(e.target.value) || fallback));
    save({ [key]: value });
  });
};
$('aiDailyLimit').addEventListener('change', (e) => {
  const picked = settings.aiProvider || aiInfo.provider || '';
  const ceiling = dailyCeiling(picked);
  const asked = Number(e.target.value);
  const value = ceiling > 0
    ? Math.max(1, Math.min(ceiling, asked || ceiling))
    : Math.max(0, Math.min(99999, Number.isFinite(asked) ? asked : 0));
  save({ aiDailyLimit: value });
});
clampNumber('aiIntervalMinutes', 'aiIntervalMinutes', 1, 120, 1);

$('quickAiEnabled').addEventListener('change', (e) => save({ quickAiEnabled: e.target.checked }));
$('quickAiDailyLimit').addEventListener('change', (e) => {
  const typed = e.target.value.trim();
  // An emptied box, or one the browser could not read as a number, is not a
  // request for anything: put back what is saved.
  if (!typed) {
    e.target.value = String(clampQuickLimit(settings.quickAiDailyLimit));
    return;
  }
  // Below the minimum means the minimum, not the default.
  save({ quickAiDailyLimit: clampQuickLimit(Math.max(0, Number(typed))) });
});

async function addWord() {
  const input = $('new-word');
  // Kept exactly as typed: "Ignitia" stays "Ignitia".
  const next = addCustomWord(settings.customWords, input.value);
  input.value = '';
  if (next !== settings.customWords) await save({ customWords: next });
}

function siteMessage(text, tone) {
  const el = $('site-msg');
  el.textContent = text;
  el.className = `hint ${tone || ''}`.trim();
  el.hidden = !text;
}

async function addSite() {
  const input = $('new-site');
  const raw = input.value.trim();
  if (!raw) return;
  const site = normalizeSite(raw);
  if (!site) {
    siteMessage('That does not look like a web address. Try something like example.com.', 'bad');
    return;
  }
  const covering = settings.disabledSites.find((s) => entryCovers(s, site));
  input.value = '';
  if (covering) {
    siteMessage(covering === site
      ? `Caret is already off on ${site}.`
      : `${site} is already covered by ${covering}.`, '');
    return;
  }
  // A broader entry makes narrower ones underneath it redundant.
  const kept = settings.disabledSites.filter((s) => !(s !== site && entryCovers(site, s)));
  await save({ disabledSites: [...kept, site].sort() });
  siteMessage(`Caret is now off on ${site}.`, 'good');
}
$('add-site').addEventListener('click', addSite);
$('new-site').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSite(); });
$('new-site').addEventListener('input', () => siteMessage(''));
$('add-word').addEventListener('click', addWord);
$('new-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });

$('clear-ignored').addEventListener('click', () => save({ ignored: [] }));

$('reset').addEventListener('click', async () => {
  if (!window.confirm('Put every setting back to its default, and empty your dictionary, your turned-off sites and your ignore list?')) return;
  await ask({ type: 'reset-settings' });
  const state = await ask({ type: 'get-settings' });
  if (state && state.settings) settings = state.settings;
  await readAiStatus();
  toast('Reset');
  paint();
});

$('shortcuts').addEventListener('click', async () => {
  for (const url of ['edge://extensions/shortcuts', 'chrome://extensions/shortcuts']) {
    try {
      await chrome.tabs.create({ url });
      return;
    } catch (_) { /* try the next one */ }
  }
});

$('test').addEventListener('click', async () => {
  const result = $('ai-result');
  const key = $('aiKey').value.trim();
  if (!aiInfo.baked && key !== settings.aiKey) await save({ aiKey: key });
  result.className = 'result';
  result.textContent = 'Asking…';
  const response = await ask({ type: 'test-ai' });
  if (!response || response.error) {
    result.className = 'result bad';
    result.textContent = (response && response.error) || 'No answer from the extension.';
    return;
  }
  result.className = 'result ok';
  result.textContent = `Working. ${response.model || ''} found ${response.found} thing${response.found === 1 ? '' : 's'} to fix in the test sentence.`.trim();
});

// ----------------------------------------------------------------- search

$('search').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  let anyShown = false;

  for (const section of document.querySelectorAll('main > section')) {
    const rows = section.querySelectorAll('[data-search]');
    if (!query) {
      section.hidden = false;
      for (const row of rows) row.hidden = false;
      anyShown = true;
      continue;
    }
    const heading = (section.querySelector('h2')?.textContent || '').toLowerCase();
    const headingHit = heading.includes(query);
    let shown = 0;
    for (const row of rows) {
      const hit = headingHit || row.dataset.search.includes(query);
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    section.hidden = !(shown || headingHit);
    if (!section.hidden) anyShown = true;
  }
  $('no-results').hidden = anyShown;
});

// -------------------------------------------------------------- scrollspy

const links = [...document.querySelectorAll('nav a')];
const spy = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const link of links) {
      link.classList.toggle('here', link.getAttribute('href') === `#${entry.target.id}`);
    }
  }
}, { rootMargin: '-10% 0px -70% 0px' });
for (const section of document.querySelectorAll('main > section')) spy.observe(section);

// ------------------------------------------------------------------ load

// The keyboard section ships with the default shortcuts. The browser knows the
// real ones - changed on the shortcuts page, or never assigned because another
// extension took the key first - so show those instead.
async function paintShortcuts() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch (_) {
    return;
  }
  const label = { Period: '.', Comma: ',' };
  for (const node of document.querySelectorAll('[data-command]')) {
    const command = commands.find((item) => item.name === node.dataset.command);
    if (!command) continue;
    node.textContent = '';
    if (!command.shortcut) {
      const unset = document.createElement('span');
      unset.className = 'unset';
      unset.textContent = 'not set';
      node.appendChild(unset);
      continue;
    }
    const parts = command.shortcut.includes('+')
      ? command.shortcut.split('+')
      : command.shortcut.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || [];
    for (const part of parts.filter(Boolean)) {
      const key = document.createElement('kbd');
      key.textContent = label[part] || part;
      node.appendChild(key);
    }
  }
}

async function load() {
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `version ${manifest.version}`;
  // The quick check's numbers come from one place, so the words cannot drift.
  $('quick-default').textContent = String(QUICK_DEFAULT_DAILY);
  $('quick-max').textContent = String(QUICK_MAX_DAILY);
  $('quickAiDailyLimit').max = String(QUICK_MAX_DAILY);
  $('quick-hint').textContent = `Anything from 1 to ${QUICK_MAX_DAILY}. When they run out, `
    + 'the built-in checks carry on as normal.';
  const state = await ask({ type: 'get-settings' });
  if (state && state.settings) settings = state.settings;
  await readAiStatus();
  paint();
}

load();
paintShortcuts();
