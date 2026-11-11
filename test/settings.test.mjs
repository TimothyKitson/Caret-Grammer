// node --test test/settings.test.mjs
//
// The daily AI limit: free options are held to a ceiling, paid keys are not.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, MAX_FREE_DAILY, dailyCeiling, mergeSettings,
  QUICK_DEFAULT_DAILY, QUICK_MAX_DAILY, clampQuickLimit,
  normalizeSite, siteBlocked, blockingEntries, addCustomWord, entryCovers,
} from '../src/shared/defaults.js';

test('free options are capped, paid keys are not', () => {
  assert.equal(dailyCeiling('caret'), 20, 'the big model on the shared server: 20 a day');
  assert.equal(dailyCeiling('gemini'), 50, "Gemini's free tier is the person's own");
  assert.equal(MAX_FREE_DAILY, 50);
  assert.equal(dailyCeiling('openai'), 0);
  assert.equal(dailyCeiling('anthropic'), 0);
});

test('nothing picked yet, or something unknown, gets the tightest free cap', () => {
  assert.equal(dailyCeiling(''), 20);
  assert.equal(dailyCeiling(null), 20);
  assert.equal(dailyCeiling('someday-provider'), 20);
});

test('the default limit means "whatever suits the provider", not 50 for everyone', () => {
  assert.equal(DEFAULT_SETTINGS.aiDailyLimit, 0);
  assert.equal(mergeSettings({}).aiDailyLimit, 0);
});

test('the quick check is off by default, 30 a day, never more than 80', () => {
  assert.equal(DEFAULT_SETTINGS.quickAiEnabled, false);
  assert.equal(QUICK_DEFAULT_DAILY, 30);
  assert.equal(QUICK_MAX_DAILY, 80);
  const fresh = mergeSettings({});
  assert.equal(fresh.quickAiDailyLimit, 30);
  assert.deepEqual(fresh.quickAiUsage, { day: '', count: 0 });
  assert.equal(clampQuickLimit(250), 80);
  assert.equal(clampQuickLimit(0), 1);
  assert.equal(clampQuickLimit(64.4), 64);
  assert.equal(clampQuickLimit('nonsense'), 30);
  // A stored value someone edited by hand cannot get past the ceiling either.
  assert.equal(mergeSettings({ quickAiDailyLimit: 5000 }).quickAiDailyLimit, 80);
  assert.equal(mergeSettings({ quickAiEnabled: 'yes' }).quickAiEnabled, false);
});

test('a pasted address becomes the site it belongs to', () => {
  assert.equal(normalizeSite('https://englewoodfl.ignitiaschools.com/owsoo/studentAssignment/index?eh=5'), 'englewoodfl.ignitiaschools.com');
  assert.equal(normalizeSite('ignitiaschools.com'), 'ignitiaschools.com');
  assert.equal(normalizeSite('  WWW.Example.com/some/page  '), 'example.com');
  assert.equal(normalizeSite('*.docs.google.com'), 'docs.google.com');
  assert.equal(normalizeSite('localhost:3000'), 'localhost');
  assert.equal(normalizeSite('not a website'), '');
  assert.equal(normalizeSite('justoneword'), '');
  assert.equal(normalizeSite(''), '');
});

test('a site on the list covers its subdomains, and nothing that only looks like it', () => {
  const list = ['ignitiaschools.com'];
  assert.equal(siteBlocked(list, 'https://englewoodfl.ignitiaschools.com/x'), true);
  assert.equal(siteBlocked(list, 'https://www.ignitiaschools.com/'), true);
  assert.equal(siteBlocked(list, 'https://ignitiaschools.com.evil.example/'), false);
  assert.equal(siteBlocked(list, 'https://notignitiaschools.com/'), false);
  assert.deepEqual(blockingEntries(['a.com', 'x.a.com', 'b.com'], 'https://y.x.a.com/'), ['a.com', 'x.a.com']);
});

test('added words keep their capitals and are never stored twice', () => {
  assert.deepEqual(addCustomWord(['apple', 'ignitia'], 'Ignitia'), ['apple', 'Ignitia']);
  const list = ['Ignitia'];
  assert.equal(addCustomWord(list, 'ignitia'), list, 'a lower-case add does not undo the capital');
  assert.equal(addCustomWord(list, 'Ignitia'), list);
  assert.deepEqual(addCustomWord(['zebra'], 'McDonald'), ['McDonald', 'zebra']);
  assert.deepEqual(addCustomWord([], '   '), []);
});

test("'local' (files and pages with no host) does not cover every .local host", () => {
  assert.equal(siteBlocked(['local'], 'file:///C:/notes/page.html'), true);
  assert.equal(siteBlocked(['local'], 'http://printer.local/'), false);
  assert.equal(siteBlocked(['local'], 'http://myapp.local:3000/'), false);
  assert.equal(entryCovers('local', 'printer.local'), false);
  assert.equal(entryCovers('printer.local', 'printer.local'), true);
});
