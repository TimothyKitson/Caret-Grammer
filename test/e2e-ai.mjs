// End-to-end for the full AI check as a person sees it: that it says it is
// working and how it went, and that its suggestions stay put while the field
// is edited. The real extension in Chromium, with a stand-in Caret server
// that takes a moment to answer, so nothing real is spent.
//
//   NODE_PATH=$(npm root -g) node test/e2e-ai.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (_) {
    const globalRoot = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.js')).href);
  }
}
const playwright = await loadPlaywright();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- the stand-in server

let fullCalls = 0;
let failNext = false;
const DELAY = 1500;
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>ai</title>
<style>body{font:16px/1.5 sans-serif;padding:20px} textarea{display:block;width:640px;height:150px;font:16px/1.5 sans-serif;padding:6px}</style>
<textarea id="ta"></textarea><input id="other">`;

// Three odd suggestions no built-in rule would make, so these underlines can
// only have come from the stand-in AI.
function corrections(text) {
  const out = [];
  for (const [word, fix, note] of [['near', 'close to', 'FULL-AI one'], ['shop', 'store', 'FULL-AI two'], ['quick', 'fast', 'FULL-AI three']]) {
    const at = text.indexOf(word);
    if (at !== -1) {
      out.push({ before: text.slice(Math.max(0, at - 10), at), original: word, replacement: fix, kind: 'style', explanation: note });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/check') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.mode === 'quick') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ corrections: [], mode: 'quick' }));
        return;
      }
      fullCalls += 1;
      setTimeout(() => {
        if (failNext) {
          failNext = false;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'the model fell over' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ corrections: corrections(parsed.text), model: 'fake-big', mode: 'full' }));
      }, DELAY);
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'caret-ai-ext-'));
for (const item of ['manifest.json', 'icons', 'src', 'data']) {
  fs.cpSync(path.join(ROOT, item), path.join(EXT, item), { recursive: true });
}
const keyFile = path.join(EXT, 'src/shared/apikey.js');
fs.writeFileSync(keyFile, fs.readFileSync(keyFile, 'utf8')
  .replace(/export const BUILT_IN_KEY = '[^']*';/, "export const BUILT_IN_KEY = 'caret_e2etest_0123456789';")
  .replace(/export const CARET_ENDPOINT = '[^']*';/, `export const CARET_ENDPOINT = '${origin}';`));

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'caret-ai-profile-')), {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(origin);
let worker = context.serviceWorkers()[0];
for (let i = 0; !worker && i < 40; i += 1) { await sleep(250); worker = context.serviceWorkers()[0]; }
const settingsPage = await context.newPage();
await settingsPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
const message = (m) => settingsPage.evaluate((msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r)), m);
await message({ type: 'patch-settings', patch: { aiEnabled: true, aiProvider: 'caret', aiTrigger: 'manual' } });
await page.bringToFront();
await sleep(500);

const shadow = (fn, arg) => page.evaluate(fn, arg);
const status = () => shadow(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  const el = host && host.shadowRoot.querySelector('.status');
  return el && !el.hidden ? { text: el.textContent, busy: !!el.querySelector('.spin') } : null;
});
const badgeState = () => shadow(() => {
  const b = document.querySelector('div[data-caret="ui"]').shadowRoot.querySelector('.badge');
  return b && !b.hidden ? b.className : null;
});
async function aiRows() {
  return shadow(async () => {
    const host = document.querySelector('div[data-caret="ui"]');
    const panel = host.shadowRoot.querySelector('.panel');
    if (!panel || panel.hidden) host.shadowRoot.querySelector('.badge').click();
    await new Promise((r) => setTimeout(r, 250));
    const rows = [...host.shadowRoot.querySelectorAll('.panel .row .what')].map((el) => el.title).filter((t) => /FULL-AI/.test(t));
    host.shadowRoot.querySelector('.badge').click();
    return rows.sort();
  });
}
async function pressAiButton() {
  await shadow(async () => {
    const host = document.querySelector('div[data-caret="ui"]');
    host.shadowRoot.querySelector('.badge').click();
    await new Promise((r) => setTimeout(r, 250));
    host.shadowRoot.querySelector('.panel button.ai-check').click();
  });
}

console.log(`\nextension copy: ${EXT}\nstand-in server: ${origin}\n`);

const TEXT = 'We walked near the old shop on a quick trip to town today.';

await step('pressing Check with AI says it is working, then how it went', async () => {
  await page.click('#ta');
  await page.keyboard.type(TEXT, { delay: 4 });
  await sleep(900);
  await pressAiButton();
  await sleep(300);
  const during = await status();
  assert.ok(during, 'a status line while it runs');
  assert.match(during.text, /Checking with AI/);
  assert.equal(during.busy, true, 'with a spinner');
  assert.match(await badgeState() || '', /\bai\b/, 'and the badge says AI');
  await sleep(DELAY + 900);
  const after = await status();
  assert.ok(after, 'a status line once it is done');
  assert.match(after.text, /AI: 3 suggestions/);
  assert.equal(after.busy, false);
  assert.deepEqual(await aiRows(), ['FULL-AI one', 'FULL-AI three', 'FULL-AI two']);
});

await step('fixing one AI suggestion keeps the others', async () => {
  await shadow(async () => {
    const host = document.querySelector('div[data-caret="ui"]');
    host.shadowRoot.querySelector('.badge').click();
    await new Promise((r) => setTimeout(r, 250));
    const row = [...host.shadowRoot.querySelectorAll('.panel .row')].find((r) => r.querySelector('.what').title === 'FULL-AI two');
    row.querySelector('button').click();
  });
  await sleep(1200);
  assert.match(await page.locator('#ta').inputValue(), /the old store on/);
  assert.deepEqual(await aiRows(), ['FULL-AI one', 'FULL-AI three']);
});

await step('typing somewhere else keeps them too', async () => {
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' It was sunny.', { delay: 10 });
  await sleep(1200);
  assert.deepEqual(await aiRows(), ['FULL-AI one', 'FULL-AI three']);
});

await step('changing the flagged word itself drops only that one', async () => {
  const value = await page.locator('#ta').inputValue();
  const at = value.indexOf('quick') + 'quick'.length;
  await page.locator('#ta').evaluate((el, pos) => { el.focus(); el.setSelectionRange(pos, pos); }, at);
  await page.keyboard.press('Backspace');
  await sleep(1200);
  assert.deepEqual(await aiRows(), ['FULL-AI one']);
});

await step('a failed AI check says so', async () => {
  failNext = true;
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' More words here.', { delay: 5 });
  await sleep(700);
  await pressAiButton();
  await sleep(DELAY + 900);
  const after = await status();
  assert.ok(after, 'a status line');
  assert.match(after.text, /AI check failed/);
  assert.deepEqual(await aiRows(), ['FULL-AI one'], 'and what was found before is still there');
});

await step('with no full checks left, the button and the shortcut both say so', async () => {
  const today = (() => { const n = new Date(); return `${n.getFullYear()}-${n.getMonth() + 1}-${n.getDate()}`; })();
  await message({ type: 'patch-settings', patch: { aiUsage: { day: today, count: 20 } } });
  await page.bringToFront();
  await sleep(600);
  await page.click('#ta');
  await page.keyboard.type(' x', { delay: 5 });
  await sleep(900);
  const calls = fullCalls;
  const label = await shadow(async () => {
    const host = document.querySelector('div[data-caret="ui"]');
    host.shadowRoot.querySelector('.badge').click();
    await new Promise((r) => setTimeout(r, 250));
    const b = host.shadowRoot.querySelector('.panel button.ai-check');
    const out = b ? { text: b.textContent, disabled: b.disabled } : null;
    host.shadowRoot.querySelector('.badge').click();
    return out;
  });
  assert.match(label.text, /No full AI checks left today/);
  assert.equal(label.disabled, true);
  // The keyboard shortcut arrives as a command message.
  const tabId = await message({ type: 'get-settings' }).then(() => null);
  void tabId;
  await settingsPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const tabs = tab ? [tab] : await chrome.tabs.query({});
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'command', name: 'check-now' }).catch(() => {});
  });
  await sleep(500);
  const said = await status();
  assert.ok(said && /No full AI checks left today/.test(said.text), JSON.stringify(said));
  assert.equal(fullCalls, calls, 'and nothing was sent');
});

await context.close();
server.close();
fs.rmSync(EXT, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
