import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';

test('scheduled revisions replace facts only when effective, in every import order', () => {
  const events = [
    { text: 'runtime one', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z' },
    { text: 'runtime two', validFrom: '2026-01-10T00:00:00Z', writtenAt: '2026-01-02T00:00:00Z' },
    { text: 'runtime three', validFrom: '2026-01-20T00:00:00Z', writtenAt: '2026-01-03T00:00:00Z' }
  ];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const store = new MemoryStore({ dbPath: ':memory:' });
    store.init();
    try {
      for (const index of order) {
        store.insertFact({ kind: 'fact', subjectKey: 'runtime', confidence: 1, ...events[index]! });
      }
      for (const [asOf, expected] of [
        ['2026-01-01T00:00:00Z', 'runtime one'],
        ['2026-01-05T00:00:00Z', 'runtime one'],
        ['2026-01-10T00:00:00Z', 'runtime two'],
        ['2026-01-15T00:00:00Z', 'runtime two'],
        ['2026-01-20T00:00:00Z', 'runtime three']
      ]) {
        assert.deepEqual(store.queryFacts('runtime', asOf!).map(({ text }) => text), [expected], `${order} at ${asOf}`);
        assert.deepEqual(store.detectContradictions('runtime', asOf!), [], `${order} at ${asOf}`);
      }
      const rows = store.getAllFactsForSubject('runtime');
      assert.equal(rows.find(({ text }) => text === 'runtime one')?.supersededAt, '2026-01-10T00:00:00.000Z');
      assert.equal(rows.find(({ text }) => text === 'runtime two')?.supersededAt, '2026-01-20T00:00:00.000Z');
    } finally {
      store.close();
    }
  }
});
