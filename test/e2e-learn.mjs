// End-to-end for "Check sentences" and "Learn how I write": a sentence problem
// is a band behind the words with the word underlines still on top; a small
// sentence fix has a button and a big one does not; and a while after a full
// check, the suggestions taken and ignored go to the AI with the field as it
// is then, the notes that come back are kept, and the next full check carries
// them. The real extension in Chromium, with a stand-in Caret server, and the
// five-minute wait cut down to a few seconds.
//
//   NODE_PATH=$(npm root -g) node test/e2e-learn.mjs

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
async function until(test, ms = 45000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(every);
  }
}

// ------------------------------------------------------- the stand-in server

const LEARN_DELAY = 15000;
const NOTES = '- Likes short sentences.\n- Says "store", not "shop".';
const requests = [];       // every POST /check body, in order
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>learn</title>
<style>body{font:16px/1.5 sans-serif;padding:20px} textarea{display:block;width:760px;height:150px;font:16px/1.5 sans-serif;padding:6px}</style>
<textarea id="ta"></textarea><input id="other">`;

const RUN_ON = 'we saw the old shop it was closed';
const RUN_ON_FIXED = 'we saw the old store it was closed';
const SMALL = 'I like cats dogs too';

function corrections(text, sentences) {
  const out = [];
  const shop = text.indexOf('shop');
  if (shop !== -1) {
    out.push({ before: text.slice(Math.max(0, shop - 10), shop), original: 'shop', replacement: 'store', kind: 'style', explanation: 'FULL-AI shop' });
  }
  if (sentences) {
    const a = text.indexOf(RUN_ON);
    if (a !== -1) {
      out.push({ before: text.slice(Math.max(0, a - 10), a), original: RUN_ON, replacement: '', kind: 'sentence', explanation: 'SENTENCE-AI run-on' });
    }
    const b = text.indexOf(SMALL);
    if (b !== -1) {
      out.push({ before: text.slice(Math.max(0, b - 10), b), original: SMALL, replacement: 'I like cats and dogs too', kind: 'sentence', explanation: 'SENTENCE-AI missing word' });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, learn: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/check') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (parsed.mode === 'quick') {
        res.end(JSON.stringify({ corrections: [], mode: 'quick' }));
      } else if (parsed.mode === 'learn') {
        res.end(JSON.stringify({ notes: NOTES, model: 'fake-small', mode: 'learn' }));
      } else {
        res.end(JSON.stringify({ corrections: corrections(parsed.text, parsed.sentences === true), model: 'fake-big', mode: 'full' }));
      }
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'caret-learn-ext-'));
for (const item of ['manifest.json', 'icons', 'src', 'data']) {
  fs.cpSync(path.join(ROOT, item), path.join(EXT, item), { recursive: true });
}
const keyFile = path.join(EXT, 'src/shared/apikey.js');
fs.writeFileSync(keyFile, fs.readFileSync(keyFile, 'utf8')
  .replace(/export const BUILT_IN_KEY = '[^']*';/, "export const BUILT_IN_KEY = 'caret_e2etest_0123456789';")
  .replace(/export const CARET_ENDPOINT = '[^']*';/, `export const CARET_ENDPOINT = '${origin}';`));
const defaultsFile = path.join(EXT, 'src/shared/defaults.js');
const defaults = fs.readFileSync(defaultsFile, 'utf8');
assert.match(defaults, /export const LEARN_DELAY_MS = [^;]+;/);
fs.writeFileSync(defaultsFile, defaults.replace(/export const LEARN_DELAY_MS = [^;]+;/, `export const LEARN_DELAY_MS = ${LEARN_DELAY};`));

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'caret-learn-profile-')), {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`      [page error] ${e.message}`));
await page.goto(origin);
let worker = context.serviceWorkers()[0];
for (let i = 0; !worker && i < 40; i += 1) { await sleep(250); worker = context.serviceWorkers()[0]; }
const settingsPage = await context.newPage();
const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/src/options/options.html`;
await settingsPage.goto(optionsUrl);
const message = (m) => settingsPage.evaluate((msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r)), m);
await message({
  type: 'patch-settings',
  patch: { aiEnabled: true, aiProvider: 'caret', aiTrigger: 'manual', aiSentences: true, aiLearn: true },
});
await page.bringToFront();
await sleep(500);

const shadow = (fn, arg) => page.evaluate(fn, arg);
const fulls = () => requests.filter((r) => r.mode !== 'quick' && r.mode !== 'learn');
const learns = () => requests.filter((r) => r.mode === 'learn');

/** The drawn highlights, by class, in reading order. */
const bands = (cls) => shadow((c) => {
  const host = document.querySelector('div[data-caret="ui"]');
  return [...host.shadowRoot.querySelectorAll(`.u.${c}`)]
    .filter((el) => !el.hidden)
    .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}, cls);

const card = () => shadow(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  const el = host.shadowRoot.querySelector('.card');
  if (!el || el.hidden) return null;
  return {
    chip: (el.querySelector('.chip') || {}).textContent || '',
    msg: (el.querySelector('.msg') || {}).textContent || '',
    fixes: [...el.querySelectorAll('.fixes button')].map((b) => b.textContent),
    hint: (el.querySelector('.hint') || {}).textContent || '',
  };
});

async function hover(rect) {
  await page.mouse.move(1, 1);
  await sleep(150);
  await page.mouse.move(rect.x + 4, rect.y + rect.h / 2);
  await sleep(400);
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

const TEXT = `Yesterday ${RUN_ON}. ${SMALL}. It was teh best day.`;

await step('with Check sentences on, a run-on is a band and its words keep their underlines', async () => {
  await page.click('#ta');
  await page.keyboard.type(TEXT, { delay: 4 });
  await sleep(900);
  await pressAiButton();
  await until(async () => (await bands('sentence')).length >= 2, 6000);
  const last = fulls()[fulls().length - 1];
  assert.equal(last.sentences, true, 'the check asked about sentences');
  assert.equal(last.style, undefined, 'and had no notes to send yet');
  assert.ok((await bands('sentence')).length >= 2, 'two sentence bands');
  assert.equal((await bands('style')).length, 1, 'the word inside the run-on still has its underline');
  assert.equal((await bands('spelling')).length, 1, 'and so does the typo after it');
});

await step('a big sentence problem gets an explanation and no button', async () => {
  const [runOn] = await bands('sentence');
  await hover(runOn);
  const shown = await card();
  assert.ok(shown, 'a card');
  assert.equal(shown.chip, 'Sentence');
  assert.match(shown.msg, /SENTENCE-AI run-on/);
  assert.deepEqual(shown.fixes, [], 'no fix button');
  assert.match(shown.hint, /own words/);
});

await step('the word underline inside it opens its own card', async () => {
  const [word] = await bands('style');
  await page.mouse.move(1, 1);
  await sleep(150);
  await page.mouse.move(word.x + word.w / 2, word.y + word.h / 2);
  await sleep(400);
  const shown = await card();
  assert.ok(shown && /FULL-AI shop/.test(shown.msg), JSON.stringify(shown));
});

await step('fixing that word with a real click keeps the sentence highlight around it', async () => {
  // A real mouse press on the card's button: it must reach the button, not
  // reopen a card for the band underneath.
  const button = await shadow(() => {
    const b = document.querySelector('div[data-caret="ui"]').shadowRoot.querySelector('.card .fixes button');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent };
  });
  assert.equal(button.text, 'store');
  await page.mouse.move(button.x, button.y, { steps: 4 });
  await sleep(200);
  await page.mouse.click(button.x, button.y);
  await sleep(1200);
  assert.match(await page.locator('#ta').inputValue(), /we saw the old store it was closed/);
  assert.equal((await bands('sentence')).length >= 2, true, 'the run-on is still highlighted');
  assert.equal((await bands('style')).length, 0, 'and the fixed word is not');
});

await step('a small sentence fix has a button, and it works', async () => {
  const small = (await bands('sentence'))[1];
  await hover(small);
  const shown = await card();
  assert.ok(shown && /missing word/.test(shown.msg), JSON.stringify(shown));
  assert.deepEqual(shown.fixes, ['I like cats and dogs too']);
  await shadow(() => {
    document.querySelector('div[data-caret="ui"]').shadowRoot.querySelector('.card .fixes button').click();
  });
  await sleep(600);
  assert.match(await page.locator('#ta').inputValue(), /I like cats and dogs too\./);
});

await step('ignoring the run-on, and fixing a plain typo', async () => {
  const [runOn] = await bands('sentence');
  await hover(runOn);
  await shadow(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    [...host.shadowRoot.querySelectorAll('.card .foot button')].find((b) => b.textContent === 'Ignore').click();
  });
  await sleep(800);
  const [typo] = await bands('spelling');
  await hover(typo);
  await shadow(() => {
    document.querySelector('div[data-caret="ui"]').shadowRoot.querySelector('.card .fixes button').click();
  });
  await sleep(600);
  assert.match(await page.locator('#ta').inputValue(), /the best day/);
});

await step('after the wait, what was taken and ignored goes to the AI once, with the field as it is now', async () => {
  // Typed after the check, before the timer goes off: it should be in what is sent.
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' We went home.', { delay: 5 });
  const sent = await until(() => learns().length > 0);
  assert.ok(sent, 'a learning request was sent');
  await sleep(LEARN_DELAY + 1500);
  assert.equal(learns().length, 1, 'only once');
  const learn = learns()[0];
  assert.match(learn.text, /I like cats and dogs too\. It was the best day\. We went home\./, `the text as it is now: ${JSON.stringify(learn.text)} ${JSON.stringify(learn.accepted)}`);
  assert.deepEqual(learn.accepted.map((c) => [c.original, c.replacement, c.kind]),
    [['shop', 'store', 'clarity'], [SMALL, 'I like cats and dogs too', 'sentence']],
    'the AI fixes that were taken - and not the typo');
  assert.deepEqual(learn.ignored.map((c) => [c.original, c.kind]), [[RUN_ON_FIXED, 'sentence']]);
  assert.equal(learn.notes, '', 'no notes yet to build on');
});

await step('the notes are kept, and the settings page shows them', async () => {
  const kept = await until(async () => {
    const s = await message({ type: 'get-settings' });
    return s && s.settings.aiNotes === NOTES ? s : null;
  }, 5000);
  assert.ok(kept, 'aiNotes saved');
  await settingsPage.reload();
  await sleep(600);
  const items = await settingsPage.$$eval('#aiNotes li', (els) => els.map((e) => e.textContent));
  assert.deepEqual(items, ['Likes short sentences.', 'Says "store", not "shop".']);
  assert.equal(await settingsPage.$eval('#forget-notes', (b) => b.disabled), false);
  await page.bringToFront();
});

await step('the next full check carries the notes', async () => {
  const before = fulls().length;
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' The end.', { delay: 5 });
  await sleep(900);
  await pressAiButton();
  await until(() => fulls().length > before, 6000);
  const last = fulls()[fulls().length - 1];
  assert.equal(last.style, NOTES);
  assert.equal(last.sentences, true);
});

await step('Forget clears the notes, and nothing waiting is sent', async () => {
  await settingsPage.bringToFront();
  await settingsPage.click('#forget-notes');
  await sleep(500);
  const s = await message({ type: 'get-settings' });
  assert.equal(s.settings.aiNotes, '');
  assert.equal(await settingsPage.$eval('#aiNotes', (el) => el.hidden), true);
  const learnsBefore = learns().length;
  await sleep(LEARN_DELAY + 2000);
  assert.equal(learns().length, learnsBefore, 'the check just before the forget did not learn');
  await page.bringToFront();
});

await step('with learning off, a check sends no notes and nothing is learned', async () => {
  await message({ type: 'patch-settings', patch: { aiLearn: false } });
  await page.bringToFront();
  await sleep(600);
  const before = fulls().length;
  const learnsBefore = learns().length;
  await page.click('#ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Again.', { delay: 5 });
  await sleep(900);
  await pressAiButton();
  await until(() => fulls().length > before, 6000);
  assert.equal(fulls()[fulls().length - 1].style, undefined);
  await sleep(LEARN_DELAY + 2000);
  assert.equal(learns().length, learnsBefore);
});

await step('with Check sentences off, the check does not ask about sentences', async () => {
  await message({ type: 'patch-settings', patch: { aiSentences: false } });
  await page.bringToFront();
  await sleep(600);
  const before = fulls().length;
  await page.click('#ta');
  await page.keyboard.type(' More.', { delay: 5 });
  await sleep(900);
  await pressAiButton();
  await until(() => fulls().length > before, 6000);
  assert.equal(fulls()[fulls().length - 1].sentences, undefined);
  await until(async () => (await bands('sentence')).length === 0, 3000);
  assert.equal((await bands('sentence')).length, 0, 'no bands');
});

await context.close();
server.close();
fs.rmSync(EXT, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
