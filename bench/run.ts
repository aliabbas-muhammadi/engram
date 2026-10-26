import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryStore } from '../src/store.ts';
import { assertIsoUtcTimestamp, buildSafeFtsMatch, stableMemoryId } from '../src/utils.ts';
import type { Clock } from '../src/clock.ts';
import type { MemoryInput } from '../src/types.ts';

interface DatasetEvent {
  kind: 'fact' | 'experience';
  subject_key: string;
  text: string;
  valid_from: string;
  written_at: string;
  confidence: number;
  context_tag: string | null;
}

interface FactExpectation {
  subjectKey: string;
  text: string;
  validFrom: string;
}

interface ExpectedExperience {
  outcome?: 'success' | 'failure';
}

interface ContradictionExpectation {
  left: FactExpectation;
  right: FactExpectation;
}

type RawQueryType =
  | 'fact'
  | 'stale'
  | 'contradiction'
  | 'experience'
  | 'correct-recall'
  | 'stale-recall'
  | 'contradiction-detect'
  | 'experience-recall';

interface Query {
  id: string;
  type: RawQueryType;
  query: string;
  asOf: string;
  expected?: FactExpectation | ExpectedExperience | null;
  /** Stale probes: facts that were once true but are outdated at `asOf`. */
  staleFacts?: FactExpectation[];
  expectedPairs?: ContradictionExpectation[];
  expectedOutcome?: 'success' | 'failure';
}

interface Dataset {
  facts: DatasetEvent[];
  queries: Query[];
}

interface CorrectRecallMetric {
  queries: number;
  correct: number;
}

interface StaleRecallMetric {
  queries: number;
  staleReturned: number;
}

interface ContradictionMetric {
  queries: number;
  expectedPairs: number;
  foundPairs: number;
  truePositive: number;
}

interface ExperienceMetric {
  queries: number;
  correct: number;
}

interface ArmMetrics {
  correctRecall: CorrectRecallMetric;
  staleRecall: StaleRecallMetric;
  contradiction: ContradictionMetric;
  experienceRecall: ExperienceMetric;
}

interface ArmResult {
  kind: 'governed' | 'append-only';
  metrics: ArmMetrics;
  hash: string;
}

interface BenchResult {
  governed: ArmResult;
  appendOnly: ArmResult;
  gates: {
    staleRecallImprovementPct: string;
    governedStaleRecall: string;
    baselineStaleRecall: string;
    contradictionRecall: string;
    contradictionPrecision: string;
  };
}

function toCanonicalType(raw: RawQueryType): 'correct-recall' | 'stale-recall' | 'contradiction-detect' | 'experience-recall' {
  switch (raw) {
    case 'fact':
      return 'correct-recall';
    case 'stale':
      return 'stale-recall';
    case 'contradiction':
      return 'contradiction-detect';
    case 'experience':
      return 'experience-recall';
    default:
      return raw;
  }
}

function percentage(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return '0.00%';
  }
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function expectationId(expectation: FactExpectation): string {
  return stableMemoryId(expectation.subjectKey, expectation.text, expectation.validFrom);
}

function expectedOutcome(query: Query): 'success' | 'failure' | null {
  if (query.expectedOutcome) {
    return query.expectedOutcome;
  }

  if (query.expected && 'outcome' in query.expected) {
    return query.expected.outcome ?? null;
  }

  return null;
}

function ensureFactExpectation(expected: Query['expected']): FactExpectation | null {
  if (!expected) {
    return null;
  }

  const isFactExpectation =
    typeof expected === 'object' &&
    'subjectKey' in expected &&
    typeof expected.subjectKey === 'string' &&
    'text' in expected &&
    typeof expected.text === 'string' &&
    'validFrom' in expected &&
    typeof expected.validFrom === 'string';

  return isFactExpectation ? expected : null;
}

function inputFromEvent(event: DatasetEvent): MemoryInput {
  return {
    kind: event.kind,
    subjectKey: event.subject_key,
    text: event.text,
    validFrom: event.valid_from,
    writtenAt: event.written_at,
    confidence: event.confidence,
    contextTag: event.context_tag,
    sourceTrajectory: null,
    sourceTurn: null,
    derivedFrom: null
  };
}

export function loadDataset(rootDir: string): Dataset {
  const raw = readFileSync(path.join(rootDir, 'bench', 'timeline.json'), 'utf8');
  return JSON.parse(raw) as Dataset;
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function buildSet(pairs: Array<{ firstId: string; secondId: string }>): Set<string> {
  const set = new Set<string>();
  for (const pair of pairs) {
    const ordered = canonicalPair(pair.firstId, pair.secondId);
    set.add(ordered.join('|'));
  }
  return set;
}

function evaluateContradictions(
  store: MemoryStore,
  query: Query,
  mode: 'governed' | 'append-only',
  asOf: string
): { expectedPairs: number; foundPairs: number; truePositive: number } {
  const expected = buildSet((query.expectedPairs ?? []).map((pair) => {
    const left = expectationId(pair.left);
    const right = expectationId(pair.right);
    return canonicalPair(left, right);
  }).map(([left, right]) => ({ firstId: left, secondId: right })));

  const found = buildSet(
    store
      .detectContradictions(query.query, asOf, { mode })
      .map((pair) => ({ firstId: pair.firstId, secondId: pair.secondId }))
  );

  let truePositive = 0;
  for (const expectedPair of expected) {
    if (found.has(expectedPair)) {
      truePositive += 1;
    }
  }

  return {
    expectedPairs: expected.size,
    foundPairs: found.size,
    truePositive
  };
}

class FixedClock implements Clock {
  private readonly at: string;

  public constructor(at: string) {
    this.at = at;
  }

  public nowUTC(): string {
    return this.at;
  }
}

function ensureOutDir(rootDir: string): string {
  const outDir = path.join(rootDir, 'bench', '.out');
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

/** Each arm must start empty, or rows (and schema) from a previous run leak into the metrics. */
function removeDatabase(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

export function runBenchmarkArm(
  dataset: Dataset,
  dbPath: string,
  opts: { kind: 'governed' | 'append-only'; bypassGovernance?: boolean }
): ArmResult {
  removeDatabase(dbPath);
  const store = new MemoryStore({
    dbPath,
    clock: new FixedClock('2026-12-31T00:00:00.000Z')
  });
  store.init();

  for (const event of dataset.facts) {
    const input = inputFromEvent(event);
    if (opts.kind === 'governed' && opts.bypassGovernance) {
      store.insertFact(input, { mode: 'append-only' });
      continue;
    }

    store.insertFact(input, { mode: opts.kind });
  }

  const metrics: ArmMetrics = {
    correctRecall: { queries: 0, correct: 0 },
    staleRecall: { queries: 0, staleReturned: 0 },
    contradiction: { queries: 0, expectedPairs: 0, foundPairs: 0, truePositive: 0 },
    experienceRecall: { queries: 0, correct: 0 }
  };

  for (const rawQuery of dataset.queries) {
    const type = toCanonicalType(rawQuery.type);
    const asOf = assertIsoUtcTimestamp(rawQuery.asOf).value;
    const expectedFact = ensureFactExpectation(rawQuery.expected);
    const top =
      opts.kind === 'governed'
        ? store.queryFacts(rawQuery.query, asOf, ['active', 'contextual'])[0] ?? null
        : baselineTopFact(store, rawQuery.query, asOf);

    if (type === 'correct-recall') {
      // `expected: null` means nothing relevant is known at asOf, so the
      // correct behaviour is to return no fact at all.
      if (rawQuery.expected !== null && !expectedFact) {
        throw new Error(`fact query ${rawQuery.id} needs a fact expectation or an explicit null`);
      }

      metrics.correctRecall.queries += 1;
      const expectedId = expectedFact ? expectationId(expectedFact) : null;
      if (topId(top) === expectedId) {
        metrics.correctRecall.correct += 1;
      }

      continue;
    }

    if (type === 'stale-recall') {
      // `expected` is the current truth, or null when no current fact matches
      // the query's (outdated) terms. Returning a listed stale fact counts
      // against the arm; only the current truth counts as correct.
      if (rawQuery.expected !== null && !expectedFact) {
        throw new Error(`stale query ${rawQuery.id} needs a fact expectation or an explicit null`);
      }

      if (!rawQuery.staleFacts || rawQuery.staleFacts.length === 0) {
        throw new Error(`stale query ${rawQuery.id} must list staleFacts`);
      }

      metrics.staleRecall.queries += 1;
      metrics.correctRecall.queries += 1;
      const staleIds = new Set(rawQuery.staleFacts.map(expectationId));
      const returnedId = topId(top);
      if (returnedId !== null && staleIds.has(returnedId)) {
        metrics.staleRecall.staleReturned += 1;
      }

      if (returnedId === (expectedFact ? expectationId(expectedFact) : null)) {
        metrics.correctRecall.correct += 1;
      }

      continue;
    }

    if (type === 'contradiction-detect') {
      metrics.contradiction.queries += 1;
      const evaluated = evaluateContradictions(store, rawQuery, opts.kind === 'governed' ? 'governed' : 'append-only', asOf);
      metrics.contradiction.expectedPairs += evaluated.expectedPairs;
      metrics.contradiction.foundPairs += evaluated.foundPairs;
      metrics.contradiction.truePositive += evaluated.truePositive;
      continue;
    }

    metrics.experienceRecall.queries += 1;
    const outcome = expectedOutcome(rawQuery);
    const rows = store.queryExperiences(rawQuery.query, asOf, 1);
    const topExperience = rows[0]?.text ?? null;

    if (outcome && topExperience?.includes(outcome)) {
      metrics.experienceRecall.correct += 1;
    }
  }

  const snapshot = {
    correctRecall: metrics.correctRecall,
    staleRecall: metrics.staleRecall,
    contradiction: metrics.contradiction,
    experienceRecall: metrics.experienceRecall
  };

  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  store.close();

  return {
    kind: opts.kind,
    metrics,
    hash
  };
}

/**
 * The baseline models a typical append-only agent memory: it knows a fact once
 * it has been written, has no notion of valid time, and breaks relevance ties
 * by the most recent write. Unlike the governed read path, a late-learned
 * piece of history can displace the current fact.
 */
function baselineTopFact(store: MemoryStore, query: string, asOf: string): { id: string } | null {
  const match = buildSafeFtsMatch(query);
  if (!match) {
    return null;
  }

  const row = store
    .rawConnection()
    .prepare(`
      SELECT memories.id
      FROM memories
      JOIN memories_fts ON memories_fts.rowid = memories.rowid
      WHERE memories.kind = 'fact'
        AND memories_fts MATCH ?
        AND memories.written_at <= ?
      ORDER BY bm25(memories_fts) ASC, memories.written_at DESC, memories.id ASC
      LIMIT 1
    `)
    .get(match, asOf) as { id: string } | undefined;

  return row ?? null;
}

function topId(row: { id: string } | null | undefined): string | null {
  return row?.id ?? null;
}

export function runBenchmark(dataset: Dataset, options: { sabotage?: boolean } = {}): BenchResult {
  const outDir = ensureOutDir(process.cwd());

  const governed = runBenchmarkArm(dataset, path.join(outDir, `${options.sabotage ? 'sabotage.' : ''}governed.sqlite`), {
    kind: 'governed',
    bypassGovernance: options.sabotage
  });
  const appendOnly = runBenchmarkArm(dataset, path.join(outDir, `${options.sabotage ? 'sabotage.' : ''}append-only.sqlite`), {
    kind: 'append-only'
  });

  // Improvement means the governed arm returns stale facts less often than the
  // baseline, matching the direction assertGate enforces.
  const staleImprovement =
    metricsRateForStale(appendOnly.metrics.staleRecall) - metricsRateForStale(governed.metrics.staleRecall);

  return {
    governed,
    appendOnly,
    gates: {
      staleRecallImprovementPct: `${(staleImprovement * 100).toFixed(2)}%`,
      governedStaleRecall: percentage(governed.metrics.staleRecall.staleReturned, governed.metrics.staleRecall.queries),
      baselineStaleRecall: percentage(appendOnly.metrics.staleRecall.staleReturned, appendOnly.metrics.staleRecall.queries),
      contradictionRecall: percentage(governed.metrics.contradiction.truePositive, governed.metrics.contradiction.expectedPairs),
      contradictionPrecision: percentage(governed.metrics.contradiction.truePositive, governed.metrics.contradiction.foundPairs)
    }
  };
}

function metricsRateForStale(stale: StaleRecallMetric): number {
  if (stale.queries <= 0) {
    return 0;
  }

  return stale.staleReturned / stale.queries;
}

export function assertGate(governed: ArmResult, appendOnly: ArmResult): void {
  const governedStale = metricsRateForStale(governed.metrics.staleRecall);
  const baselineStale = metricsRateForStale(appendOnly.metrics.staleRecall);
  const improvement = baselineStale - governedStale;

  const governedConRecall =
    governed.metrics.contradiction.expectedPairs > 0
      ? governed.metrics.contradiction.truePositive / governed.metrics.contradiction.expectedPairs
      : 0;

  if (improvement < 0.15) {
    throw new Error(`MEM_GATE failed: stale-recall improvement ${(improvement * 100).toFixed(2)}% < 15%`);
  }

  if (governedConRecall < 0.8) {
    throw new Error(`MEM_GATE failed: contradiction recall ${(governedConRecall * 100).toFixed(2)}% < 80%`);
  }

  for (const [label, metric] of [
    ['correct recall', governed.metrics.correctRecall],
    ['experience recall', governed.metrics.experienceRecall]
  ] as const) {
    if (metric.queries <= 0 || metric.correct !== metric.queries) {
      throw new Error(`MEM_GATE failed: ${label} must answer every golden query correctly (${metric.correct}/${metric.queries})`);
    }
  }
}

export function printSummary(result: BenchResult): string {
  const governedCorrectRate = percentage(result.governed.metrics.correctRecall.correct, result.governed.metrics.correctRecall.queries);

  const governedStaleRate = percentage(
    result.governed.metrics.staleRecall.staleReturned,
    result.governed.metrics.staleRecall.queries
  );

  const governedConRecall =
    result.governed.metrics.contradiction.expectedPairs > 0
      ? percentage(result.governed.metrics.contradiction.truePositive, result.governed.metrics.contradiction.expectedPairs)
      : '0.00%';

  const governedConPrecision =
    result.governed.metrics.contradiction.foundPairs > 0
      ? percentage(result.governed.metrics.contradiction.truePositive, result.governed.metrics.contradiction.foundPairs)
      : '0.00%';

  const governedExperience = percentage(
    result.governed.metrics.experienceRecall.correct,
    result.governed.metrics.experienceRecall.queries
  );

  const appendCorrectRate = percentage(result.appendOnly.metrics.correctRecall.correct, result.appendOnly.metrics.correctRecall.queries);
  const appendStaleRate = percentage(
    result.appendOnly.metrics.staleRecall.staleReturned,
    result.appendOnly.metrics.staleRecall.queries
  );

  const appendConRecall =
    result.appendOnly.metrics.contradiction.expectedPairs > 0
      ? percentage(result.appendOnly.metrics.contradiction.truePositive, result.appendOnly.metrics.contradiction.expectedPairs)
      : '0.00%';

  const appendConPrecision =
    result.appendOnly.metrics.contradiction.foundPairs > 0
      ? percentage(result.appendOnly.metrics.contradiction.truePositive, result.appendOnly.metrics.contradiction.foundPairs)
      : '0.00%';

  const appendExperience = percentage(
    result.appendOnly.metrics.experienceRecall.correct,
    result.appendOnly.metrics.experienceRecall.queries
  );

  const output = {
    governed: {
      'correct-recall': {
        correct: result.governed.metrics.correctRecall.correct,
        queries: result.governed.metrics.correctRecall.queries,
        pct: governedCorrectRate
      },
      'stale-recall': {
        staleReturned: result.governed.metrics.staleRecall.staleReturned,
        queries: result.governed.metrics.staleRecall.queries,
        pct: governedStaleRate
      },
      'contradiction-detection': {
        expectedPairs: result.governed.metrics.contradiction.expectedPairs,
        foundPairs: result.governed.metrics.contradiction.foundPairs,
        truePositive: result.governed.metrics.contradiction.truePositive,
        precision: governedConPrecision,
        recall: governedConRecall
      },
      'experience-recall': {
        correct: result.governed.metrics.experienceRecall.correct,
        queries: result.governed.metrics.experienceRecall.queries,
        pct: governedExperience
      }
    },
    appendOnly: {
      'correct-recall': {
        correct: result.appendOnly.metrics.correctRecall.correct,
        queries: result.appendOnly.metrics.correctRecall.queries,
        pct: appendCorrectRate
      },
      'stale-recall': {
        staleReturned: result.appendOnly.metrics.staleRecall.staleReturned,
        queries: result.appendOnly.metrics.staleRecall.queries,
        pct: appendStaleRate
      },
      'contradiction-detection': {
        expectedPairs: result.appendOnly.metrics.contradiction.expectedPairs,
        foundPairs: result.appendOnly.metrics.contradiction.foundPairs,
        truePositive: result.appendOnly.metrics.contradiction.truePositive,
        precision: appendConPrecision,
        recall: appendConRecall
      },
      'experience-recall': {
        correct: result.appendOnly.metrics.experienceRecall.correct,
        queries: result.appendOnly.metrics.experienceRecall.queries,
        pct: appendExperience
      }
    },
    gates: result.gates,
    hashes: {
      governed: result.governed.hash,
      appendOnly: result.appendOnly.hash
    }
  };

  return JSON.stringify(output);
}

function main(): void {
  const dataset = loadDataset(process.cwd());
  const result = runBenchmark(dataset);
  console.log(printSummary(result));

  if (process.env.MEM_GATE === '1') {
    assertGate(result.governed, result.appendOnly);
  }

  if (process.env.MEM_DETERMINISM_CHECK === '1') {
    const second = runBenchmark(dataset);
    const third = runBenchmark(dataset);

    if (second.governed.hash !== third.governed.hash || second.appendOnly.hash !== third.appendOnly.hash) {
      throw new Error('bench determinism check failed');
    }

    console.log(JSON.stringify({ deterministic: true, governed: second.governed.hash, appendOnly: second.appendOnly.hash }));
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
