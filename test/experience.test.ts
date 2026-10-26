import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordOutcome, retrieveExperience } from '../src/experience.ts';
import { MemoryStore } from '../src/store.ts';

test('experience parameters preserve own __proto__ keys without changing prototypes', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();
  try {
    const parameters = JSON.parse('{"z":1,"__proto__":{"audit":"keep"},"a":2}');
    const at = '2026-01-01T00:00:00.000Z';
    recordOutcome(store, 'deploy', true, parameters, at);
    assert.deepEqual(retrieveExperience(store, 'deploy', { asOf: at }), [
      'deploy {"__proto__":{"audit":"keep"},"a":2,"z":1} success'
    ]);
    assert.equal(Object.getPrototypeOf(parameters), Object.prototype);
  } finally {
    store.close();
  }
});
