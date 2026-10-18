import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { MemoryStore, SCHEMA_VERSION } from '../src/store.ts';
import { buildSafeFtsMatch } from '../src/utils.ts';
import { deterministicCandidateOrder, resolveConflictPlan } from '../src/conflict.ts';
import { normalizeIncomingMemory } from '../src/memory.ts';
import { runBenchmark, printSummary, assertGate, loadDataset } from '../bench/run.ts';
import type { MemoryInput } from '../src/types.ts';
import type { Clock } from '../src/clock.ts';

function fixedClock(at: string): Clock {
  return { nowUTC: () => at };
}

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engram-test-${prefix}-`));
  return join(dir, `${randomBytes(6).toString('hex')}.sqlite`);
}

function closeAndDelete(store: MemoryStore, dbPath: string): void {
  try {
    store.close();
  } finally {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // ignore
    }

    try {
      rmSync(join(dbPath, '..'), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function runAndSortSnapshot(subjectKey: string, events: MemoryInput[]): string[] {
  const dbPath = tempDbPath('perm');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  for (const event of events) {
    const result = store.insertFact(event);
    assert.notEqual(result.kind, 'error');
  }

  const rows = store.rawConnection()
    .prepare(
      `SELECT id,subject_key,kind,text,valid_from,written_at,status,context_tag,superseded_by
       FROM memories
       WHERE subject_key = ?
       ORDER BY valid_from ASC, written_at ASC, id ASC`
    )
    .all(subjectKey) as Array<Record<string, unknown>>;

  closeAndDelete(store, dbPath);
  return rows.map((row) => JSON.stringify(row));
}

function getTopFact(store: MemoryStore, query: string, asOf: string): string | null {
  const rows = store.queryFacts(query, asOf, ['active', 'contextual']);
  return rows[0]?.id ?? null;
}

function getAllMemories(store: MemoryStore, subjectKey: string) {
  return store.getAllFactsForSubject(subjectKey);
}

test('recall contract: normal revision by valid_from then written_at', () => {
  const dbPath = tempDbPath('normal');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-15T00:00:00.000Z') });
  store.init();

  const first = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.timeline',
    text: 'state v1',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.72,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  const second = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.timeline',
    text: 'state v2',
    validFrom: '2026-01-10T00:00:00.000Z',
    writtenAt: '2026-01-12T00:00:00.000Z',
    confidence: 0.81,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(first.kind, 'created');
  assert.equal(second.kind, 'conflicted+resolved');

  assert.equal(getTopFact(store, 'state', '2026-01-05T00:00:00.000Z'), getTopFact(store, 'state', '2026-01-05T00:00:00.000Z'));
  assert.equal(store.queryFacts('state', '2026-01-05T00:00:00.000Z', ['active', 'contextual'])[0]?.text, 'state v1');
  assert.equal(store.queryFacts('state', '2026-02-01T00:00:00.000Z', ['active', 'contextual'])[0]?.text, 'state v2');

  closeAndDelete(store, dbPath);
});

test('recall contract: late-learned revision with newer valid_from supersedes history', () => {
  const dbPath = tempDbPath('late-learned');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-03-10T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.review',
    text: 'v1',
    validFrom: '2026-02-01T00:00:00.000Z',
    writtenAt: '2026-02-01T00:00:00.000Z',
    confidence: 0.7,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  const late = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.review',
    text: 'v2',
    validFrom: '2026-02-15T00:00:00.000Z',
    writtenAt: '2026-03-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(late.kind, 'conflicted+resolved');
  assert.equal(store.queryFacts('review', '2026-03-02T00:00:00.000Z', ['active', 'contextual'])[0]?.text, 'v2');

  closeAndDelete(store, dbPath);
});

test('recall contract: older valid_from backfill stays as evidence and becomes flagged', () => {
  const dbPath = tempDbPath('retro');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-04-10T00:00:00.000Z') });
  store.init();

  const base = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.correction',
    text: 'primary',
    validFrom: '2026-03-01T00:00:00.000Z',
    writtenAt: '2026-03-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });
  assert.equal(base.kind, 'created');

  const retro = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.correction',
    text: 'retro-corrected',
    validFrom: '2026-02-01T00:00:00.000Z',
    writtenAt: '2026-04-01T00:00:00.000Z',
    confidence: 0.85,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(retro.kind, 'conflicted+flagged');
  assert.equal(store.queryFacts('correction', '2026-04-10T00:00:00.000Z', ['active', 'contextual'])[0]?.text, 'primary');

  const flagged = store.queryFacts('correction', '2026-04-10T00:00:00.000Z', ['active', 'contextual', 'flagged']).find((row) => row.status === 'flagged');
  assert.ok(flagged !== undefined);
  assert.equal(flagged?.text, 'retro-corrected');

  closeAndDelete(store, dbPath);
});

test('recall contract: same-event-time contradiction stays flagged', () => {
  const dbPath = tempDbPath('same-time');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-01-20T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.same',
    text: 'A',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  const second = store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.same',
    text: 'B',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-05T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(second.kind, 'conflicted+flagged');
  assert.equal(store.queryFacts('same', '2026-01-10T00:00:00.000Z', ['active', 'contextual', 'flagged']).some((row) => row.status === 'flagged'), true);

  closeAndDelete(store, dbPath);
});

test('recall contract: query before write-time returns no facts', () => {
  const dbPath = tempDbPath('before-write');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-05-01T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.future',
    text: 'future-state',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-06-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(store.queryFacts('future-state', '2026-05-01T00:00:00.000Z', ['active', 'contextual']).length, 0);

  closeAndDelete(store, dbPath);
});

test('recall contract: query before valid-time returns no facts', () => {
  const dbPath = tempDbPath('before-valid');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-05-01T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'subject.effective',
    text: 'old',
    validFrom: '2026-07-01T00:00:00.000Z',
    writtenAt: '2026-06-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  assert.equal(store.queryFacts('old', '2026-06-15T00:00:00.000Z', ['active', 'contextual']).length, 0);

  closeAndDelete(store, dbPath);
});

test('recall contract: a flagged fact superseded later is still flagged in earlier as-of reads', () => {
  const dbPath = tempDbPath('flagged-superseded');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  const fact = (text: string, validFrom: string, writtenAt: string) =>
    store.insertFact({ kind: 'fact', subjectKey: 'subject.risk', text, validFrom, writtenAt, confidence: 0.8 });

  assert.equal(fact('risk is low', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').kind, 'created');
  assert.equal(fact('risk is medium', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').kind, 'conflicted+flagged');
  assert.equal(fact('risk is high', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z').kind, 'conflicted+resolved');

  // On 01-05 "medium" was a contested claim under review, not the current fact.
  const asOf = '2026-01-05T00:00:00.000Z';
  assert.deepEqual(store.queryFacts('risk', asOf).map((row) => row.text), ['risk is low']);
  assert.deepEqual(
    store.queryFacts('risk', asOf, ['flagged']).map((row) => row.text),
    ['risk is medium']
  );
  assert.deepEqual(store.queryFacts('risk', '2026-01-20T00:00:00.000Z').map((row) => row.text), ['risk is high']);

  closeAndDelete(store, dbPath);
});

test('recall contract: a backdated write re-supersedes history without losing prior status', () => {
  const dbPath = tempDbPath('out-of-order');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  const fact = (text: string, validFrom: string, writtenAt: string) =>
    store.insertFact({ kind: 'fact', subjectKey: 'subject.level', text, validFrom, writtenAt, confidence: 0.8 });

  const low = fact('level is low', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  fact('level is high', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
  // Learned on 01-05 but recorded after the 01-10 revision: "low" was already superseded.
  const medium = fact('level is medium', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
  assert.equal(medium.kind, 'conflicted+resolved');

  const lowRow = store
    .rawConnection()
    .prepare('SELECT status, prior_status, superseded_by, superseded_at FROM memories WHERE id = ?')
    .get(low.id) as Record<string, unknown>;
  assert.deepEqual({ ...lowRow }, {
    status: 'superseded',
    prior_status: 'active',
    superseded_by: medium.id,
    superseded_at: '2026-01-05T00:00:00.000Z'
  });

  assert.deepEqual(store.queryFacts('level', '2026-01-03T00:00:00.000Z').map((row) => row.text), ['level is low']);
  assert.deepEqual(store.queryFacts('level', '2026-01-07T00:00:00.000Z').map((row) => row.text), ['level is medium']);

  closeAndDelete(store, dbPath);
});

test('recall contract: a backdated write is superseded by a later-effective fact recorded before it', () => {
  const dbPath = tempDbPath('backdated-superseded');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  const fact = (text: string, validFrom: string, writtenAt: string) =>
    store.insertFact({ kind: 'fact', subjectKey: 'subject.tier', text, validFrom, writtenAt, confidence: 0.8 });

  fact('tier is bronze', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const gold = fact('tier is gold', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
  // Learned on 01-05 but recorded after the 01-10 revision.
  const silver = fact('tier is silver', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
  assert.equal(silver.kind, 'conflicted+resolved');
  assert.equal(silver.status, 'superseded');

  // Had it arrived on time, gold would have superseded silver on 01-10.
  const silverRow = store
    .rawConnection()
    .prepare('SELECT status, prior_status, superseded_by, superseded_at FROM memories WHERE id = ?')
    .get(silver.id) as Record<string, unknown>;
  assert.deepEqual({ ...silverRow }, {
    status: 'superseded',
    prior_status: 'active',
    superseded_by: gold.id,
    superseded_at: '2026-01-10T00:00:00.000Z'
  });

  assert.deepEqual(store.queryFacts('tier', '2026-01-07T00:00:00.000Z').map((row) => row.text), ['tier is silver']);
  assert.deepEqual(store.queryFacts('tier', '2026-01-20T00:00:00.000Z').map((row) => row.text), ['tier is gold']);
  assert.equal(store.detectContradictions('tier', '2026-01-20T00:00:00.000Z', { mode: 'governed' }).length, 0);

  const logged = store
    .rawConnection()
    .prepare("SELECT incoming_id, action, rule FROM resolutions WHERE existing_id = ? AND action = 'supersede'")
    .all(silver.id) as Array<Record<string, unknown>>;
  assert.deepEqual(logged.map((row) => ({ ...row })), [{ incoming_id: gold.id, action: 'supersede', rule: 'R1_SUPERSEDE' }]);

  closeAndDelete(store, dbPath);
});

test('recall contract: a backdated write stays current when no later fact would have superseded it', () => {
  const dbPath = tempDbPath('backdated-kept');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  const fact = (subjectKey: string, text: string, validFrom: string, writtenAt: string, extra = {}) =>
    store.insertFact({ kind: 'fact', subjectKey, text, validFrom, writtenAt, confidence: 0.8, ...extra });

  // Later fact in another context: R2 coexistence, not supersession.
  fact('subject.ctx', 'ctx is staging-only', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z', { contextTag: 'staging' });
  assert.equal(fact('subject.ctx', 'ctx is prod-only', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', { contextTag: 'prod' }).status, 'active');

  // Later fact far less confident: R3 would have flagged it instead of applying it.
  fact('subject.conf', 'conf is weak', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z', { confidence: 0.5 });
  assert.equal(fact('subject.conf', 'conf is strong', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', { confidence: 0.9 }).status, 'active');

  // Later fact with the same valid time: a contradiction, not a revision.
  fact('subject.same', 'same is left', '2026-01-05T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
  assert.equal(fact('subject.same', 'same is right', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z').status, 'active');

  closeAndDelete(store, dbPath);
});

test('context-aware R1/R2 precedence: prod and staging coexistence', () => {
  const dbPath = tempDbPath('contexts');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-08-20T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'deploy.pipeline',
    text: 'deploy prod policy v1',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-02T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'prod'
  });

  const s1 = store.insertFact({
    kind: 'fact',
    subjectKey: 'deploy.pipeline',
    text: 'deploy stage policy v1',
    validFrom: '2026-01-03T00:00:00.000Z',
    writtenAt: '2026-01-03T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'staging'
  });
  assert.equal(s1.kind, 'created');

  const s2 = store.insertFact({
    kind: 'fact',
    subjectKey: 'deploy.pipeline',
    text: 'deploy stage policy v2',
    validFrom: '2026-02-01T00:00:00.000Z',
    writtenAt: '2026-02-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'staging'
  });
  assert.equal(s2.kind, 'conflicted+resolved');

  store.insertFact({
    kind: 'fact',
    subjectKey: 'deploy.pipeline',
    text: 'deploy qa policy v1',
    validFrom: '2026-01-04T00:00:00.000Z',
    writtenAt: '2026-01-04T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'qa'
  });

  const rows = getAllMemories(store, 'deploy.pipeline');
  const prod = rows.find((row) => row.contextTag === 'prod');
  const stageOld = rows.find((row) => row.contextTag === 'staging' && row.text === 'deploy stage policy v1');
  const stageNew = rows.find((row) => row.contextTag === 'staging' && row.text === 'deploy stage policy v2');
  const qa = rows.find((row) => row.contextTag === 'qa');

  assert.equal(prod?.status, 'active');
  assert.equal(stageOld?.status, 'superseded');
  assert.equal(stageNew?.status, 'active');
  assert.equal(qa?.status, 'active');
  assert.ok(stageOld?.supersededBy === stageNew?.id);

  closeAndDelete(store, dbPath);
});

test('governed contradiction detection honors distinct-context coexistence', () => {
  const dbPath = tempDbPath('context-contradictions');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-09-01T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'ctx.policy',
    text: 'prod says auto',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'prod'
  });

  store.insertFact({
    kind: 'fact',
    subjectKey: 'ctx.policy',
    text: 'staging says manual',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'staging'
  });

  const governedPairs = store.detectContradictions('ctx policy', '2026-01-02T00:00:00.000Z', { mode: 'governed' });
  const appendPairs = store.detectContradictions('ctx policy', '2026-01-02T00:00:00.000Z', { mode: 'append-only' });

  assert.equal(governedPairs.length, 0);
  assert.equal(appendPairs.length, 1);

  closeAndDelete(store, dbPath);
});

test('insertion-order invariance for equivalent candidate permutations', () => {
  const events: MemoryInput[] = [
    {
      kind: 'fact',
      subjectKey: 'perm.subject',
      text: 'base-prod',
      validFrom: '2026-01-01T00:00:00.000Z',
      writtenAt: '2026-01-01T00:00:00.000Z',
      confidence: 0.9,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'prod'
    },
    {
      kind: 'fact',
      subjectKey: 'perm.subject',
      text: 'base-stage',
      validFrom: '2026-01-01T00:00:00.000Z',
      writtenAt: '2026-01-01T00:00:00.000Z',
      confidence: 0.8,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'staging'
    },
    {
      kind: 'fact',
      subjectKey: 'perm.subject',
      text: 'stage-rev',
      validFrom: '2026-01-10T00:00:00.000Z',
      writtenAt: '2026-01-10T00:00:00.000Z',
      confidence: 0.95,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'staging'
    },
    {
      kind: 'fact',
      subjectKey: 'perm.subject',
      text: 'qa',
      validFrom: '2026-01-03T00:00:00.000Z',
      writtenAt: '2026-01-03T00:00:00.000Z',
      confidence: 0.85,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'qa'
    }
  ];

  const first = runAndSortSnapshot('perm.subject', events);
  const second = runAndSortSnapshot('perm.subject', [events[1], events[0], events[3], events[2]]);

  assert.deepEqual(first, second);
});

test('out-of-order writes converge to the same state as in-order writes', () => {
  const event = (text: string, day: string): MemoryInput => ({
    kind: 'fact',
    subjectKey: 'order.tier',
    text,
    validFrom: `2026-01-${day}T00:00:00.000Z`,
    writtenAt: `2026-01-${day}T00:00:00.000Z`,
    confidence: 0.8
  });
  const [bronze, silver, gold] = [event('tier is bronze', '01'), event('tier is silver', '05'), event('tier is gold', '10')];

  const inOrder = runAndSortSnapshot('order.tier', [bronze, silver, gold]);
  assert.deepEqual(runAndSortSnapshot('order.tier', [bronze, gold, silver]), inOrder);
  assert.deepEqual(runAndSortSnapshot('order.tier', [gold, silver, bronze]), inOrder);
});

test('conflict planning is pure and deterministic with multi-candidate set', () => {
  const incoming = normalizeIncomingMemory({
    kind: 'fact',
    subjectKey: 'pure.subject',
    text: 'gamma',
    validFrom: '2026-01-03T00:00:00.000Z',
    writtenAt: '2026-01-03T00:00:00.000Z',
    confidence: 0.9,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null,
    contextTag: 'prod'
  });

  const candidates = deterministicCandidateOrder([
    normalizeIncomingMemory({
      kind: 'fact',
      subjectKey: 'pure.subject',
      text: 'alpha',
      validFrom: '2026-01-01T00:00:00.000Z',
      writtenAt: '2026-01-01T00:00:00.000Z',
      confidence: 0.8,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'prod'
    }),
    normalizeIncomingMemory({
      kind: 'fact',
      subjectKey: 'pure.subject',
      text: 'beta',
      validFrom: '2026-01-02T00:00:00.000Z',
      writtenAt: '2026-01-02T00:00:00.000Z',
      confidence: 0.5,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'staging'
    }),
    normalizeIncomingMemory({
      kind: 'fact',
      subjectKey: 'pure.subject',
      text: 'gamma',
      validFrom: '2026-01-05T00:00:00.000Z',
      writtenAt: '2026-01-05T00:00:00.000Z',
      confidence: 0.7,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null,
      contextTag: 'prod'
    })
  ]);

  const before = JSON.stringify(candidates.map((candidate) => ({ ...candidate })));
  const plan = resolveConflictPlan(incoming, candidates, '2026-01-03T00:00:00.000Z');
  const after = JSON.stringify(candidates.map((candidate) => ({ ...candidate })));

  assert.equal(before, after);
  assert.equal(plan.steps.some((step) => step.action === 'supersede'), true);
  assert.equal(plan.steps.some((step) => step.action === 'contextualize'), true);
  assert.equal(plan.incomingStatus, 'active');
});

test('safe FTS sanitizer neutralizes control operators and quoting safely', () => {
  const cases = [
    'alpha "beta"',
    "it's a test",
    'value*',
    'foo-bar',
    '(parentheses)',
    'foo OR bar AND baz',
    'near "x"',
    '   '
  ];

  for (const c of cases) {
    const safe = buildSafeFtsMatch(c);
    if (!c.trim()) {
      assert.equal(safe, null);
      continue;
    }

    assert.ok(safe);
    assert.ok(!safe.includes('*'));
    assert.ok(!safe.includes('-'));
    assert.ok(!safe.includes('('));
    assert.ok(!safe.includes(')'));
    assert.ok(!/\b(or|and|not|near)\b/i.test(safe));
    assert.equal(buildSafeFtsMatch(safe), safe);
  }
});

test('FTS trigger integrity test fails deterministic-retrieval when ai trigger is missing', () => {
  const dbPath = tempDbPath('fts');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  store.init();

  const triggers = store
    .rawConnection()
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memories_fts_%' ORDER BY name")
    .all() as Array<{ name: string }>;

  assert.deepEqual(
    triggers.map((row) => row.name),
    ['memories_fts_ad', 'memories_fts_ai', 'memories_fts_au']
  );

  const seed: MemoryInput = {
    kind: 'fact',
    subjectKey: 'trigger.test',
    text: 'safe token',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  };

  store.insertFact(seed);
  assert.equal(store.queryFacts('safe', '2026-02-01T00:00:00.000Z', ['active', 'contextual']).length, 1);

  store.rawConnection().exec('DROP TRIGGER memories_fts_ai');
  const direct = normalizeIncomingMemory({
    kind: 'fact',
    subjectKey: 'trigger.test',
    text: 'direct miss',
    validFrom: '2026-01-02T00:00:00.000Z',
    writtenAt: '2026-01-02T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  const db = store.rawConnection();
  db.prepare(`
    INSERT INTO memories (id,kind,subject_key,text,valid_from,written_at,confidence,source_trajectory,source_turn,derived_from,status,superseded_by,superseded_at,context_tag)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    direct.id,
    direct.kind,
    direct.subjectKey,
    direct.text,
    direct.validFrom,
    direct.writtenAt,
    direct.confidence,
    direct.sourceTrajectory,
    direct.sourceTurn,
    direct.derivedFrom,
    direct.status,
    direct.supersededBy,
    direct.supersededAt,
    direct.contextTag
  );

  assert.equal(store.queryFacts('direct', '2026-02-01T00:00:00.000Z', ['active', 'contextual']).length, 0);
  closeAndDelete(store, dbPath);
});

test('FTS index stays consistent when memories are updated or deleted', () => {
  const dbPath = tempDbPath('fts-sync');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  store.init();

  const base = {
    kind: 'fact' as const,
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  };
  const edited = store.insertFact({ ...base, subjectKey: 'sync.edited', text: 'original wording' });
  const removed = store.insertFact({ ...base, subjectKey: 'sync.removed', text: 'doomed wording' });

  const db = store.rawConnection();
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run('revised wording', edited.id);
  db.prepare('DELETE FROM memories WHERE id = ?').run(removed.id);

  // rank = 1 also compares the index against the external content table;
  // SQLite throws if they drifted apart.
  db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)");

  const asOf = '2026-02-01T00:00:00.000Z';
  assert.equal(store.queryFacts('original', asOf).length, 0);
  assert.equal(store.queryFacts('revised', asOf)[0]?.id, edited.id);
  assert.equal(store.queryFacts('doomed', asOf).length, 0);

  closeAndDelete(store, dbPath);
});

test('init migrates a legacy text-only FTS index to subject-aware recall', () => {
  const dbPath = tempDbPath('migrate-fts');
  const legacy = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  legacy.init();
  legacy.insertFact({
    kind: 'fact',
    subjectKey: 'legacy.cadence',
    text: 'weekly',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.8
  });

  // Recreate the schema engram shipped before subject keys were indexed.
  legacy.rawConnection().exec(`
    DROP TRIGGER memories_fts_ai;
    DROP TRIGGER memories_fts_ad;
    DROP TRIGGER memories_fts_au;
    DROP TABLE memories_fts;
    CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='rowid');
    CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
    PRAGMA user_version = 0;
  `);
  assert.equal(legacy.queryFacts('cadence', '2026-02-01T00:00:00.000Z').length, 0);
  legacy.close();

  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  store.init();
  const db = store.rawConnection();

  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)");
  assert.equal(store.queryFacts('cadence', '2026-02-01T00:00:00.000Z')[0]?.text, 'weekly');

  closeAndDelete(store, dbPath);
});

test('init backfills prior status for facts superseded before schema v2', () => {
  const dbPath = tempDbPath('migrate-prior-status');
  const v1 = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  v1.init();
  const fact = (text: string, validFrom: string, writtenAt: string) =>
    v1.insertFact({ kind: 'fact', subjectKey: 'subject.risk', text, validFrom, writtenAt, confidence: 0.8 });
  fact('risk is low', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  fact('risk is medium', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  fact('risk is high', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z');

  // Recreate a v1 database: same rows, no record of status before supersession.
  v1.rawConnection().exec('ALTER TABLE memories DROP COLUMN prior_status; PRAGMA user_version = 1;');
  v1.close();

  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  store.init();

  // The flag decision logged for "medium" on insert is the evidence it was contested.
  const asOf = '2026-01-05T00:00:00.000Z';
  assert.deepEqual(store.queryFacts('risk', asOf).map((row) => row.text), ['risk is low']);
  assert.deepEqual(store.queryFacts('risk', asOf, ['flagged']).map((row) => row.text), ['risk is medium']);

  closeAndDelete(store, dbPath);
});

test('init refuses a database written by a newer schema version', () => {
  const dbPath = tempDbPath('migrate-newer');
  const first = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  first.init();
  first.rawConnection().exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  first.close();

  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-03-03T00:00:00.000Z') });
  assert.throws(() => store.init(), /newer than this engram/);

  closeAndDelete(store, dbPath);
});

test('duplicate-memory insert is idempotent and retains first provenance', () => {
  const dbPath = tempDbPath('dup');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-01-01T00:00:00.000Z') });
  store.init();

  const first = store.insertFact({
    kind: 'fact',
    subjectKey: 'dup.subject',
    text: 'same',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.7,
    sourceTrajectory: 'trajectory-a',
    sourceTurn: 1,
    derivedFrom: null
  });

  const second = store.insertFact({
    kind: 'fact',
    subjectKey: 'dup.subject',
    text: 'same',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.7,
    sourceTrajectory: 'trajectory-b',
    sourceTurn: 2,
    derivedFrom: null
  });

  assert.equal(first.kind, 'created');
  assert.equal(second.kind, 'idempotent-hit');

  const rows = store.rawConnection().prepare('SELECT source_trajectory FROM memories WHERE id = ?').all(first.id) as Array<{ source_trajectory: string }>; 
  assert.equal(rows[0]?.source_trajectory, 'trajectory-a');

  closeAndDelete(store, dbPath);
});

test('benchmarks run with honest baseline, deterministic hashes, and gate behavior', () => {
  const dataset = loadDataset(process.cwd());

  const result = runBenchmark(dataset);
  const parsed = JSON.parse(printSummary(result));

  assert.equal(typeof parsed.governed['correct-recall'].queries, 'number');
  assert.equal(typeof parsed.appendOnly['correct-recall'].queries, 'number');
  assert.equal(typeof parsed.governed['contradiction-detection'].precision, 'string');

  const second = runBenchmark(dataset);
  assert.equal(result.governed.hash, second.governed.hash);
  assert.equal(result.appendOnly.hash, second.appendOnly.hash);
  const third = runBenchmark(dataset);
  assert.equal(result.governed.hash, third.governed.hash);
  assert.equal(result.appendOnly.hash, third.appendOnly.hash);

  assert.equal(typeof parsed.governed['stale-recall'].staleReturned, 'number');
  assert.equal(typeof parsed.appendOnly['stale-recall'].staleReturned, 'number');

  // The real store must clear the gate; bypassing governance must not.
  assert.doesNotThrow(() => assertGate(result.governed, result.appendOnly));
  assert.throws(
    () => {
      const bypass = runBenchmark(dataset, { sabotage: true });
      assertGate(bypass.governed, bypass.appendOnly);
    },
    /MEM_GATE failed/
  );
});

test('transaction rollback preserves store state when resolution log insert fails', () => {
  const dbPath = tempDbPath('rollback');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-06-01T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'rollback.subject',
    text: 'rollback row',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 0.8,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  store.rawConnection().exec(
    `CREATE TEMP TRIGGER fail_on_resolution_insert BEFORE INSERT ON resolutions BEGIN SELECT RAISE(ABORT, 'inject-fail'); END;`
  );

  assert.throws(() => {
    store.insertFact({
      kind: 'fact',
      subjectKey: 'rollback.subject',
      text: 'rollback superseder',
      validFrom: '2026-01-02T00:00:00.000Z',
      writtenAt: '2026-01-02T00:00:00.000Z',
      confidence: 0.9,
      sourceTrajectory: null,
      sourceTurn: null,
      derivedFrom: null
    });
  }, /inject-fail/);

  const rows = store.queryFacts('rollback', '2026-01-10T00:00:00.000Z', ['active', 'contextual', 'flagged']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, 'rollback row');

  const allFacts = getAllMemories(store, 'rollback.subject');
  assert.equal(allFacts.length, 1);

  closeAndDelete(store, dbPath);
});

test('baseline contradiction detector is deterministic and non-trivial', () => {
  const dbPath = tempDbPath('baseline-contra');
  const store = new MemoryStore({ dbPath, clock: fixedClock('2026-06-01T00:00:00.000Z') });
  store.init();

  store.insertFact({
    kind: 'fact',
    subjectKey: 'baseline',
    text: 'same event',
    validFrom: '2026-01-01T00:00:00.000Z',
    writtenAt: '2026-01-01T00:00:00.000Z',
    confidence: 1,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  store.insertFact({
    kind: 'fact',
    subjectKey: 'baseline',
    text: 'different event',
    validFrom: '2026-01-02T00:00:00.000Z',
    writtenAt: '2026-01-02T00:00:00.000Z',
    confidence: 1,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });

  const append = store.detectContradictions('same', '2026-06-01T00:00:00.000Z', { mode: 'append-only' });
  assert.ok(append.length >= 1);

  // R1 superseded "same event" once "different event" became effective, so
  // governed reads no longer see that contradiction.
  const governed = store.detectContradictions('same', '2026-06-01T00:00:00.000Z', { mode: 'governed' });
  assert.equal(governed.length, 0);

  // A same-valid-time contradiction cannot be resolved by supersession: it is
  // flagged and stays visible to governed detection.
  const conflicting = store.insertFact({
    kind: 'fact',
    subjectKey: 'baseline',
    text: 'conflicting event',
    validFrom: '2026-01-02T00:00:00.000Z',
    writtenAt: '2026-01-03T00:00:00.000Z',
    confidence: 1,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  });
  assert.equal(conflicting.kind, 'conflicted+flagged');

  const unresolved = store.detectContradictions('same', '2026-06-01T00:00:00.000Z', { mode: 'governed' });
  assert.equal(unresolved.length, 1);

  closeAndDelete(store, dbPath);
});
