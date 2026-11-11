// End-to-end for the quick check: the real extension in Chromium, a real
// person-shaped typing pattern, and a stand-in for the Caret server so every
// request can be counted and nothing real is spent.
//
//   NODE_PATH=$(npm root -g) node test/e2e-quick.mjs
//
// The extension is copied to a temporary folder with its server address
// pointed at the local stand-in and a dummy caret_ key baked in. The copy in
// the repository is never touched.

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

// ------------------------------------------------------- the stand-in server

const requests = [];          // every POST /check body, in order
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>quick</title>
<style>body{font:16px/1.5 sans-serif;padding:20px} textarea,div[contenteditable]{display:block;width:640px;height:150px;margin:0 0 16px;padding:6px;border:1px solid #888}</style>
<div id="ce" contenteditable="true"></div>
<textarea id="ta"></textarea>
<textarea id="pre">This was here before. Nobody typed it just now. It stays unchecked.</textarea>
<textarea id="code" style="font-family:Menlo, Consolas, monospace"></textarea>
<input id="other" placeholder="somewhere else">`;

// What the stand-in "model" finds: one deliberately odd suggestion the local
// rules would never make, so an underline from it can only have come from here.
function fakeCorrections(text) {
  const out = [];
  const at = text.indexOf('near');
  if (at !== -1) {
    out.push({
      before: text.slice(Math.max(0, at - 10), at),
      original: 'near',
      replacement: 'close',
      kind: 'style',
      explanation: 'QUICK-AI says close.',
    });
  }
  return out;
}

const server = http.createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-caret-key',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method === 'POST' && req.url === '/check') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ ...parsed, key: req.headers['x-caret-key'] });
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({
        corrections: parsed.mode === 'quick' ? fakeCorrections(parsed.text) : [],
        model: parsed.mode === 'quick' ? 'fake-small' : 'fake-big',
        mode: parsed.mode === 'quick' ? 'quick' : 'full',
      }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------- a copy aimed at the stand-in

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'caret-quick-ext-'));
for (const item of ['manifest.json', 'icons', 'src', 'data']) {
  fs.cpSync(path.join(ROOT, item), path.join(EXT, item), { recursive: true });
}
const keyFile = path.join(EXT, 'src/shared/apikey.js');
const keySource = fs.readFileSync(keyFile, 'utf8')
  .replace(/export const BUILT_IN_KEY = '[^']*';/, "export const BUILT_IN_KEY = 'caret_e2etest_0123456789';")
  .replace(/export const CARET_ENDPOINT = '[^']*';/, `export const CARET_ENDPOINT = '${origin}';`);
assert.ok(keySource.includes('caret_e2etest_0123456789') && keySource.includes(origin), 'apikey.js rewrite failed');
fs.writeFileSync(keyFile, keySource);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'caret-quick-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(origin);

let worker = context.serviceWorkers()[0];
for (let i = 0; !worker && i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  worker = context.serviceWorkers()[0];
}
const extensionId = new URL(worker.url()).host;

// Settings go through the extension's own message, exactly as the settings
// page saves them, so the content scripts hear about the change.
const settingsPage = await context.newPage();
await settingsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
const message = (msg) => settingsPage.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
const patch = (p) => message({ type: 'patch-settings', patch: p });
await page.bringToFront();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quickTexts = () => requests.filter((r) => r.mode === 'quick').map((r) => r.text);
async function waitForCount(n, timeout = 6000) {
  const started = Date.now();
  while (quickTexts().length < n) {
    if (Date.now() - started > timeout) {
      throw new Error(`expected ${n} quick checks, saw ${quickTexts().length}: ${JSON.stringify(quickTexts())}`);
    }
    await sleep(100);
  }
}

/** Put the caret inside the contenteditable at the first occurrence of `needle`. */
async function caretAt(needle, extra = 0) {
  await page.evaluate(({ needle: n, extra: x }) => {
    const ce = document.getElementById('ce');
    const walker = document.createTreeWalker(ce, 4);   // NodeFilter.SHOW_TEXT
    let node;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf(n);
      if (i !== -1) {
        const range = document.createRange();
        range.setStart(node, i + x);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }
    throw new Error(`no "${n}" in the field`);
  }, { needle, extra });
}

async function panelRows() {
  await page.evaluate(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    const badge = host && host.shadowRoot.querySelector('.badge');
    if (badge) badge.click();
  });
  await sleep(300);
  return page.evaluate(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    return [...host.shadowRoot.querySelectorAll('.panel .row .what')].map((el) => ({ text: el.textContent, title: el.title }));
  });
}

// ---------------------------------------------------------------------- tests

console.log(`\nextension copy: ${EXT}\nstand-in server: ${origin}\n`);

const PARAGRAPH = 'I walked to the park today. It was sunny and warm outside. '
  + 'We stayed until the lights came on. The lake is near the trees. We will go back soon.';
const SENTENCES = PARAGRAPH.match(/[^.]+\./g).map((s) => s.trim());

await step('nothing is sent while the quick check is off', async () => {
  await page.click('#ce');
  await page.keyboard.type('This sentence is typed with the quick check switched off. ', { delay: 5 });
  await sleep(2600);
  assert.deepEqual(quickTexts(), []);
  await page.evaluate(() => { document.getElementById('ce').textContent = ''; });
});

await step('typing a paragraph checks each sentence once, in order', async () => {
  await patch({ quickAiEnabled: true, quickAiDailyLimit: 30, enabled: true });
  await sleep(500);
  await page.click('#ce');
  await page.keyboard.type(PARAGRAPH, { delay: 12 });
  // The last sentence has nobody moving on from it: the pause finishes it.
  await waitForCount(5, 8000);
  await sleep(800);
  assert.deepEqual(quickTexts(), SENTENCES);
  assert.ok(requests.every((r) => r.mode !== 'quick' || r.key === 'caret_e2etest_0123456789'), 'sent with the key');
});

await step("the small model's finding is underlined in the right sentence", async () => {
  const rows = await waitForRows((rows) => rows.some((r) => r.title === 'QUICK-AI says close.'));
  const row = rows.find((r) => r.title === 'QUICK-AI says close.');
  assert.match(row.text, /^near/);
  await page.keyboard.press('Escape');
});

async function waitForRows(predicate, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const rows = await panelRows();
    if (predicate(rows)) return rows;
    await page.keyboard.press('Escape');
    if (Date.now() - started > timeout) throw new Error(`panel never showed it: ${JSON.stringify(rows)}`);
    await sleep(300);
  }
}

await step('moving around without typing checks nothing again', async () => {
  const before = quickTexts().length;
  await caretAt('sunny');
  await page.keyboard.press('ArrowRight');
  await caretAt('lights');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('End');
  await page.click('#other');
  await page.click('#ce');
  await sleep(2600);
  assert.equal(quickTexts().length, before, JSON.stringify(quickTexts().slice(before)));
});

await step('a changed sentence is checked again only after you move out of it', async () => {
  const before = quickTexts().length;
  await caretAt('sunny', 5);            // just after "sunny"
  await page.keyboard.type(' and bright', { delay: 15 });
  await sleep(2600);                     // pausing inside it is not leaving it
  assert.equal(quickTexts().length, before, 'checked while still inside the sentence');
  await caretAt('lights');               // into another sentence
  await page.keyboard.press('ArrowRight');
  await waitForCount(before + 1);
  await sleep(600);
  assert.deepEqual(quickTexts().slice(before), ['It was sunny and bright and warm outside.']);
});

await step('the same changed sentence is not checked a second time', async () => {
  const before = quickTexts().length;
  await caretAt('bright');
  await page.keyboard.press('ArrowRight');
  await caretAt('lake');
  await page.keyboard.press('ArrowRight');
  await page.click('#other');
  await sleep(1500);
  assert.equal(quickTexts().length, before);
});

await step('applying the small model\'s suggestion does not spend another check', async () => {
  const before = quickTexts().length;
  await page.click('#ce');
  const rows = await waitForRows((r) => r.some((x) => x.title === 'QUICK-AI says close.'));
  assert.ok(rows.length);
  await page.evaluate(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    const row = [...host.shadowRoot.querySelectorAll('.panel .row')]
      .find((r) => r.querySelector('.what').title === 'QUICK-AI says close.');
    row.querySelector('button').click();
  });
  await sleep(400);
  const text = await page.evaluate(() => document.getElementById('ce').innerText);
  assert.match(text, /The lake is close the trees\./);
  await caretAt('walked');
  await page.keyboard.press('ArrowRight');
  await page.click('#other');
  await sleep(1500);
  assert.equal(quickTexts().length, before, JSON.stringify(quickTexts().slice(before)));
});

await step('the last sentence is checked when you click away, without waiting', async () => {
  const before = quickTexts().length;
  await page.click('#ce');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Then we had dinner together.', { delay: 10 });
  await page.click('#other');
  await waitForCount(before + 1, 1500);
  assert.equal(quickTexts().at(-1), 'Then we had dinner together.');
});

await step('a new paragraph after a blank line and an indent starts a new sentence', async () => {
  const before = quickTexts().length;
  await page.click('#ta');
  await page.keyboard.type('First paragraph ends right here.', { delay: 8 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('    Second paragraph has no full stop before it. ', { delay: 8 });
  await waitForCount(before + 2);
  await sleep(500);
  assert.deepEqual(quickTexts().slice(before), [
    'First paragraph ends right here.',
    'Second paragraph has no full stop before it.',
  ]);
});

await step('text that was already in the field is never sent unless it is changed', async () => {
  const before = quickTexts().length;
  await page.click('#pre');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' I added this sentence myself.', { delay: 8 });
  await page.click('#other');
  await waitForCount(before + 1);
  await sleep(500);
  assert.deepEqual(quickTexts().slice(before), ['I added this sentence myself.']);
});

await step('a field in a code font is left alone', async () => {
  const before = quickTexts().length;
  await page.click('#code');
  await page.keyboard.type('This looks like prose in a code box. And here is more of it. ', { delay: 5 });
  await page.click('#other');
  await sleep(2600);
  assert.equal(quickTexts().length, before);
});

await step('the daily limit stops it, and nothing more is sent', async () => {
  const used = quickTexts().length;
  await patch({ quickAiDailyLimit: used + 1 });
  await sleep(400);
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' One more sentence fits today. This one is over the limit. And so is this one. ', { delay: 8 });
  await page.click('#other');
  await sleep(2800);
  assert.deepEqual(quickTexts().slice(used), ['One more sentence fits today.']);
  const state = await message({ type: 'get-settings' });
  assert.equal(state.quickLeftToday, 0);
});

await step('the quick check never asks the big model', async () => {
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => r.mode === 'quick'), JSON.stringify(requests.filter((r) => r.mode !== 'quick')));
});

await context.close();
server.close();
fs.rmSync(EXT, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
