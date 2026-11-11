// node --test test/settings.test.mjs
//
// The daily AI limit: free options are held to a ceiling, paid keys are not.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, MAX_FREE_DAILY, dailyCeiling, mergeSettings,
} from '../src/shared/defaults.js';

test('free options are capped, paid keys are not', () => {
  assert.equal(dailyCeiling('caret'), MAX_FREE_DAILY);
  assert.equal(dailyCeiling('gemini'), MAX_FREE_DAILY);
  assert.equal(dailyCeiling('openai'), 0);
  assert.equal(dailyCeiling('anthropic'), 0);
});

test('nothing picked yet, or something unknown, counts as free', () => {
  assert.equal(dailyCeiling(''), MAX_FREE_DAILY);
  assert.equal(dailyCeiling(null), MAX_FREE_DAILY);
  assert.equal(dailyCeiling('someday-provider'), MAX_FREE_DAILY);
});

test('the default limit means "whatever suits the provider", not 50 for everyone', () => {
  assert.equal(DEFAULT_SETTINGS.aiDailyLimit, 0);
  assert.equal(mergeSettings({}).aiDailyLimit, 0);
});
