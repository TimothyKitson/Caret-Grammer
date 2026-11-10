import { siteKey } from '../shared/defaults.js';

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

async function load() {
  tab = await currentTab();
  const host = describe(tab && tab.url);
  settings = (await ask({ type: 'get-settings' })).settings;
  const state = await ask({ type: 'get-state', href: (tab && tab.url) || '' });

  $('enabled').checked = !!settings.enabled;
  $('site').textContent = host || 'this page';
  $('site-enabled').checked = !!state.siteEnabled;
  $('site-enabled').disabled = !host;

  let text = '';
  if (!settings.enabled) {
    text = 'Turned off everywhere.';
  } else if (!host) {
    text = 'Browser pages cannot be checked — that is an Edge restriction, not a setting.';
  } else if (!state.siteEnabled) {
    text = `Turned off on ${host}.`;
  } else {
    let badge = '';
    try {
      badge = await chrome.action.getBadgeText({ tabId: tab.id });
    } catch (_) { /* no tab */ }
    const found = Number(badge) || 0;
    text = found
      ? `${found} suggestion${found === 1 ? '' : 's'} in the field you were typing in.`
      : 'Watching. Click into a text box and start typing.';
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
  if (settings.lastAiError) text += `\nAI: ${settings.lastAiError}`;
  $('status').textContent = text;

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
  $('check-ai-sub').textContent = 'checking…';
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'check-now' });
    window.close();
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

load();
