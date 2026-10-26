import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';

for (const [dimension, validFrom, writtenAt] of [
  ['write time', '2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z'],
  ['valid time', '2026-01-20T00:00:00Z', '2026-01-03T00:00:00Z']
]) {
  test(`contradiction searches cannot match a fact beyond their as-of ${dimension}`, () => {
    const store = new MemoryStore({ dbPath: ':memory:' });
    store.init();
    try {
      const input = { kind: 'fact' as const, subjectKey: 'runtime', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: 1 };
      for (const text of ['runtime east', 'runtime west']) {
        store.insertAppendOnly({ ...input, text });
      }
      store.insertAppendOnly({ ...input, text: 'sentinel future', validFrom: validFrom!, writtenAt: writtenAt! });
      assert.equal(store.detectContradictions('runtime', '2026-01-10T00:00:00Z').length, 1);
      assert.deepEqual(store.detectContradictions('sentinel', '2026-01-10T00:00:00Z'), []);
      assert.equal(store.detectContradictions('sentinel', '2026-01-25T00:00:00Z').length, 3);
    } finally {
      store.close();
    }
  });
}
