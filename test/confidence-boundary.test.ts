import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/store.ts';

for (const reverse of [false, true]) {
  test(`the confidence floor includes an exact 0.1 drop in ${reverse ? 'reverse' : 'forward'} write order`, () => {
    for (const [olderConfidence, newerConfidence] of [[0.8, 0.7], [0.7, 0.6], [0.3, 0.2]]) {
      const store = new MemoryStore({ dbPath: ':memory:' });
      store.init();
      try {
        const events = [
          { text: 'runtime old', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: olderConfidence! },
          { text: 'runtime new', validFrom: '2026-01-02T00:00:00Z', writtenAt: '2026-01-02T00:00:00Z', confidence: newerConfidence! }
        ];
        if (reverse) events.reverse();
        for (const event of events) store.insertFact({ kind: 'fact', subjectKey: 'runtime', ...event });
        assert.deepEqual(store.queryFacts('runtime', '2026-01-03T00:00:00Z').map(({ text }) => text), ['runtime new']);
        assert.deepEqual(store.detectContradictions('runtime', '2026-01-03T00:00:00Z'), []);
      } finally {
        store.close();
      }
    }
  });
}

test('a confidence drop larger than 0.1 remains flagged', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const input = { kind: 'fact' as const, subjectKey: 'runtime', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z' };
    store.insertFact({ ...input, text: 'runtime old', confidence: 0.8 });
    const result = store.insertFact({ ...input, text: 'runtime new', confidence: 0.699999, validFrom: '2026-01-02T00:00:00Z', writtenAt: '2026-01-02T00:00:00Z' });
    assert.equal(result.kind, 'conflicted+flagged');
    assert.equal(store.queryFacts('runtime', '2026-01-03T00:00:00Z')[0]?.text, 'runtime old');
  } finally {
    store.close();
  }
});
