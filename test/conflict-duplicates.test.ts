import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConflictPlan } from '../src/conflict.ts';
import { normalizeIncomingMemory } from '../src/memory.ts';

test('public conflict planning recognizes duplicate ids and preserves the stored status', () => {
  const incoming = normalizeIncomingMemory({ kind: 'fact', subjectKey: 'runtime', text: 'ready', validFrom: '2026-01-01T00:00:00Z', writtenAt: '2026-01-01T00:00:00Z', confidence: 1 });
  const existing = { ...incoming, status: 'flagged' as const };
  const plan = resolveConflictPlan(incoming, [existing], incoming.writtenAt);
  assert.equal(plan.incomingIsDuplicate, true);
  assert.equal(plan.incomingStatus, 'flagged');
  assert.deepEqual(plan.supersessionLinks, []);
  assert.equal(plan.logs[0]?.rule, 'R3_DUPLICATE');
  assert.equal(incoming.status, 'active');
  assert.equal(existing.status, 'flagged');
});
