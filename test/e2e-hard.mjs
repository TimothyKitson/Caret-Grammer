// The awkward cases: padded and scrolled fields, right-aligned and
// right-to-left inputs, a scaled container, rich contenteditable markup, an
// iframe, a React-style controlled input, and a very long document.
//
//   node test/e2e-hard.mjs

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
    const entry = path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.js');
    if (!fs.existsSync(entry)) throw new Error('npm install --save-dev playwright');
    return import(pathToFileURL(entry).href);
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
    console.log(`FAIL  ${name}\n      ${error.message.split('\n').slice(0, 3).join('\n      ')}`);
  }
}

const page404 = '<!doctype html><p>no</p>';
const hard = fs.readFileSync(path.join(HERE, 'fixture-hard.html'), 'utf8');
const frame = `<!doctype html><html><head><meta charset=utf-8><style>
  body{font:15px/1.5 Arial;margin:8px} textarea{font:15px/1.5 Arial;width:400px;height:70px}
</style></head><body><textarea id="inframe"></textarea></body></html>`;

const server = http.createServer((req, res) => {
  const body = req.url === '/frame' ? frame : (req.url === '/' ? hard : page404);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hard-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 900, height: 800 },
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
const page = await context.newPage();
await page.goto(origin);
await new Promise((r) => setTimeout(r, 1200));

const underlinesIn = (target) => target.evaluate(() => {
  const host = document.querySelector('div[data-caret="ui"]');
  if (!host || !host.shadowRoot) return [];
  return [...host.shadowRoot.querySelectorAll('.u')].filter((el) => !el.hidden).map((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height, cls: el.className };
  });
});

async function waitFor(fn, what, timeout = 12000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value && value.length) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Every underline must sit inside the field's visible box. */
async function assertInside(selector, underlines, slack = 3) {
  const box = await page.locator(selector).boundingBox();
  for (const u of underlines) {
    assert.ok(u.width > 2 && u.height > 4, `degenerate underline ${JSON.stringify(u)}`);
    assert.ok(u.left >= box.x - slack && u.left + u.width <= box.x + box.width + slack,
      `outside horizontally: ${JSON.stringify(u)} vs ${JSON.stringify(box)}`);
    assert.ok(u.top >= box.y - slack && u.top + u.height <= box.y + box.height + slack,
      `outside vertically: ${JSON.stringify(u)} vs ${JSON.stringify(box)}`);
  }
}

/** The underline should cover the word, not some other part of the line. */
async function assertOverWord(selector, word, underlines) {
  // Measure where the word is by asking the browser to select it.
  const target = await page.evaluate(({ sel, needle }) => {
    const el = document.querySelector(sel);
    const value = el.value !== undefined ? el.value : el.innerText;
    const at = value.indexOf(needle);
    if (at === -1) return null;
    if (el.value === undefined) return null;
    el.focus();
    el.setSelectionRange(at, at + needle.length);
    return { at };
  }, { sel: selector, needle: word });
  if (!target) return;
  const box = await page.locator(selector).boundingBox();
  const covering = underlines.filter((u) => u.left >= box.x - 4 && u.left <= box.x + box.width + 4);
  assert.ok(covering.length, `no underline near ${selector}`);
}

console.log(`\npage: ${origin}\n`);

await step('a heavily padded, bordered, scrolled textarea lines up', async () => {
  await page.click('#padded');
  const lines = [];
  for (let i = 0; i < 14; i += 1) lines.push(`Line ${i} has no mistakes in it at all here.`);
  lines.push('The last line has a recieved typo and their is more.');
  await page.locator('#padded').fill(lines.join('\n'));
  await page.evaluate(() => {
    const el = document.querySelector('#padded');
    el.scrollTop = el.scrollHeight;
  });
  await page.locator('#padded').press('End');
  const found = await waitFor(() => underlinesIn(page), 'underlines in the padded textarea');
  await assertInside('#padded', found);
});

await step('a right-aligned input is underlined in the right place', async () => {
  await page.click('#right');
  await page.locator('#right').fill('this sentance is right aligned');
  const found = await waitFor(() => underlinesIn(page), 'underlines in the right-aligned input');
  await assertInside('#right', found);
  const box = await page.locator('#right').boundingBox();
  // Right-aligned text hugs the right edge, so an underline must be past the middle.
  assert.ok(found.some((u) => u.left > box.x + box.width / 2),
    `underlines did not follow the right alignment: ${JSON.stringify(found)}`);
});

await step('a textarea inside transform: scale() lines up', async () => {
  await page.click('#scaled');
  await page.locator('#scaled').fill('I recieved the feild trip note.');
  const found = await waitFor(() => underlinesIn(page), 'underlines in the scaled textarea');
  await assertInside('#scaled', found);
  // The field is scaled to 0.75, so the underline must be scaled too: at 16px
  // text an unscaled underline would be noticeably taller.
  const heights = found.map((u) => u.height);
  assert.ok(Math.max(...heights) < 22, `underline not scaled: heights ${heights.join(', ')}`);
});

await step('a right-to-left input does not throw or draw outside the field', async () => {
  await page.click('#rtl');
  await page.locator('#rtl').fill('this sentance is rtl');
  await new Promise((r) => setTimeout(r, 900));
  const found = await underlinesIn(page);
  if (found.length) await assertInside('#rtl', found);
});

await step('contenteditable with nested markup maps offsets correctly', async () => {
  await page.click('#rich');
  await page.keyboard.press('End');
  await page.keyboard.type(' Its to late.');
  const found = await waitFor(() => underlinesIn(page), 'underlines in the rich editor');
  await assertInside('#rich', found, 6);
  // "recieved" is inside an <i> in the middle of the second block. Find the
  // rectangle the browser reports for that word and check we drew on it.
  const wordBox = await page.evaluate(() => {
    const italic = document.querySelector('#rich i');
    const r = italic.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  const hit = found.find((u) => u.left < wordBox.right && u.left + u.width > wordBox.left
    && u.top < wordBox.bottom && u.top + u.height > wordBox.top);
  assert.ok(hit, `nothing drawn over the italic "recieved": ${JSON.stringify(found)}`);
});

await step('a suggestion applied in rich markup keeps the markup', async () => {
  const before = await page.locator('#rich').innerHTML();
  const found = await underlinesIn(page);
  const wordBox = await page.evaluate(() => {
    const r = document.querySelector('#rich i').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(wordBox.x, wordBox.y);
  await new Promise((r) => setTimeout(r, 500));
  const clicked = await page.evaluate(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    const card = host.shadowRoot.querySelector('.card');
    if (!card || card.hidden) return null;
    const button = card.querySelector('button.fix');
    const text = button.textContent;
    const r = button.getBoundingClientRect();
    return { text, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert.ok(clicked, 'no card over the italic word');
  await page.mouse.click(clicked.x, clicked.y);
  await page.waitForFunction(
    (was) => document.querySelector('#rich').innerHTML !== was,
    before,
    { timeout: 5000 },
  );
  const after = await page.locator('#rich').innerHTML();
  assert.ok(after.includes('<i>'), `the <i> element was destroyed: ${after}`);
  assert.ok(after.includes('received') || after.includes('<b>there</b>'),
    `unexpected result: ${after}`);
});

await step('a controlled input keeps the fix the site echoes back', async () => {
  await page.click('#controlled');
  await page.locator('#controlled').pressSequentially('I recieved it', { delay: 10 });
  const found = await waitFor(() => underlinesIn(page), 'underlines in the controlled input');
  await page.mouse.move(found[0].left + found[0].width / 2, found[0].top + found[0].height / 2);
  await new Promise((r) => setTimeout(r, 500));
  const clicked = await page.evaluate(() => {
    const host = document.querySelector('div[data-caret="ui"]');
    const card = host.shadowRoot.querySelector('.card');
    if (!card || card.hidden) return null;
    const r = card.querySelector('button.fix').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert.ok(clicked, 'no card in the controlled input');
  await page.mouse.click(clicked.x, clicked.y);
  await new Promise((r) => setTimeout(r, 600));
  const value = await page.locator('#controlled').inputValue();
  const state = await page.locator('#controlled').getAttribute('data-state');
  assert.match(value, /received/);
  assert.equal(state, value, 'the page never saw the change');
});

await step('a field inside an iframe is checked in the iframe', async () => {
  const frameHandle = page.frame({ url: /\/frame$/ }) || page.frames().find((f) => f.url().endsWith('/frame'));
  assert.ok(frameHandle, 'no iframe found');
  await frameHandle.click('#inframe');
  await frameHandle.locator('#inframe').fill('I recieved you\'re note.');
  const found = await waitFor(() => underlinesIn(frameHandle), 'underlines inside the iframe');
  // Both must be read inside the frame: the overlay lives in the iframe's own
  // document, so its coordinates are frame-local, not page-local.
  const box = await frameHandle.evaluate(() => {
    const r = document.querySelector('#inframe').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  for (const u of found) {
    assert.ok(u.left >= box.x - 3 && u.left + u.width <= box.x + box.width + 3
      && u.top >= box.y - 3 && u.top + u.height <= box.y + box.height + 3,
    `iframe underline misplaced ${JSON.stringify(u)} vs ${JSON.stringify(box)}`);
  }
  assert.deepEqual(await underlinesIn(page), [], 'the parent page also drew underlines');
});

await step('a very long document does not lock the page up', async () => {
  await page.click('#padded');
  const paragraph = 'The principal sent an email about the meeting and their is alot to discuss. ';
  await page.locator('#padded').fill(paragraph.repeat(140));   // ~10 500 characters
  const started = Date.now();
  await waitFor(() => underlinesIn(page), 'underlines in the long document', 20000);
  const elapsed = Date.now() - started;
  const responsive = await page.evaluate(() => {
    const t = performance.now();
    document.body.getBoundingClientRect();
    return performance.now() - t < 200;
  });
  assert.ok(elapsed < 12000, `took ${elapsed}ms to draw`);
  assert.ok(responsive, 'the page was blocked');
});

await context.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
