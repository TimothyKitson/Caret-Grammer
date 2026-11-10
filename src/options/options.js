import {
  CATEGORY_INFO, AUTOCORRECT_INFO, AI_TRIGGER_INFO, AI_PROVIDER_INFO,
  DEFAULT_SETTINGS, MAX_FREE_DAILY, dailyCeiling,
} from '../shared/defaults.js';
import { AI_MODELS, DEFAULT_MODEL } from '../engine/ai.js';

const $ = (id) => document.getElementById(id);
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

let settings = { ...DEFAULT_SETTINGS };
let aiLeftToday = 0;
let aiInfo = { provider: null, baked: false, hasKey: false };
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
    input.addEventListener('change', () => save({ aiProvider: option.value }));

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
  const chosen = settings.aiModel
    || (aiInfo.provider ? DEFAULT_MODEL[aiInfo.provider] : '');
  select.textContent = '';
  // With no key yet there is no way to know which provider you will use, so
  // show both lists. Once a key is in, only its own models are offered.
  const providers = aiInfo.provider ? [aiInfo.provider] : Object.keys(AI_MODELS);
  for (const provider of providers) {
    const group = document.createElement('optgroup');
    group.label = provider === 'openai' ? 'OpenAI' : 'Anthropic';
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
  const free = picked === 'caret' || picked === 'gemini';

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
    ? 'the shared Caret server'
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
  $('limit-label').textContent = ceiling > 0 ? 'Checks a day' : 'Checks a day (optional)';
  $('ai-budget').textContent = ceiling > 0
    ? `Free, with a limit: at most ${ceiling} AI checks a day on this computer, `
      + `and you can set it lower. ${settings.aiEnabled ? `${aiLeftToday} left today. ` : ''}`
      + 'When it runs out the built-in checks carry on as normal.'
    : 'Your own key, so Caret does not limit it. Set a number to stop a runaway '
      + 'from costing you, or 0 for no limit at all.';

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
$('aiKey').addEventListener('change', (e) => save({ aiKey: e.target.value.trim() }));

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

async function addWord() {
  const input = $('new-word');
  const word = input.value.trim().toLowerCase();
  if (!word || settings.customWords.includes(word)) { input.value = ''; return; }
  input.value = '';
  await save({ customWords: [...settings.customWords, word] });
}
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

async function load() {
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `version ${manifest.version}`;
  const state = await ask({ type: 'get-settings' });
  if (state && state.settings) settings = state.settings;
  await readAiStatus();
  paint();
}

load();
