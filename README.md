# engram

A governed, bitemporal memory store for agents. Facts and experiences live in
SQLite (via `node:sqlite`, FTS5 for recall) with no runtime dependencies.
Every fact carries two times, and every conflict is resolved by an explicit,
logged rule rather than by "latest write wins".

## Model

- **`validFrom`**: when the fact became true in the world.
- **`writtenAt`**: when the system learned it.
- **As-of reads**: `queryFacts(query, asOf)` returns what was known *and*
  in effect at `asOf`. A fact superseded after `asOf` is still returned for
  that time, with the status it held then (a contested fact stays flagged),
  so history stays queryable.
- **Recall** matches the query against both `subjectKey` and `text`.
- **Duplicates** are idempotent: a memory's id is a SHA-256 of
  `(subjectKey, text, validFrom)`, and re-inserting keeps the first provenance.

## Conflict rules

When a fact arrives, it is compared with the facts already known for its
subject (same `subjectKey`, written no later than it). Facts whose canonical
text differs conflict; context tags decide whether they share a scope.

| Rule | When | Outcome |
| --- | --- | --- |
| R1 supersede | Same scope, incoming `validFrom` is later | Older fact becomes `superseded` (linked to the incoming one) |
| R2 coexist | Both facts have distinct non-null contexts (`prod` vs `staging`) | Both stay active; the decision is logged only |
| R3 older history | Incoming `validFrom` is earlier than a known same-scope fact | Incoming is `flagged` for review |
| R3 same time | Same scope, same `validFrom` | Incoming is `flagged` |
| R3 low confidence | Incoming confidence is more than 0.1 below a conflicting fact | Incoming is `flagged` |

R3 checks run before R1: a fact is only superseded when none of them applies.
Every decision is written to the `resolutions` table in the same transaction
as the insert. Governed contradiction detection reports unresolved
conflicts only: a pair resolved by R1 supersession is no longer reported,
whereas a flagged same-time conflict is.

Writes may arrive out of order. A backdated write is resolved against what was
known at its `writtenAt`, so it supersedes older history. It is then checked
against facts already stored that were written after it: the first one R1 would
have applied supersedes it, as of that fact's write time. In-order and
out-of-order imports of the same facts therefore end in the same state.

One gap remains. A stored later fact that R3 would have flagged because of the
backdated fact is not retroactively flagged. Both stay current, and governed
detection reports them as an unresolved contradiction.

## API

```ts
import { MemoryStore, RecallService, recordOutcome, retrieveExperience } from './src/index.ts';

const store = new MemoryStore({ dbPath: 'memory.sqlite' });
store.init();

store.insertFact({
  kind: 'fact',
  subjectKey: 'gamma.version',
  text: 'Gamma runtime is 2.0',
  validFrom: '2026-01-12T00:00:00.000Z',
  writtenAt: '2026-01-12T00:00:00.000Z',
  confidence: 0.95
});

store.queryFacts('gamma runtime', '2026-01-15T00:00:00.000Z');
store.detectContradictions('gamma runtime', '2026-01-15T00:00:00.000Z', { mode: 'governed' });
```

`RecallService` wraps the store with a clock for "now" queries, and
`recordOutcome` / `retrieveExperience` store and recall action outcomes as
append-only experiences.

## Performance

Each governed insert is its own transaction, so commit durability dominates
its cost. For 3,000 conflicting inserts across 50 subjects, partly out of
order (median of 5 runs, in the development container):

| Journal | Time | Per insert |
| --- | --- | --- |
| WAL (default), every commit synced | 5.3 s | 1.8 ms |
| Rollback journal (`enableWal: false`) | 11.7 s | 3.9 ms |
| In memory, no durability | 1.7 s | 0.6 ms |

WAL needs shared memory, so use `enableWal: false` on network filesystems.
Reusing prepared statements made no measurable difference, so the store only
caches the two statements every insert runs.

## Development

Requires Node 22.13+ (for `node:sqlite` and type stripping). Sources run
directly as TypeScript; there is no build step.

```bash
npm ci
npm run typecheck
npm test                              # contract suite
npm run bench                         # benchmark summary (JSON)
MEM_DETERMINISM_CHECK=1 npm run bench # also verify run-to-run hashes match
MEM_GATE=1 npm run bench              # enforce the quality gate
```

CI runs the typecheck, the tests, the benchmark gate and the determinism check
on every pull request.

## Benchmark

`bench/timeline.json` replays 29 events into three arms and scores 27 queries:

- **governed**: engram as shipped.
- **baseline**: a typical append-only agent memory. A fact is known once it is
  written, there is no valid time, and relevance ties go to the latest write.
- **sabotage** (used by the gate test only): governed reads over an
  append-only store, which isolates the effect of write-time governance.

| Metric | Governed | Baseline | Sabotage |
| --- | --- | --- | --- |
| Correct answer, including "nothing known" | 19/19 | 11/19 | 11/19 |
| Stale fact returned (lower is better) | 0/6 | 3/6 | 3/6 |
| Contradiction recall | 3/3 | 3/3 | 3/3 |
| Contradiction precision | 3/5 | 3/8 | 3/8 |
| Experience recall | 4/4 | 4/4 | 4/4 |

`MEM_GATE` requires a stale-recall improvement over the baseline of at least
15 points and contradiction recall of at least 80%. The governed store passes
(50-point improvement, 100% recall). The sabotage arm fails, which shows the
stale-recall gain comes from supersession at write time, not from the
valid-time read path.

**Ground truth conventions**

- **Current truth:** the fact with the latest valid time that is known at the
  query's as-of time. A same-time rival that is less confident, or that arrived
  later, is contested rather than current.
- **Stale probes:** each lists the facts that are outdated at its as-of time.
  - Three are phrased in outdated terms ("beta region us-east" after the move
    to us-west). The right answer is no fact, because the stale fact is
    exactly what a naive memory returns.
- **Contradictions:** two incompatible facts in the same subject and scope with
  the same valid time. A change over time is a revision, not a contradiction.

**Limits**

- The dataset is small and hand-written. Perfect governed scores show the
  rules behave as specified, not that they generalise.
- Governed precision is 60% because detection also pairs flagged revisions
  with the fact they failed to replace (q6). Those pairs are pending review
  rather than same-time contradictions.
- Recall is lexical (FTS5 with implicit AND), so a query must share every term
  with a fact to find it.
