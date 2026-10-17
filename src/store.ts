import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type {
  InsertResult,
  MemoryRecord,
  MemoryInput,
  MemoryStatus,
  ContradictionPair,
  ResolutionLogInput,
  ResolutionPlan,
  DetectContradictionOptions
} from './types.ts';

import { type Clock, systemClock } from './clock.ts';
import { resolveConflictPlan, deterministicCandidateOrder } from './conflict.ts';
import { normalizeIncomingMemory } from './memory.ts';
import { assertIsoUtcTimestamp, buildSafeFtsMatch, toCanonicalText } from './utils.ts';

interface MemoryRow {
  rowid: number;
  id: string;
  kind: 'fact' | 'experience';
  subject_key: string;
  text: string;
  valid_from: string;
  written_at: string;
  confidence: number;
  source_trajectory: string | null;
  source_turn: number | null;
  derived_from: string | null;
  status: MemoryStatus;
  superseded_by: string | null;
  superseded_at: string | null;
  context_tag: string | null;
}

interface RankedMemoryRow extends MemoryRow {
  score: number;
}

const MEMORY_COLUMN_NAMES = [
  'id',
  'kind',
  'subject_key',
  'text',
  'valid_from',
  'written_at',
  'confidence',
  'source_trajectory',
  'source_turn',
  'derived_from',
  'status',
  'superseded_by',
  'superseded_at',
  'context_tag'
] as const;

const MEMORY_COLUMNS = MEMORY_COLUMN_NAMES.join(', ');
// Qualified for joins with memories_fts, which also has a `text` column.
const QUALIFIED_MEMORY_COLUMNS = MEMORY_COLUMN_NAMES.map((column) => `memories.${column}`).join(', ');

const INSERT_MEMORY_SQL = `INSERT INTO memories (${MEMORY_COLUMNS}) VALUES (${MEMORY_COLUMN_NAMES.map(() => '?').join(', ')})`;
const SELECT_MEMORY_BY_ID_SQL = `SELECT rowid, ${MEMORY_COLUMNS} FROM memories WHERE id = ?`;

function mapRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    subjectKey: row.subject_key,
    text: row.text,
    validFrom: row.valid_from,
    writtenAt: row.written_at,
    confidence: row.confidence,
    sourceTrajectory: row.source_trajectory,
    sourceTurn: row.source_turn,
    derivedFrom: row.derived_from,
    status: row.status,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    contextTag: row.context_tag
  };
}

function parseDerivedFrom(value: string | null): string[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string');
}

function buildResolutionId(incomingId: string, existingId: string | null, action: string, rule: string, ts: string): string {
  const payload = JSON.stringify({ incomingId, existingId, action, rule, ts });
  return `${incomingId.slice(0, 8)}.${existingId ?? 'root'}.${action}.${rule}.${ts}`;
}

function canonicalPlaceholderList(values: readonly string[]): string {
  return values.map(() => '?').join(',');
}

function inClause(values: readonly string[]): string {
  return `(${canonicalPlaceholderList(values)})`;
}

function isGovernedMode(mode?: DetectContradictionOptions['mode']): boolean {
  return mode !== 'append-only';
}

export interface StoreOptions {
  dbPath: string;
  clock?: Clock;
  enableWal?: boolean;
}

export interface InsertFactOptions {
  mode?: 'governed' | 'append-only';
}

export class MemoryStore {
  private readonly options: StoreOptions;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly statements = new Map<string, StatementSync>();

  public constructor(options: StoreOptions) {
    this.options = options;
    this.db = new DatabaseSync(options.dbPath, { create: true });
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Statements are prepared on first use: preparing in the constructor fails
   * because the tables do not exist until init() has run.
   */
  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  public init(): void {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`PRAGMA journal_mode = ${this.options.enableWal ? 'WAL' : 'OFF'}`);

    const modules = this.db.prepare('SELECT name FROM pragma_module_list').all() as Array<{ name: string }>;
    if (!modules.some((entry) => entry.name === 'fts5')) {
      throw new Error('SQLite FTS5 is unavailable in this runtime');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'experience')),
        subject_key TEXT NOT NULL,
        text TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        written_at TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_trajectory TEXT,
        source_turn INTEGER,
        derived_from TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'flagged', 'contextual')),
        superseded_by TEXT,
        superseded_at TEXT,
        context_tag TEXT,
        FOREIGN KEY (superseded_by) REFERENCES memories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS resolutions (
        id TEXT PRIMARY KEY,
        incoming_id TEXT NOT NULL,
        existing_id TEXT,
        action TEXT NOT NULL CHECK (action IN ('supersede', 'contextualize', 'flag', 'retain')),
        rule TEXT NOT NULL,
        decision_ts TEXT NOT NULL,
        details TEXT NOT NULL,
        FOREIGN KEY (incoming_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (existing_id) REFERENCES memories(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_lookup
        ON memories(subject_key, kind, status, valid_from, written_at);
      CREATE INDEX IF NOT EXISTS idx_memories_superseded_by
        ON memories(superseded_by);
      CREATE INDEX IF NOT EXISTS idx_memories_written_valid
        ON memories(subject_key, written_at, valid_from);
      CREATE INDEX IF NOT EXISTS idx_memories_status_kind
        ON memories(kind, status, written_at);
      CREATE INDEX IF NOT EXISTS idx_memories_context
        ON memories(subject_key, context_tag, status);
      CREATE INDEX IF NOT EXISTS idx_memories_superseded_at
        ON memories(superseded_at);
      CREATE INDEX IF NOT EXISTS idx_resolutions_incoming
        ON resolutions(incoming_id);
      CREATE INDEX IF NOT EXISTS idx_resolutions_existing
        ON resolutions(existing_id);

      -- subject_key is indexed with text so recall can match a fact by its subject
      -- (e.g. "review" finds subject.review) even when the wording differs.
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(subject_key, text, content='memories', content_rowid='rowid');
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, subject_key, text) VALUES (new.rowid, new.subject_key, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, subject_key, text)
          VALUES ('delete', old.rowid, old.subject_key, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF subject_key, text ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, subject_key, text)
          VALUES ('delete', old.rowid, old.subject_key, old.text);
        INSERT INTO memories_fts(rowid, subject_key, text) VALUES (new.rowid, new.subject_key, new.text);
      END;
    `);
  }

  public close(): void {
    this.db.close();
  }

  public rawConnection(): DatabaseSync {
    return this.db;
  }

  public insertFact(input: MemoryInput, options: InsertFactOptions = {}): InsertResult {
    const mode = options.mode ?? 'governed';

    if (input.kind === 'experience') {
      return this.insertAppendOnly(input);
    }

    if (mode === 'append-only') {
      return this.insertAppendOnly(input);
    }

    return this.insertWithGovernedRules(input);
  }

  public insertExperience(input: MemoryInput): InsertResult {
    return this.insertAppendOnly(input);
  }

  public insertAppendOnly(input: MemoryInput): InsertResult {
    const memory = normalizeIncomingMemory(input);
    memory.status = 'active';

    return this.withTransaction(() => {
      const existing = this.statement(SELECT_MEMORY_BY_ID_SQL).get(memory.id) as MemoryRow | null;
      if (existing) {
        return {
          kind: 'idempotent-hit',
          id: memory.id,
          status: existing.status,
          duplicateOf: existing.id,
          message: 'exact duplicate key; preserving prior provenance'
        };
      }

      if (memory.derivedFrom && memory.derivedFrom.length > 0) {
        this.validateDerivedFromExists(memory.id, parseDerivedFrom(memory.derivedFrom));
        this.validateDerivedFromAcyclic(memory.id, parseDerivedFrom(memory.derivedFrom));
      }

      this.insertMemory(memory);

      return {
        kind: 'created',
        id: memory.id,
        status: memory.status,
        plan: {
          incomingId: memory.id,
          incomingStatus: memory.status,
          incomingIsDuplicate: false,
          steps: [],
          logs: [],
          supersessionLinks: []
        }
      };
    });
  }

  private insertWithGovernedRules(input: MemoryInput): InsertResult {
    const memory = normalizeIncomingMemory(input);

    if (memory.derivedFrom && memory.derivedFrom.length > 0) {
      const derivedFrom = parseDerivedFrom(memory.derivedFrom);
      this.validateDerivedFromExists(memory.id, derivedFrom);
      this.validateDerivedFromAcyclic(memory.id, derivedFrom);
    }

    const existing = this.statement(SELECT_MEMORY_BY_ID_SQL).get(memory.id) as MemoryRow | null;
    if (existing) {
      return {
        kind: 'idempotent-hit',
        id: memory.id,
        status: existing.status,
        duplicateOf: existing.id,
        message: 'exact duplicate key; preserving prior provenance'
      };
    }

    const candidates = this.loadCandidatesForGovernance(memory.subjectKey, memory.writtenAt);
    const plan = resolveConflictPlan(memory, candidates, memory.writtenAt);

    if (plan.incomingIsDuplicate) {
      return {
        kind: 'idempotent-hit',
        id: memory.id,
        status: memory.status,
        duplicateOf: memory.id,
        plan,
        message: 'deterministic duplicate prevented by stable id'
      };
    }

    const validationError = this.validatePlan(memory, plan);
    if (validationError) {
      return {
        kind: 'error',
        id: memory.id,
        status: memory.status,
        message: validationError
      };
    }

    return this.withTransaction(() => {
      memory.status = plan.incomingStatus;
      this.insertMemory(memory);

      this.applyPlan(plan);
      this.insertResolutionLogs(plan.logs);

      const hasSupersession = plan.supersessionLinks.length > 0;

      let resultKind: InsertResult['kind'];
      if (memory.status === 'flagged') {
        resultKind = 'conflicted+flagged';
      } else if (hasSupersession) {
        resultKind = 'conflicted+resolved';
      } else {
        resultKind = 'created';
      }

      return {
        kind: resultKind,
        id: memory.id,
        status: memory.status,
        plan,
        message: memory.status === 'flagged' ? 'incoming fact flagged for review' : 'fact inserted'
      };
    });
  }

  public queryFacts(
    query: string,
    asOf: string,
    includeStatuses: Array<'active' | 'contextual' | 'flagged'> = ['active', 'contextual']
  ): MemoryRecord[] {
    const canonicalAsOf = assertIsoUtcTimestamp(asOf).value;
    const safeQuery = buildSafeFtsMatch(query);
    if (!safeQuery || includeStatuses.length === 0) {
      return [];
    }

    // A fact superseded after `asOf` was still current at `asOf`, so as-of
    // reads that ask for active facts must include it.
    const includeSupersededLater = includeStatuses.includes('active');
    const supersededLaterClause = includeSupersededLater
      ? "OR (memories.status = 'superseded' AND memories.superseded_at > ?)"
      : '';
    const params: string[] = [safeQuery, canonicalAsOf, canonicalAsOf, ...includeStatuses];
    if (includeSupersededLater) {
      params.push(canonicalAsOf);
    }

    const rows = this.db
      .prepare(`
        SELECT memories.rowid, ${QUALIFIED_MEMORY_COLUMNS}
        FROM memories
        JOIN memories_fts ON memories_fts.rowid = memories.rowid
        WHERE memories.kind = 'fact'
          AND memories_fts MATCH ?
          AND memories.written_at <= ?
          AND memories.valid_from <= ?
          AND (
            memories.status IN ${inClause(includeStatuses)}
            ${supersededLaterClause}
          )
        ORDER BY bm25(memories_fts) ASC,
          CASE memories.status
            WHEN 'active' THEN 0
            WHEN 'superseded' THEN 0
            WHEN 'contextual' THEN 1
            WHEN 'flagged' THEN 2
            ELSE 3
          END,
          memories.valid_from DESC,
          memories.written_at DESC,
          memories.id ASC
      `)
      .all(...params) as unknown as MemoryRow[];

    return rows.map(mapRow);
  }

  public queryExperiences(
    query: string,
    asOf: string,
    limit = 10
  ): Array<MemoryRecord & { score: number }> {
    const canonicalAsOf = assertIsoUtcTimestamp(asOf).value;
    const safeQuery = buildSafeFtsMatch(query);
    if (!safeQuery) {
      return [];
    }

    const rows = this.db
      .prepare(`
        SELECT memories.rowid, ${QUALIFIED_MEMORY_COLUMNS}, bm25(memories_fts) AS score
        FROM memories
        JOIN memories_fts ON memories_fts.rowid = memories.rowid
        WHERE memories.kind = 'experience'
          AND memories_fts MATCH ?
          AND memories.written_at <= ?
          AND memories.valid_from <= ?
          AND memories.status = 'active'
        ORDER BY bm25(memories_fts) ASC,
          memories.written_at DESC,
          memories.id ASC
        LIMIT ?
      `)
      .all(safeQuery, canonicalAsOf, canonicalAsOf, limit) as unknown as RankedMemoryRow[];

    return rows.map((row) => ({
      ...mapRow(row),
      score: row.score
    }));
  }

  public detectContradictions(
    query: string,
    asOf: string,
    options: DetectContradictionOptions = {}
  ): ContradictionPair[] {
    const canonicalAsOf = assertIsoUtcTimestamp(asOf).value;
    const safeQuery = buildSafeFtsMatch(query);
    if (!safeQuery) {
      return [];
    }

    const governed = isGovernedMode(options.mode);
    // Governed reads skip facts superseded at or before `asOf`; facts superseded
    // later were still current then and stay in scope.
    const governanceFilter = governed
      ? 'AND (memories.status != \'superseded\' OR (memories.superseded_at IS NOT NULL AND memories.superseded_at > ?))'
      : '';

    const params: (string | number)[] = [safeQuery, canonicalAsOf, canonicalAsOf];
    if (governed) {
      params.push(canonicalAsOf);
    }

    const rows = this.db
      .prepare(`
        SELECT memories.rowid, ${QUALIFIED_MEMORY_COLUMNS}
        FROM memories
        JOIN memories_fts ON memories_fts.rowid = memories.rowid
        WHERE memories.kind = 'fact'
          AND memories_fts MATCH ?
          AND memories.written_at <= ?
          AND memories.valid_from <= ?
          ${governanceFilter}
        ORDER BY memories.subject_key ASC, memories.valid_from ASC, memories.written_at ASC, memories.id ASC
      `)
      .all(...params) as unknown as MemoryRow[];
    const memories = rows.map(mapRow);

    const grouped = new Map<string, MemoryRecord[]>();
    for (const row of memories) {
      if (!grouped.has(row.subjectKey)) {
        grouped.set(row.subjectKey, []);
      }

      grouped.get(row.subjectKey)!.push(row);
    }

    const result: ContradictionPair[] = [];
    const seen = new Set<string>();

    for (const [subjectKey, bucket] of grouped) {
      for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
          const left = bucket[i]!;
          const right = bucket[j]!;

          if (governed) {
            const shareDistinctContexts =
              left.contextTag !== null && right.contextTag !== null && left.contextTag !== right.contextTag;
            if (shareDistinctContexts) {
              continue;
            }
          }

          if (toCanonicalText(left.text) === toCanonicalText(right.text)) {
            continue;
          }

          const ordered = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
          const pairKey = ordered.join('|');
          if (seen.has(pairKey)) {
            continue;
          }

          seen.add(pairKey);
          result.push({
            subjectKey,
            firstId: ordered[0]!,
            secondId: ordered[1]!,
            firstText: left.id < right.id ? left.text : right.text,
            secondText: left.id < right.id ? right.text : left.text,
            seenAsOf: canonicalAsOf
          });
        }
      }
    }

    return result;
  }

  private loadCandidatesForGovernance(subjectKey: string, asOfWrite: string): MemoryRecord[] {
    const rows = this.db
      .prepare(`
        SELECT rowid, ${MEMORY_COLUMNS}
        FROM memories
        WHERE subject_key = ?
          AND kind = 'fact'
          AND written_at <= ?
          AND (
            status != 'superseded'
            OR (
              superseded_at IS NOT NULL
              AND superseded_at > ?
            )
          )
        ORDER BY valid_from ASC, written_at ASC, id ASC
      `)
      .all(subjectKey, asOfWrite, asOfWrite) as MemoryRow[];

    return deterministicCandidateOrder(rows.map(mapRow));
  }

  private insertMemory(memory: MemoryRecord): void {
    this.statement(INSERT_MEMORY_SQL).run(
      memory.id,
      memory.kind,
      memory.subjectKey,
      memory.text,
      memory.validFrom,
      memory.writtenAt,
      memory.confidence,
      memory.sourceTrajectory,
      memory.sourceTurn,
      memory.derivedFrom,
      memory.status,
      memory.supersededBy,
      memory.supersededAt,
      memory.contextTag
    );
  }

  /**
   * Only supersession mutates existing rows. R2 `contextualize` steps record
   * that distinct contexts coexist; they are audited in the resolution log but
   * leave both facts active, so the outcome never depends on insertion order.
   */
  private applyPlan(plan: ResolutionPlan): void {
    if (plan.supersessionLinks.length === 0) {
      return;
    }

    const updateSupersede = this.db.prepare(`
      UPDATE memories
      SET status = 'superseded', superseded_by = ?, superseded_at = ?
      WHERE id = ?
    `);

    for (const link of plan.supersessionLinks) {
      updateSupersede.run(link.supersededBy, link.supersededAt, link.existingId);
    }
  }

  private insertResolutionLogs(logs: ReadonlyArray<ResolutionLogInput>): void {
    if (logs.length === 0) {
      return;
    }

    const insertResolution = this.db.prepare(`
      INSERT INTO resolutions (id, incoming_id, existing_id, action, rule, decision_ts, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const log of logs) {
      const resolutionId = buildResolutionId(
        log.incomingId,
        log.existingId,
        log.action,
        log.rule,
        log.decisionTs
      );

      insertResolution.run(
        resolutionId,
        log.incomingId,
        log.existingId,
        log.action,
        log.rule,
        log.decisionTs,
        log.details
      );
    }
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private validatePlan(memory: MemoryRecord, plan: ResolutionPlan): string | null {
    if (!plan.incomingId) {
      return 'invalid resolution plan: missing incoming id';
    }

    if (plan.incomingStatus !== 'active' && plan.incomingStatus !== 'flagged' && plan.incomingStatus !== 'contextual') {
      return 'invalid resolution plan: incoming status is invalid';
    }

    const touched = new Set<string>();
    for (const step of plan.steps) {
      if (!step.existingId) {
        return 'invalid resolution plan: step missing existing id';
      }
      if (touched.has(step.existingId)) {
        return `invalid resolution plan: duplicate action for ${step.existingId}`;
      }
      touched.add(step.existingId);
    }

    const linkTargets = new Set(plan.supersessionLinks.map((link) => link.existingId));
    for (const link of plan.supersessionLinks) {
      if (!link.existingId || !link.supersededBy || !link.supersededAt) {
        return 'invalid resolution plan: malformed supersession link';
      }

      if (!touched.has(link.existingId)) {
        return `invalid resolution plan: supersession link missing for ${link.existingId}`;
      }

      if (link.supersededBy !== memory.id) {
        return 'invalid resolution plan: non-incoming supersession link';
      }
    }

    for (const existingId of touched) {
      const hasSupersede = plan.steps.some((step) => step.existingId === existingId && step.action === 'supersede');
      const hasLink = linkTargets.has(existingId);
      if (hasSupersede !== hasLink) {
        return `invalid resolution plan: supersede/action mismatch for ${existingId}`;
      }
    }

    return null;
  }

  private validateDerivedFromExists(memoryId: string, derivedFrom: string[]): void {
    if (derivedFrom.length === 0) {
      return;
    }

    const select = this.db.prepare(`SELECT 1 FROM memories WHERE id = ? LIMIT 1`);
    for (const parentId of derivedFrom) {
      if (parentId === memoryId) {
        throw new Error('derived_from contains self-reference');
      }

      const row = select.get(parentId) as { 1: number } | null;
      if (!row) {
        throw new Error(`derived_from references unknown memory id=${parentId}`);
      }
    }
  }

  private validateDerivedFromAcyclic(memoryId: string, derivedFrom: string[]): void {
    if (derivedFrom.length === 0) {
      return;
    }

    const select = this.db.prepare(`SELECT derived_from FROM memories WHERE id = ?`);
    const visited = new Set<string>([memoryId]);
    const stack = [...derivedFrom];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }

      visited.add(current);
      const row = select.get(current) as { derived_from: string | null } | null;
      if (!row) {
        throw new Error(`derived_from references unknown memory id=${current}`);
      }

      const parents = parseDerivedFrom(row.derived_from);
      for (const parent of parents) {
        if (parent === memoryId) {
          throw new Error('derived_from cycle detected');
        }

        if (!visited.has(parent)) {
          stack.push(parent);
        }
      }
    }
  }

  public getAllFactsForSubject(subjectKey: string): MemoryRecord[] {
    return (this.db
      .prepare(`
        SELECT rowid, ${MEMORY_COLUMNS}
        FROM memories
        WHERE subject_key = ? AND kind = 'fact'
        ORDER BY valid_from ASC, written_at ASC, id ASC
      `)
      .all(subjectKey) as MemoryRow[]).map(mapRow);
  }
}
