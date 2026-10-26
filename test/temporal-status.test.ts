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

test('later writes do not expose future supersession metadata in historical reads', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const input = { kind: 'fact' as const, subjectKey: 'runtime', text: 'runtime old', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: 1 };
    store.insertFact(input);
    const before = store.queryFacts('runtime', '2026-01-15T00:00:00Z');
    store.insertFact({ ...input, text: 'runtime new', validFrom: '2026-01-10T00:00:00Z', writtenAt: '2026-01-20T00:00:00Z' });
    const after = store.queryFacts('runtime', '2026-01-15T00:00:00Z');
    assert.deepEqual(after, before);
    assert.equal(after[0]?.supersededBy, null);
    assert.equal(after[0]?.supersededAt, null);
    assert.equal(store.queryFacts('runtime', '2026-01-25T00:00:00Z')[0]?.text, 'runtime new');
  } finally {
    store.close();
  }
});
