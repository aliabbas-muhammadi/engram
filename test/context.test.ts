import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeIncomingMemory } from '../src/memory.ts';

test('blank context tags normalize to the same absent scope as null', () => {
  const input = { kind: 'fact' as const, subjectKey: 'runtime', text: 'ready', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: 1 };
  for (const contextTag of [undefined, null, '', '  ', '\t\n']) {
    assert.equal(normalizeIncomingMemory({ ...input, contextTag }).contextTag, null);
  }
  assert.equal(normalizeIncomingMemory({ ...input, contextTag: ' prod ' }).contextTag, 'prod');
});
