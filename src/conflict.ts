import type {
  MemoryRecord,
  ResolutionPlan,
  ResolutionAction,
  ResolutionLogInput,
  ResolutionRule,
  SupersessionLink
} from './types.ts';
import { toCanonicalText } from './utils.ts';

const LOW_CONFIDENCE_DELTA = 0.1;

export interface ConflictOptions {
  supersedeIfLowerConfidence?: number;
}

function compareDateString(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareTimeThenId(left: MemoryRecord, right: MemoryRecord): number {
  let comparison = compareDateString(left.validFrom, right.validFrom);
  if (comparison !== 0) {
    return comparison;
  }

  comparison = compareDateString(left.writtenAt, right.writtenAt);
  if (comparison !== 0) {
    return comparison;
  }

  if (left.confidence !== right.confidence) {
    return left.confidence < right.confidence ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

function areTextIncompatible(left: string, right: string): boolean {
  return toCanonicalText(left) !== toCanonicalText(right);
}

/**
 * Distinct non-null context tags never collide by R1.
 * R2 applies only when both facts have non-null different contexts.
 */
function isSameScopeContext(leftContext: string | null, rightContext: string | null): boolean {
  if (leftContext !== null && rightContext !== null) {
    return leftContext === rightContext;
  }

  return true;
}

function makeLog(
  incomingId: string,
  existingId: string | null,
  action: ResolutionAction,
  rule: ResolutionRule,
  decisionTs: string,
  details: string
): ResolutionLogInput {
  return {
    incomingId,
    existingId,
    action,
    rule,
    decisionTs,
    details
  };
}

export function deterministicCandidateOrder(candidates: MemoryRecord[]): MemoryRecord[] {
  return [...candidates].sort(compareTimeThenId);
}

export function resolveConflictPlan(
  incoming: MemoryRecord,
  allCandidates: MemoryRecord[],
  decisionTs: string,
  options: ConflictOptions = {}
): ResolutionPlan {
  const candidates = deterministicCandidateOrder(allCandidates);

  const steps = candidates.map<
    { existingId: string; action: 'retain' | 'contextualize' | 'supersede' | 'flag'; rule: ResolutionRule; details: string }
  >((candidate) => ({
    existingId: candidate.id,
    action: 'retain',
    rule: 'R0_RETAIN',
    details: 'default retain'
  }));

  const logs: ResolutionLogInput[] = steps.map((step) =>
    makeLog(
      incoming.id,
      step.existingId,
      'retain',
      step.rule,
      decisionTs,
      step.details
    )
  );

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const duplicate = byId.get(incoming.id);
  if (duplicate) {
    return {
      incomingId: incoming.id,
      incomingStatus: duplicate.status,
      incomingIsDuplicate: true,
      steps: [
        {
          existingId: incoming.id,
          action: 'retain',
          rule: 'R3_DUPLICATE',
          details: 'duplicate insertion by stable id'
        }
      ],
      logs: [
        makeLog(
          incoming.id,
          duplicate?.id ?? incoming.id,
          'retain',
          'R3_DUPLICATE',
          decisionTs,
          'deterministic duplicate prevented by stable id'
        )
      ],
      supersessionLinks: []
    };
  }

  const incompatible = candidates.filter((candidate) => areTextIncompatible(candidate.text, incoming.text));
  const contextCandidates = incompatible.filter(
    (candidate) => !isSameScopeContext(candidate.contextTag, incoming.contextTag)
  );

  for (const candidate of contextCandidates) {
    const idx = steps.findIndex((step) => step.existingId === candidate.id);
    if (idx >= 0) {
      steps[idx] = {
        existingId: candidate.id,
        action: 'contextualize',
        rule: 'R2_CONTEXT_COEXIST',
        details: 'distinct non-null contexts coexist'
      };
    }

    const logIndex = logs.findIndex((entry) => entry.existingId === candidate.id);
    if (logIndex >= 0) {
      logs[logIndex] = makeLog(
        incoming.id,
        candidate.id,
        'contextualize',
        'R2_CONTEXT_COEXIST',
        decisionTs,
        'R2: contexts are non-null and distinct'
      );
    }
  }

  const sameScopeConflicts = incompatible.filter((candidate) =>
    isSameScopeContext(candidate.contextTag, incoming.contextTag)
  );

  const hasLaterEffectiveConflict = sameScopeConflicts.some(
    (candidate) => compareDateString(candidate.validFrom, incoming.validFrom) > 0
  );

  if (hasLaterEffectiveConflict) {
    for (const conflict of sameScopeConflicts) {
      const logIndex = logs.findIndex((entry) => entry.existingId === conflict.id);
      if (logIndex >= 0) {
        logs[logIndex] = makeLog(
          incoming.id,
          conflict.id,
          'flag',
          'R3_OLDER_EFFECTIVE_HISTORY',
          decisionTs,
          'incoming valid_from is older than a known later-effective memory'
        );
      }
    }

    return {
      incomingId: incoming.id,
      incomingStatus: 'flagged',
      incomingIsDuplicate: false,
      steps,
      logs,
      supersessionLinks: []
    };
  }

  const sameTimeConflict = sameScopeConflicts.some(
    (candidate) => compareDateString(candidate.validFrom, incoming.validFrom) === 0
  );

  if (sameTimeConflict) {
    for (const conflict of sameScopeConflicts) {
      const logIndex = logs.findIndex((entry) => entry.existingId === conflict.id);
      if (logIndex >= 0) {
        logs[logIndex] = makeLog(
          incoming.id,
          conflict.id,
          'flag',
          'R3_SAME_TIME_CONFLICT',
          decisionTs,
          'same valid_from with incompatible text'
        );
      }
    }

    return {
      incomingId: incoming.id,
      incomingStatus: 'flagged',
      incomingIsDuplicate: false,
      steps,
      logs,
      supersessionLinks: []
    };
  }

  const confidenceFloor = options.supersedeIfLowerConfidence ?? LOW_CONFIDENCE_DELTA;
  const hasLowConfidenceIncoming = sameScopeConflicts.some(
    (candidate) => incoming.confidence + confidenceFloor < candidate.confidence
  );

  if (hasLowConfidenceIncoming) {
    for (const conflict of sameScopeConflicts) {
      const idx = steps.findIndex((step) => step.existingId === conflict.id);
      if (idx >= 0) {
        steps[idx] = {
          existingId: conflict.id,
          action: 'retain',
          rule: 'R0_RETAIN',
          details: 'same-scope conflict retained due confidence floor'
        };
      }

      const logIndex = logs.findIndex((entry) => entry.existingId === conflict.id);
      if (logIndex >= 0) {
        logs[logIndex] = makeLog(
          incoming.id,
          conflict.id,
          'flag',
          'R3_LOW_CONFIDENCE',
          decisionTs,
          'low-confidence contradiction is flagged'
        );
      }
    }

    return {
      incomingId: incoming.id,
      incomingStatus: 'flagged',
      incomingIsDuplicate: false,
      steps,
      logs,
      supersessionLinks: []
    };
  }

  const supersessionLinks: SupersessionLink[] = [];
  const supersededConflicts = sameScopeConflicts.filter(
    (candidate) => compareDateString(candidate.validFrom, incoming.validFrom) < 0
  );

  for (const candidate of supersededConflicts) {
    const idx = steps.findIndex((step) => step.existingId === candidate.id);
    if (idx >= 0) {
      steps[idx] = {
        existingId: candidate.id,
        action: 'supersede',
        rule: 'R1_SUPERSEDE',
        details: 'incoming supersedes earlier same-scope fact'
      };
    }

    const logIndex = logs.findIndex((entry) => entry.existingId === candidate.id);
    if (logIndex >= 0) {
      logs[logIndex] = makeLog(
        incoming.id,
        candidate.id,
        'supersede',
        'R1_SUPERSEDE',
        decisionTs,
        'incoming valid_from is later and incompatible'
      );
    }

    supersessionLinks.push({
      existingId: candidate.id,
      supersededBy: incoming.id,
      supersededAt: incoming.writtenAt
    });
  }

  return {
    incomingId: incoming.id,
    incomingStatus: incoming.status,
    incomingIsDuplicate: false,
    steps,
    logs,
    supersessionLinks
  };
}

/**
 * For a backdated write: the first fact, in write order, among facts already
 * stored that were written after `incoming`, that R1 would have used to
 * supersede `incoming` had it been recorded on time.
 *
 * Candidates must be in the same scope, incompatible, and effective later.
 * The caller excludes facts that were themselves contested. A candidate far
 * less confident than `incoming` is skipped, because R3 would have flagged it
 * rather than applied it.
 */
export function findLaterSuperseder(
  incoming: MemoryRecord,
  laterWrites: MemoryRecord[],
  options: ConflictOptions = {}
): MemoryRecord | null {
  const confidenceFloor = options.supersedeIfLowerConfidence ?? LOW_CONFIDENCE_DELTA;
  const byWriteTime = [...laterWrites].sort(
    (left, right) => compareDateString(left.writtenAt, right.writtenAt) || compareTimeThenId(left, right)
  );

  return (
    byWriteTime.find(
      (candidate) =>
        candidate.id !== incoming.id &&
        isSameScopeContext(candidate.contextTag, incoming.contextTag) &&
        areTextIncompatible(candidate.text, incoming.text) &&
        compareDateString(candidate.validFrom, incoming.validFrom) > 0 &&
        !(candidate.confidence + confidenceFloor < incoming.confidence)
    ) ?? null
  );
}

export function buildExperienceSubject(action: string): string {
  return `action.${action}`;
}

export function buildExperienceText(action: string, parameters: Record<string, unknown>, success: boolean): string {
  const normalized = JSON.stringify(parameters);
  return `${action} ${normalized} ${(success ? 'success' : 'failure')}`;
}
