import { CATEGORY_INFO, AUTOCORRECT_INFO, DEFAULT_SETTINGS } from '../shared/defaults.js';
import { AI_MODELS } from '../engine/ai.js';

const $ = (id) => document.getElementById(id);
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

let settings = { ...DEFAULT_SETTINGS };
let aiLeftToday = 0;
let saveTimer = null;

function flashSaved(text = 'Saved.') {
  $('saved').textContent = text;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saved').textContent = ''; }, 1600);
}

async function save(patch) {
  // Send only what changed. The worker merges it into whatever is stored now,
  // so this page cannot undo a word added from a card in another tab.
  const response = await ask({ type: 'patch-settings', patch });
  if (response && response.settings) settings = response.settings;
  else settings = { ...settings, ...patch };
  const fresh = await ask({ type: 'get-settings' });
  if (fresh && typeof fresh.aiLeftToday === 'number') aiLeftToday = fresh.aiLeftToday;
  flashSaved();
  paint();
}

function chipList(node, items, onRemove, emptyText) {
  node.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.style.background = 'transparent';
    li.style.color = 'var(--muted)';
    li.textContent = emptyText;
    node.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.append(document.createTextNode(item));
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Remove ${item}`;
    remove.addEventListener('click', () => onRemove(item));
    li.appendChild(remove);
    node.appendChild(li);
  }
}

function paintCategories() {
  const host = $('categories');
  host.textContent = '';
  for (const category of CATEGORY_INFO) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings.categories[category.key] !== false;
    input.addEventListener('change', () => {
      save({ categories: { ...settings.categories, [category.key]: input.checked } });
    });
    const span = document.createElement('span');
    const strong = document.createElement('b');
    strong.textContent = category.label;
    const hint = document.createElement('i');
    hint.textContent = category.hint;
    span.append(strong, hint);
    label.append(input, span);
    host.appendChild(label);
  }
}

function paintAutocorrect() {
  const host = $('autocorrect-options');
  const on = !!(settings.autocorrect && settings.autocorrect.enabled);
  host.textContent = '';
  host.style.opacity = on ? '1' : '0.45';
  for (const item of AUTOCORRECT_INFO) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings.autocorrect[item.key] !== false;
    input.disabled = !on;
    input.addEventListener('change', () => {
      save({ autocorrect: { ...settings.autocorrect, [item.key]: input.checked } });
    });
    const span = document.createElement('span');
    const strong = document.createElement('b');
    strong.textContent = item.label;
    const hint = document.createElement('i');
    hint.textContent = item.hint;
    span.append(strong, hint);
    label.append(input, span);
    host.appendChild(label);
  }
}

function paint() {
  paintCategories();
  paintAutocorrect();
  $('autocorrectEnabled').checked = !!(settings.autocorrect && settings.autocorrect.enabled);
  $('checkNames').checked = !!settings.checkNames;
  $('showBadge').checked = settings.showBadge !== false;
  $('underlineStyle').value = settings.underlineStyle || 'straight';
  $('aiEnabled').checked = !!settings.aiEnabled;
  $('aiKey').value = settings.aiKey || '';
  $('aiModel').value = settings.aiModel || DEFAULT_SETTINGS.aiModel;
  $('aiEffort').value = settings.aiEffort || 'low';
  $('aiTrigger').value = settings.aiTrigger || 'manual';
  $('aiDailyLimit').value = String(settings.aiDailyLimit ?? DEFAULT_SETTINGS.aiDailyLimit);
  $('aiEffort').disabled = (settings.aiModel || '').startsWith('claude-haiku');
  $('ai-budget').textContent = settings.aiEnabled
    ? `${aiLeftToday} of ${settings.aiDailyLimit} checks left today.`
      + ($('aiEffort').disabled ? ' Haiku has no effort setting — it is always the quick one.' : '')
    : '';

  chipList($('words'), settings.customWords, (word) => {
    save({ customWords: settings.customWords.filter((w) => w !== word) });
  }, 'Nothing added yet.');
  $('words-count').textContent = `${settings.customWords.length} word${settings.customWords.length === 1 ? '' : 's'}`;

  chipList($('sites'), settings.disabledSites, (site) => {
    save({ disabledSites: settings.disabledSites.filter((s) => s !== site) });
  }, 'No sites — checking everywhere.');
  $('sites-count').textContent = `${settings.disabledSites.length} site${settings.disabledSites.length === 1 ? '' : 's'}`;
  $('sites-empty').hidden = settings.disabledSites.length > 0;

  $('ignored-count').textContent = `${settings.ignored.length}`;
  $('clear-ignored').disabled = settings.ignored.length === 0;

  const stats = settings.stats || {};
  $('stats').textContent = [
    `${(stats.checks || 0).toLocaleString()} checks run`,
    `${(stats.issues || 0).toLocaleString()} suggestions offered`,
    `${(stats.aiCalls || 0).toLocaleString()} Claude requests`,
    stats.aiErrors ? `${stats.aiErrors} Claude errors` : null,
  ].filter(Boolean).join(' · ');

  const result = $('ai-result');
  if (settings.lastAiError && !result.dataset.fresh) {
    result.className = 'result bad';
    result.textContent = `Last Claude error — ${settings.lastAiError}`;
  }
}

$('autocorrectEnabled').addEventListener('change', (e) => {
  save({ autocorrect: { ...settings.autocorrect, enabled: e.target.checked } });
});
$('checkNames').addEventListener('change', (e) => save({ checkNames: e.target.checked }));
$('underlineStyle').addEventListener('change', (e) => save({ underlineStyle: e.target.value }));
$('aiTrigger').addEventListener('change', (e) => save({ aiTrigger: e.target.value }));
$('aiDailyLimit').addEventListener('change', (e) => {
  const limit = Math.max(0, Math.min(1000, parseInt(e.target.value, 10) || 0));
  save({ aiDailyLimit: limit });
});
$('showBadge').addEventListener('change', (e) => save({ showBadge: e.target.checked }));
$('aiEnabled').addEventListener('change', (e) => save({ aiEnabled: e.target.checked }));
$('aiKey').addEventListener('change', (e) => save({ aiKey: e.target.value.trim() }));
$('aiModel').addEventListener('change', (e) => save({ aiModel: e.target.value }));
$('aiEffort').addEventListener('change', (e) => save({ aiEffort: e.target.value }));

$('add-word').addEventListener('click', async () => {
  const word = $('new-word').value.trim().toLowerCase();
  if (!word) return;
  $('new-word').value = '';
  if (settings.customWords.includes(word)) return;
  await save({ customWords: [...settings.customWords, word].sort() });
});
$('new-word').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('add-word').click();
});

$('clear-ignored').addEventListener('click', () => save({ ignored: [] }));

$('reset').addEventListener('click', async () => {
  if (!confirm('Put every setting back to its default? Your dictionary and disabled sites go too.')) return;
  await save({ ...DEFAULT_SETTINGS });
});

$('test').addEventListener('click', async () => {
  const result = $('ai-result');
  result.dataset.fresh = '1';
  result.className = 'result';
  result.textContent = 'Asking Claude to proofread one sentence…';
  const key = $('aiKey').value.trim();
  if (key !== settings.aiKey) await save({ aiKey: key });
  const response = await ask({ type: 'test-ai' });
  if (!response || response.error) {
    result.className = 'result bad';
    result.textContent = (response && response.error) || 'No answer from the extension.';
    return;
  }
  result.className = 'result ok';
  result.textContent = `Working. ${response.model || settings.aiModel} found ${response.found} thing${response.found === 1 ? '' : 's'} to fix in the test sentence.`;
});

for (const model of AI_MODELS) {
  const option = document.createElement('option');
  option.value = model.id;
  option.textContent = model.label;
  $('aiModel').appendChild(option);
}

(async () => {
  const response = await ask({ type: 'get-settings' });
  if (response && response.settings) settings = response.settings;
  if (response && typeof response.aiLeftToday === 'number') aiLeftToday = response.aiLeftToday;
  paint();
})();
