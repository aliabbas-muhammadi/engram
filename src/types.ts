export type MemoryKind = 'fact' | 'experience';
export type MemoryStatus = 'active' | 'superseded' | 'flagged' | 'contextual';
export type ResolutionAction = 'supersede' | 'contextualize' | 'flag' | 'retain';

export type ResolutionRule =
  | 'R0_RETAIN'
  | 'R1_SUPERSEDE'
  | 'R2_CONTEXT_COEXIST'
  | 'R3_LOW_CONFIDENCE'
  | 'R3_SAME_TIME_CONFLICT'
  | 'R3_OLDER_EFFECTIVE_HISTORY'
  | 'R3_DUPLICATE';

export interface ResolutionLog {
  id: string;
  incomingId: string;
  existingId: string | null;
  action: ResolutionAction;
  rule: ResolutionRule;
  decisionTs: string;
  details: string;
}

export type ResolutionLogInput = Omit<ResolutionLog, 'id'>;

export interface SupersessionLink {
  existingId: string;
  supersededBy: string;
  supersededAt: string;
}

export interface ResolutionStep {
  existingId: string;
  action: ResolutionAction;
  rule: ResolutionRule;
  details: string;
}

export interface ResolutionPlan {
  incomingId: string;
  incomingStatus: MemoryStatus;
  incomingIsDuplicate: boolean;
  steps: ResolutionStep[];
  logs: ResolutionLogInput[];
  supersessionLinks: SupersessionLink[];
}

export interface MemoryInput {
  kind: MemoryKind;
  subjectKey: string;
  text: string;
  validFrom: string;
  writtenAt: string;
  confidence: number;
  sourceTrajectory?: string | null;
  sourceTurn?: number | null;
  derivedFrom?: string[] | null;
  status?: MemoryStatus;
  contextTag?: string | null;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  subjectKey: string;
  text: string;
  validFrom: string;
  writtenAt: string;
  confidence: number;
  sourceTrajectory: string | null;
  sourceTurn: number | null;
  derivedFrom: string | null;
  status: MemoryStatus;
  supersededBy: string | null;
  supersededAt: string | null;
  contextTag: string | null;
}

export interface RankedMemory {
  memory: MemoryRecord;
  score: number;
}

export interface ContradictionPair {
  subjectKey: string;
  firstId: string;
  secondId: string;
  firstText: string;
  secondText: string;
  seenAsOf: string;
}

export type InsertResultKind =
  | 'created'
  | 'idempotent-hit'
  | 'conflicted+resolved'
  | 'conflicted+flagged'
  | 'error';

interface InsertResultBase {
  id: string;
  status: MemoryStatus;
  message?: string;
  duplicateOf?: string;
  plan?: ResolutionPlan;
}

export type InsertResult =
  | ({ kind: 'created' } & InsertResultBase)
  | ({ kind: 'idempotent-hit'; id: string; status: MemoryStatus; duplicateOf: string; plan?: ResolutionPlan; message?: string })
  | ({ kind: 'conflicted+resolved'; id: string; status: MemoryStatus; plan: ResolutionPlan; message?: string })
  | ({ kind: 'conflicted+flagged'; id: string; status: MemoryStatus; plan: ResolutionPlan; message?: string })
  | ({ kind: 'error'; id: string; status: MemoryStatus; message: string });

export interface DetectContradictionOptions {
  mode?: 'governed' | 'append-only';
}
