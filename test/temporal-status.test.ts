import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';

test('historical reads return the status held at the requested time', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const insert = (text: string, validFrom: string, writtenAt: string) =>
      store.insertFact({ kind: 'fact', subjectKey: 'risk', text, validFrom, writtenAt, confidence: 0.8 });
    insert('risk is low', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert('risk is medium', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    insert('risk is high', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');

    assert.deepEqual(
      store.queryFacts('risk', '2026-01-05T00:00:00.000Z').map(({ text, status }) => ({ text, status })),
      [{ text: 'risk is low', status: 'active' }]
    );
    assert.deepEqual(
      store.queryFacts('risk', '2026-01-05T00:00:00.000Z', ['flagged']).map(({ text, status }) => ({ text, status })),
      [{ text: 'risk is medium', status: 'flagged' }]
    );
    assert.deepEqual(
      store.queryFacts('risk', '2026-01-10T00:00:00.000Z').map(({ text, status }) => ({ text, status })),
      [{ text: 'risk is high', status: 'active' }]
    );
  } finally {
    store.close();
  }
});
