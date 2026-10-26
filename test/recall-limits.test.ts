import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, RecallService, recordOutcome } from '../src/index.ts';

test('recall rejects invalid limits and respects zero and positive limits', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const at = '2026-01-01T00:00:00.000Z';
    store.insertFact({ kind: 'fact', subjectKey: 'runtime', text: 'runtime ready', validFrom: at, writtenAt: at, confidence: 1 });
    recordOutcome(store, 'deploy', true, {}, at);
    const recall = new RecallService(store);
    for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => recall.recallAsOf('runtime', at, limit), /limit/);
      assert.throws(() => store.queryExperiences('deploy', at, limit), /limit/);
    }
    assert.equal(recall.recallAsOf('runtime', at, 0).length, 0);
    assert.equal(store.queryExperiences('deploy', at, 0).length, 0);
    assert.equal(recall.recallAsOf('runtime', at, 1).length, 1);
    assert.equal(store.queryExperiences('deploy', at, 1).length, 1);
  } finally {
    store.close();
  }
});
