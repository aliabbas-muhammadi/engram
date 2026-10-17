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
  that time, so history stays queryable.
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

## Development

Requires Node 22.13+ (for `node:sqlite` and type stripping). Sources run
directly as TypeScript; there is no build step.

```bash
npm ci
npm run typecheck
npm test                              # contract suite
npm run bench                         # benchmark summary (JSON)
MEM_DETERMINISM_CHECK=1 npm run bench # also verify run-to-run hashes match
MEM_GATE=1 npm run bench              # enforce the quality gate (currently fails, see below)
```

CI runs typecheck, tests and the determinism check on every pull request.

## Benchmark status

`bench/timeline.json` replays 29 events into a governed store and an
append-only baseline, then scores 24 queries. From a clean run:

| Metric | Governed | Append-only |
| --- | --- | --- |
| Fact recall, as scored | 8/13 | 5/13 |
| Fact recall, genuine fact queries only | 8/10 | 5/10 |
| Stale facts returned | 0/3 | 0/3 |
| Contradiction recall | 2/4 | 3/4 |
| Experience recall | 3/4 | 3/4 |

The `MEM_GATE` gate (≥15% stale-recall improvement, ≥80% contradiction recall)
fails, and it cannot pass with the current dataset and metric design:

- **Stale recall cannot separate the arms.** The baseline ranks the most
  recent fact first, so it never returns stale facts either. Stale queries are
  also counted in fact recall with the stale fact as the expected answer, which
  penalises the governed arm for being correct.
- **Some expectations contradict the data or the rules.**
  - q5 shares no term with its target.
  - q22 needs a word that is not yet written at its as-of time.
  - q16 expects `success` when the latest outcome is `failure`.
  - q24 expects a contradiction between experiences, which detection does not cover.
  - q10 expects governed detection to report a pair that R1 already resolved.

Fixing this means redesigning the benchmark (a baseline that can actually
return stale facts, separate stale scoring, corrected expectations) before the
gate is enforced in CI.
