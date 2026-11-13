import {
  siteKey, AI_PROVIDER_INFO, dailyCeiling, clampQuickLimit,
} from '../shared/defaults.js';

const $ = (id) => document.getElementById(id);

function ask(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function describe(href) {
  if (!href) return 'this page';
  if (/^(edge|chrome|about|devtools|view-source):/i.test(href)) return null;
  return siteKey(href);
}

let tab = null;
let settings = null;

// ------------------------------------------------------------ presentation
// Everything from here to load() only decides how real state is drawn: which
// look the popup takes, what the pill says, how a shortcut becomes keycaps.

// One word for the pill in the header, per state the popup can be in.
const PILL = {
  watching: 'Watching',
  found: 'Watching',
  off: 'Off',
  'site-off': 'Off here',
  blocked: 'Not on this page',
};

const KEY_LABEL = { Period: '.', Comma: ',' };

/** "Ctrl+Shift+Period" -> three keycaps. macOS reports "⇧⌘K", with no plus. */
function keycaps(shortcut) {
  const parts = shortcut.includes('+')
    ? shortcut.split('+')
    : shortcut.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || [];
  return parts.filter(Boolean).map((part) => {
    const key = document.createElement('kbd');
    key.textContent = KEY_LABEL[part] || part;
    return key;
  });
}

/**
 * The markup ships with the default shortcuts. The browser knows the real
 * ones - changed on the shortcuts page, or never assigned because another
 * extension got there first - so show those instead.
 */
async function paintShortcuts() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch (_) {
    return;
  }
  for (const node of document.querySelectorAll('[data-command]')) {
    const command = commands.find((item) => item.name === node.dataset.command);
    if (!command) continue;
    node.textContent = '';
    if (command.shortcut) {
      node.append(...keycaps(command.shortcut));
    } else {
      const unset = document.createElement('span');
      unset.className = 'unset';
      unset.textContent = 'not set';
      node.appendChild(unset);
    }
  }
}

/**
 * The status sentence, and each AI error on a line of its own below it.
 *
 * When the count is on show as a figure, the same number at the front of the
 * sentence is kept for screen readers and hidden from the eye, so the two read
 * as one line: "4" then "suggestions in the field you were typing in."
 */
function paintStatus(text, errors, found) {
  const line = $('status');
  line.textContent = '';
  const say = document.createElement('span');
  say.className = 'say';
  const lead = found ? `${found} ` : '';
  if (lead && text.startsWith(lead)) {
    const count = document.createElement('span');
    count.className = 'vh';
    count.textContent = lead;
    say.append(count, text.slice(lead.length));
  } else {
    say.textContent = text;
  }
  line.appendChild(say);
  for (const error of errors.filter(Boolean)) {
    const note = document.createElement('span');
    note.className = 'ai-error';
    note.textContent = error;
    line.append('\n', note);
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  // The four-point star of the AI button, small.
  ai: 'M10 2.2c.8 4.6 2.4 6.2 7.2 7.2-4.8.9-6.4 2.5-7.2 7.2-.8-4.7-2.4-6.3-7.2-7.2 4.8-1 6.4-2.6 7.2-7.2z',
  // A line of text with a full stop at the end of it.
  quick: 'M3.5 8h9M3.5 12h6.5M15.6 12h.1',
};

/**
 * One usage line: an icon, what it is, how many are left, and a meter when
 * there is a limit to measure against. `sub` and `count` may be empty.
 */
function meterRow(row, { kind, label, chip = '', sub = '', count = '', left = null, limit = 0, warn = false }) {
  row.textContent = '';
  row.className = `meter-row${kind === 'quick' ? ' quick-meta' : ''}${warn ? ' warn' : ''}`;

  const ico = document.createElement('span');
  ico.className = `m-ico k-${kind}`;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[kind]);
  if (kind === 'ai') path.setAttribute('class', 'fill');
  svg.appendChild(path);
  ico.appendChild(svg);

  const text = document.createElement('span');
  text.className = 'm-text';
  const strong = document.createElement('b');
  strong.textContent = label;
  text.appendChild(strong);
  if (chip) {
    const on = document.createElement('span');
    on.className = 'm-chip';
    on.textContent = chip;
    text.appendChild(on);
  }
  if (sub) {
    const small = document.createElement('span');
    small.className = 'm-sub';
    small.textContent = sub;
    text.appendChild(small);
  }
  row.append(ico, text);

  if (count) {
    const number = document.createElement('span');
    number.className = 'm-count';
    number.textContent = count;
    row.appendChild(number);
  }
  if (typeof left === 'number' && limit > 0) {
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.setAttribute('role', 'presentation');
    const fill = document.createElement('i');
    fill.style.setProperty('--fill', `${Math.max(0, Math.min(100, (left / limit) * 100))}%`);
    bar.appendChild(fill);
    row.appendChild(bar);
    row.classList.add('metered');
  }
  row.hidden = false;
}

/** Which AI the button will use and how many checks are left, when known. */
function paintAiMeta(answer, canAi) {
  const row = $('ai-meta');
  row.hidden = true;
  if (!canAi) return;
  const ai = (answer && answer.ai) || {};
  if (!ai.hasKey) {
    meterRow(row, { kind: 'ai', label: 'AI checks', sub: 'No key yet — add one in Settings.', warn: true });
    return;
  }
  const provider = AI_PROVIDER_INFO.find((option) => option.value === ai.provider);
  const left = typeof answer.aiLeftToday === 'number' ? answer.aiLeftToday : null;
  // The meter measures against the same limit the background holds them to:
  // the free ceiling, or a lower number they set. A paid key has none.
  const ceiling = dailyCeiling(ai.provider);
  const own = Number(settings.aiDailyLimit) || 0;
  const limit = ceiling > 0 ? (own > 0 ? Math.min(own, ceiling) : ceiling) : own;
  meterRow(row, {
    kind: 'ai',
    label: 'AI checks',
    sub: provider ? `via ${provider.label}` : '',
    // No number means no limit: a paid key is not capped.
    count: left === null ? '' : left === 0 ? 'none left today' : `${left} left today`,
    left,
    limit,
    warn: left === 0,
  });
}

/**
 * The quick check after each sentence, on a line of its own. It has nothing to
 * do with the AI button above it - it runs on Caret's own server whether the
 * full check is on or not - so it is shown whenever it is switched on and
 * Caret is working on this page.
 */
function paintQuickMeta(answer, canQuick) {
  const row = $('quick-meta');
  row.hidden = true;
  if (!canQuick) return;
  if (answer.quick && answer.quick.available === false) {
    meterRow(row, { kind: 'quick', label: 'Quick check', chip: 'on', sub: 'but this copy has no Caret key', warn: true });
    return;
  }
  // No number means an extension that does not say; just show that it is on.
  const left = typeof answer.quickLeftToday === 'number' ? answer.quickLeftToday : null;
  meterRow(row, {
    kind: 'quick',
    label: 'Quick check',
    chip: 'on',
    count: left === null ? '' : left === 0 ? 'none left today' : `${left} left today`,
    left,
    limit: clampQuickLimit(settings.quickAiDailyLimit),
    warn: left === 0,
  });
}

// ------------------------------------------------------------------- load

async function load() {
  tab = await currentTab();
  const host = describe(tab && tab.url);
  const answer = await ask({ type: 'get-settings' });
  settings = answer.settings;
  const state = await ask({ type: 'get-state', href: (tab && tab.url) || '' });

  $('enabled').checked = !!settings.enabled;
  $('site').textContent = host || 'this page';
  $('site').title = host || '';
  $('site-enabled').checked = !!state.siteEnabled;
  $('site-enabled').disabled = !host;

  let text = '';
  let look = 'watching';
  let found = 0;
  if (!settings.enabled) {
    text = 'Turned off everywhere.';
    look = 'off';
  } else if (!host) {
    text = 'Browser pages cannot be checked — that is an Edge restriction, not a setting.';
    look = 'blocked';
  } else if (!state.siteEnabled) {
    // Say which entry is doing it when it is a parent domain, because turning
    // the switch back on lifts that entry, and with it the whole site.
    const by = (state.blockedBy || []).find((entry) => entry !== host);
    text = by
      ? `Turned off on ${by}, which covers this site. Switching it back on here turns it back on for all of ${by}.`
      : `Turned off on ${host}.`;
    look = 'site-off';
  } else {
    let badge = '';
    try {
      badge = await chrome.action.getBadgeText({ tabId: tab.id });
    } catch (_) { /* no tab */ }
    found = Number(badge) || 0;
    text = found
      ? `${found} suggestion${found === 1 ? '' : 's'} in the field you were typing in.`
      : 'Watching. Click into a text box and start typing.';
    if (found) look = 'found';
  }

  // The button is the third way to ask for an AI pass, next to the shortcut and
  // the right-click menu. It only appears when there is something to ask.
  const canAi = !!settings.aiEnabled && settings.enabled && state.siteEnabled && !!host;
  $('check-ai').hidden = !canAi;
  if (canAi) {
    $('check-ai-sub').textContent = settings.aiTrigger === 'auto'
      ? 'also runs on its own after each pause'
      : settings.aiTrigger === 'interval'
        ? `also runs every ${settings.aiIntervalMinutes || 1} min while you type`
        : 'or right-click the field and choose Proofread with AI';
  }
  const canQuick = !!settings.quickAiEnabled && settings.enabled && state.siteEnabled && !!host;
  paintStatus(text, [
    settings.lastAiError ? `AI: ${settings.lastAiError}` : '',
    canQuick && settings.lastQuickError ? `Quick check: ${settings.lastQuickError}` : '',
  ], found);
  paintAiMeta(answer, canAi);
  paintQuickMeta(answer, canQuick);
  $('usage').hidden = $('ai-meta').hidden && $('quick-meta').hidden;

  // The count, as a figure, underlined the way this person has Caret underline.
  const figure = $('found');
  figure.textContent = found ? String(found) : '';
  figure.classList.toggle('wavy', settings.underlineStyle === 'wavy');
  figure.hidden = !found;

  document.body.dataset.state = look;
  $('pill-text').textContent = PILL[look];

  // Transitions stay off until the first real state has been painted, so the
  // switches do not flick from off to on each time the popup opens.
  if (!document.body.classList.contains('ready')) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.add('ready');
    }));
  }
}

// Registered once. Doing this inside load() stacked a new handler on every
// repaint, and two handlers on a toggle cancel each other out.
$('enabled').addEventListener('change', async (event) => {
  await ask({ type: 'patch-settings', patch: { enabled: event.target.checked } });
  load();
});

$('site-enabled').addEventListener('change', async () => {
  await ask({ type: 'toggle-site', href: (tab && tab.url) || '' });
  load();
});

$('check-ai').addEventListener('click', async () => {
  const button = $('check-ai');
  button.disabled = true;
  $('check-ai-sub').textContent = 'checking… the box shows when it is done';
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'check-now' });
    // A moment to read that, then out of the way of the box it is checking.
    setTimeout(() => window.close(), 900);
  } catch (_) {
    // No content script in this tab - a PDF viewer, or a page that loaded
    // before the extension did.
    button.disabled = false;
    $('check-ai-sub').textContent = 'reload the page and try again';
  }
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('shortcuts').addEventListener('click', async () => {
  // Works on Edge and on Chrome; both refuse to be opened by a content script,
  // but a popup may create the tab.
  for (const url of ['edge://extensions/shortcuts', 'chrome://extensions/shortcuts']) {
    try {
      await chrome.tabs.create({ url });
      window.close();
      return;
    } catch (_) { /* try the next one */ }
  }
});

$('ver').textContent = `v${chrome.runtime.getManifest().version}`;
paintShortcuts();
load();
