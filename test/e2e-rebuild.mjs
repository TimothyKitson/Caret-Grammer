// End-to-end: Caret has to survive a site rebuilding its own editor.
//
//   NODE_PATH=$(npm root -g) node test/e2e-rebuild.mjs
//
// Ignitia's Writer, among others, redraws its editor when you press its check
// or save button. The four ways a page commonly does that are in
// fixture-rebuild.html. The nasty one is A: rewriting the editor's document
// with document.open(), which makes the browser drop every event listener in
// it, Caret's included - before the fix, Caret stayed dead in that box until
// the page was reloaded.

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

const html = fs.readFileSync(path.join(HERE, 'fixture-rebuild.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'caret-rebuild-')), {
  headless: false,
  viewport: { width: 900, height: 900 },
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForTimeout(1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Visible underlines in this frame's overlay; -1 when Caret has no overlay there. */
const underlines = (frame) => frame.evaluate(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  if (!host || !host.shadowRoot) return -1;
  return [...host.shadowRoot.querySelectorAll('.u')].filter((e) => !e.hidden).length;
});

async function waitForUnderlines(frame, atLeast, what) {
  const started = Date.now();
  for (;;) {
    const n = await underlines(frame);
    if (n >= atLeast) return n;
    if (Date.now() - started > 6000) throw new Error(`${what}: expected at least ${atLeast} underlines, saw ${n}`);
    await sleep(200);
  }
}

const frameFor = async (id) => (await page.$(`#${id}`)).contentFrame();

async function scenario(target, button) {
  let frame = target.frame ? await frameFor(target.frame) : page.mainFrame();
  const sel = target.frame ? '#ed' : target.sel;
  await frame.click(sel);
  await frame.locator(sel).pressSequentially('I recieved teh letter. ', { delay: 8 });
  await waitForUnderlines(frame, 2, 'before the site rebuilt its editor');
  await page.click(button);
  await sleep(600);
  frame = target.frame ? await frameFor(target.frame) : page.mainFrame();
  await frame.click(sel);
  await page.keyboard.press('End');
  await frame.locator(sel).pressSequentially(' It was wierd. ', { delay: 8 });
  await waitForUnderlines(frame, 3, 'after the site rebuilt its editor');
}

console.log(`\nextension: ${ROOT}\n`);

await step('an editor rewritten with document.open() keeps Caret (Ignitia Writer)', () => scenario({ frame: 'fa' }, '#ba'));
await step('an editor element swapped for a new one keeps Caret', () => scenario({ sel: '#edB' }, '#bb'));
await step("an editor's contents rewritten with markup keeps Caret", () => scenario({ sel: '#edC' }, '#bc'));
await step('an editor iframe replaced by a new iframe keeps Caret', () => scenario({ frame: 'fd' }, '#bd'));

await step("Caret's own panel offers the AI check when the site hides the right-click menu", async () => {
  const opts = await context.newPage();
  const worker = context.serviceWorkers()[0];
  await opts.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
  // A made-up key: the button only shows when the AI could actually run.
  // Nothing is typed afterwards, so nothing is ever sent with it.
  await opts.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({
    type: 'patch-settings',
    patch: { aiEnabled: true, aiProvider: 'caret', aiKey: 'caret_madeup_000000000' },
  }, r)));
  await opts.close();
  await page.bringToFront();
  await sleep(500);
  await page.click('#edC');
  await sleep(400);
  const label = await page.evaluate(async () => {
    const host = document.querySelector('div[data-caret="ui"]');
    host.shadowRoot.querySelector('.badge').click();
    await new Promise((r) => setTimeout(r, 300));
    const button = host.shadowRoot.querySelector('.panel button.ai-check');
    return button ? button.textContent : null;
  });
  assert.match(label || '', /Check with AI/);
});

await context.close();
server.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
