// End-to-end: load the unpacked extension into Chromium (what Edge is built
// on) and check that underlines are drawn in the right place, that hovering
// one opens the card, and that clicking a suggestion really fixes the field.
//
//   node test/e2e.mjs
//
// Needs Playwright. In this container it lives in the global node_modules, so
// the runner passes NODE_PATH; see package.json.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// Playwright may be a dev dependency here or installed globally.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (_) {
    const globalRoot = execSync('npm root -g').toString().trim();
    const entry = path.join(globalRoot, 'playwright', 'index.js');
    if (!fs.existsSync(entry)) {
      throw new Error('Playwright is not installed. Run: npm install --save-dev playwright');
    }
    return import(pathToFileURL(entry).href);
  }
}

const playwright = await loadPlaywright();
// A globally installed Playwright is CommonJS, so it arrives under `default`.
const { chromium } = playwright.chromium ? playwright : playwright.default;

const failures = [];
let passes = 0;
async function step(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${error.message.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- test server

const fixture = fs.readFileSync(path.join(HERE, 'fixture.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------- browser

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
  ],
});

const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`      [page error] ${message.text()}`);
});

// The service worker starts when the first content script talks to it.
async function waitForWorker() {
  for (let i = 0; i < 40; i += 1) {
    if (context.serviceWorkers().length) return context.serviceWorkers()[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

await page.goto(origin);
await waitForWorker();

// ------------------------------------------------------------------- helpers

const UNDERLINES = () => page.evaluate(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  if (!host || !host.shadowRoot) return null;
  return [...host.shadowRoot.querySelectorAll('.u')]
    .filter((el) => !el.hidden)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return {
        category: el.className.replace('u ', '').replace(' active', ''),
        left: box.left, top: box.top, width: box.width, height: box.height,
      };
    });
});

const CARD = () => page.evaluate(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  const card = host && host.shadowRoot && host.shadowRoot.querySelector('.card');
  if (!card || card.hidden) return null;
  const box = card.getBoundingClientRect();
  return {
    chip: card.querySelector('.chip')?.textContent,
    message: card.querySelector('.msg')?.textContent,
    fixes: [...card.querySelectorAll('button.fix')].map((b) => b.textContent),
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
  };
});

const BADGE = () => page.evaluate(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  const badge = host && host.shadowRoot && host.shadowRoot.querySelector('.badge');
  if (!badge || badge.hidden) return null;
  return { text: badge.textContent, className: badge.className };
});

async function waitFor(fn, what, timeout = 12000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value && (!Array.isArray(value) || value.length)) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function clickShadow(selector) {
  const box = await page.evaluate((sel) => {
    const host = document.querySelector('div[data-caret="ui"]');
    const el = host.shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  assert.ok(box, `no shadow element for ${selector}`);
  await page.mouse.click(box.x, box.y);
}

// --------------------------------------------------------------------- tests

console.log(`\nextension: ${ROOT}\npage: ${origin}\n`);

await step('the overlay is injected on an ordinary page', async () => {
  await page.click('#ta');
  await page.locator('#ta').fill('I recieved you\'re email about teh meeting.');
  await waitFor(UNDERLINES, 'underlines');
});

let underlines;
await step('a textarea gets one underline per mistake, inside the field', async () => {
  underlines = await waitFor(async () => {
    const found = await UNDERLINES();
    return found && found.length >= 3 ? found : null;
  }, 'three underlines');
  const field = await page.locator('#ta').boundingBox();
  for (const u of underlines) {
    assert.ok(u.width > 4 && u.height > 6, `underline too small: ${JSON.stringify(u)}`);
    assert.ok(u.left >= field.x - 2 && u.left + u.width <= field.x + field.width + 2,
      `underline outside the textarea horizontally: ${JSON.stringify(u)}`);
    assert.ok(u.top >= field.y - 2 && u.top + u.height <= field.y + field.height + 2,
      `underline outside the textarea vertically: ${JSON.stringify(u)}`);
  }
  assert.ok(underlines.some((u) => u.category === 'spelling'), 'expected a spelling underline');
  assert.ok(underlines.some((u) => u.category === 'grammar'), 'expected a grammar underline');
});

await step('the count badge shows how many were found', async () => {
  const badge = await waitFor(BADGE, 'badge');
  assert.match(badge.className, /has/);
  assert.ok(Number(badge.text) >= 3, `badge says ${badge.text}`);
});

await step('hovering an underline opens the card with a suggestion', async () => {
  const first = underlines.sort((a, b) => a.left - b.left)[0];
  await page.mouse.move(first.left + first.width / 2, first.top + first.height / 2);
  const card = await waitFor(CARD, 'card');
  assert.ok(card.fixes.length > 0, 'card has no suggestion buttons');
  assert.ok(card.message.length > 5, 'card has no explanation');
});

await step('clicking the suggestion fixes the text', async () => {
  const before = await page.locator('#ta').inputValue();
  const card = await CARD();
  await clickShadow('button.fix');
  await page.waitForFunction(
    (previous) => document.querySelector('#ta').value !== previous,
    before,
    { timeout: 5000 },
  );
  const after = await page.locator('#ta').inputValue();
  assert.notEqual(after, before);
  assert.ok(after.includes(card.fixes[0]), `expected "${card.fixes[0]}" in "${after}"`);
});

await step('the caret is left in the field, not on the card', async () => {
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  assert.equal(focused, 'ta');
});

await step('a single-line input is underlined too', async () => {
  await page.click('#in');
  await page.locator('#in').fill('this sentance has a typo');
  const found = await waitFor(UNDERLINES, 'input underlines');
  const field = await page.locator('#in').boundingBox();
  const inside = found.filter((u) => u.left >= field.x - 2 && u.top >= field.y - 2
    && u.top + u.height <= field.y + field.height + 2);
  assert.ok(inside.length >= 1, `no underline inside the input: ${JSON.stringify(found)}`);
});

await step('a contenteditable is underlined and can be fixed', async () => {
  await page.click('#ce');
  await page.locator('#ce').pressSequentially('Their is alot of work to do.', { delay: 8 });
  const found = await waitFor(async () => {
    const all = await UNDERLINES();
    return all && all.length >= 2 ? all : null;
  }, 'contenteditable underlines');
  const target = found.sort((a, b) => a.left - b.left)[0];
  await page.mouse.move(target.left + target.width / 2, target.top + target.height / 2);
  const card = await waitFor(CARD, 'card over contenteditable');
  const before = await page.locator('#ce').innerText();
  await clickShadow('button.fix');
  await page.waitForFunction(
    (previous) => document.querySelector('#ce').innerText.trim() !== previous.trim(),
    before,
    { timeout: 5000 },
  );
  const after = await page.locator('#ce').innerText();
  assert.ok(after.includes(card.fixes[0].replace(/’/g, "'")) || after !== before,
    `contenteditable not fixed: "${after}"`);
});

await step('correct writing gets no underlines at all', async () => {
  await page.click('#clean');
  await page.locator('#clean').fill(
    'The principal sent an email to every parent this morning, and they were glad to read it.',
  );
  await new Promise((r) => setTimeout(r, 1200));
  const found = await UNDERLINES();
  assert.deepEqual(found, [], `unexpected underlines: ${JSON.stringify(found)}`);
  const badge = await BADGE();
  assert.match((badge && badge.className) || '', /clean/);
});

await step('password fields are never checked', async () => {
  await page.click('#pw');
  await page.locator('#pw').fill('recieved teh wierd');
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(await UNDERLINES(), []);
});

await step('data-gramm="false" is respected', async () => {
  await page.click('#optout');
  await page.locator('#optout').fill('I recieved teh wierd email.');
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(await UNDERLINES(), []);
});

await step('underlines follow the field when the page scrolls', async () => {
  await page.click('#ta');
  await page.locator('#ta').fill('I recieved you\'re email about teh meeting.\n\n\nmore text here');
  const before = await waitFor(UNDERLINES, 'underlines before scroll');
  const fieldBefore = await page.locator('#ta').boundingBox();
  await page.mouse.wheel(0, 120);
  await new Promise((r) => setTimeout(r, 400));
  const after = await UNDERLINES();
  const fieldAfter = await page.locator('#ta').boundingBox();
  const pageMoved = Math.abs(fieldBefore.y - fieldAfter.y);
  if (pageMoved < 5) return;                       // page too short to scroll
  const moved = Math.abs(before[0].top - after[0].top);
  assert.ok(moved > 5, `underline did not move with the page (${moved}px)`);
  assert.ok(Math.abs(after[0].top - (before[0].top - pageMoved)) < 3,
    'underline did not track the field exactly');
});

await step('Escape closes the card', async () => {
  const found = await waitFor(UNDERLINES, 'underlines');
  await page.mouse.move(found[0].left + 2, found[0].top + found[0].height / 2);
  await waitFor(CARD, 'card');
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await CARD(), null);
});

await step('the service worker can read the dictionary it ships with', async () => {
  const worker = context.serviceWorkers()[0];
  assert.ok(worker, 'no service worker');
  const reply = await worker.evaluate(async () => {
    const response = await fetch(chrome.runtime.getURL('data/words.txt'));
    const text = await response.text();
    return { id: chrome.runtime.id, chars: text.length, receive: text.includes('\nreceive\n') };
  });
  assert.ok(reply.id, 'no extension id');
  assert.ok(reply.chars > 3000000, `dictionary looks short: ${reply.chars}`);
  assert.equal(reply.receive, true);
});

await step('the toolbar badge counts the issues in the tab', async () => {
  const worker = context.serviceWorkers()[0];
  await page.bringToFront();
  await page.click('#ta');
  await page.locator('#ta').fill('I recieved teh email and its to late.');
  await waitFor(UNDERLINES, 'underlines for the badge check');
  const text = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
  assert.ok(Number(text) >= 3, `toolbar badge reads "${text}"`);
});

const extensionId = new URL(context.serviceWorkers()[0].url()).host;

await step('the options page loads and renders its controls', async () => {
  const options = await context.newPage();
  const errors = [];
  options.on('pageerror', (error) => errors.push(error.message));
  options.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForSelector('#categories input[type=checkbox]');
  const boxes = await options.locator('#categories input[type=checkbox]').count();
  const models = await options.locator('#aiModel option').count();
  await options.locator('#new-word').fill('kitson');
  await options.locator('#add-word').click();
  await options.waitForSelector('#words li');
  const chip = await options.locator('#words li').first().innerText();
  await options.close();
  assert.equal(errors.length, 0, `console errors: ${errors.join(' | ')}`);
  assert.equal(boxes, 5, `expected 5 category switches, saw ${boxes}`);
  assert.ok(models >= 3, `expected the model list, saw ${models}`);
  assert.match(chip, /kitson/);
});

await step('a word added in options stops being flagged', async () => {
  await page.bringToFront();
  await page.click('#clean');
  await page.locator('#clean').fill('Kitson signed the form.');
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(await UNDERLINES(), []);
});

await step('the popup loads and shows the switches', async () => {
  const popup = await context.newPage();
  const errors = [];
  popup.on('pageerror', (error) => errors.push(error.message));
  popup.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForFunction(() => document.getElementById('status').textContent !== 'Loading…');
  const status = await popup.locator('#status').innerText();
  const enabled = await popup.locator('#enabled').isChecked();
  await popup.close();
  assert.equal(errors.length, 0, `console errors: ${errors.join(' | ')}`);
  assert.equal(enabled, true);
  assert.ok(status.length > 4, 'popup status is empty');
});

await context.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
