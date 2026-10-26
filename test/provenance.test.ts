import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';

test('duplicate governed writes preserve first provenance without validating replacement lineage', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const input = { kind: 'fact' as const, subjectKey: 'runtime', text: 'ready', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: 1, sourceTrajectory: 'original' };
    const original = store.insertFact(input);
    const duplicate = store.insertFact({ ...input, sourceTrajectory: 'replacement', derivedFrom: ['does-not-exist'] });
    assert.equal(duplicate.kind, 'idempotent-hit');
    assert.equal(duplicate.id, original.id);
    assert.equal(store.queryFacts('runtime', input.writtenAt)[0]?.sourceTrajectory, 'original');
    assert.equal(store.queryFacts('runtime', input.writtenAt)[0]?.derivedFrom, null);
    assert.throws(() => store.insertFact({ ...input, text: 'different', derivedFrom: ['does-not-exist'] }), /derived_from/);
    assert.equal(store.queryFacts('runtime', input.writtenAt).length, 1);
  } finally {
    store.close();
  }
});
