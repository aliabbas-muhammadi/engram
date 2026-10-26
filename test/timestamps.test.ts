import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertIsoUtcTimestamp } from '../src/utils.ts';

test('timestamps reject calendar dates and hours that Date silently rolls forward', () => {
  for (const value of [
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z'
  ]) {
    assert.throws(() => assertIsoUtcTimestamp(value), /invalid timestamp/);
  }
});

test('timestamps accept leap days and normalize supported fractional precision', () => {
  for (const value of ['2024-02-29T12:34:56Z', '2024-02-29T12:34:56.1Z', '2024-02-29T12:34:56.123456789Z']) {
    assert.equal(assertIsoUtcTimestamp(value).value, new Date(value).toISOString());
  }
});
