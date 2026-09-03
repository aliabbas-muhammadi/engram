import { MemoryStore } from './store';
import { MemoryInput } from './types';
import { Clock, systemClock } from './clock';
import { assertIsoUtcTimestamp } from './utils';
import { buildExperienceSubject, buildExperienceText } from './conflict';

function stableJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = value[key];
  }
  return JSON.stringify(normalized);
}

interface OutcomeOptions {
  confidence?: number;
  sourceTrajectory?: string | null;
  sourceTurn?: number | null;
  contextTag?: string | null;
  derivedFrom?: string[];
  clock?: Clock;
}

export interface ExperienceRecord {
  id: string;
  status: string;
}

export interface RetrieveExperienceOptions {
  asOf?: string;
  limit?: number;
  clock?: Clock;
}

export function recordOutcome(
  store: MemoryStore,
  action: string,
  success: boolean,
  parameters: Record<string, unknown>,
  asOf?: string,
  extras: OutcomeOptions = {}
): ExperienceRecord {
  const usedClock = extras.clock ?? systemClock;
  const writtenAt = assertIsoUtcTimestamp(asOf ?? usedClock.nowUTC()).value;
  const normalizedParameters = JSON.parse(stableJson(parameters)) as Record<string, unknown>;

  const payload: MemoryInput = {
    kind: 'experience',
    subjectKey: buildExperienceSubject(action),
    text: buildExperienceText(action, normalizedParameters, success),
    validFrom: writtenAt,
    writtenAt,
    confidence: extras.confidence ?? 1,
    sourceTrajectory: extras.sourceTrajectory ?? null,
    sourceTurn: extras.sourceTurn ?? null,
    derivedFrom: extras.derivedFrom ?? null,
    contextTag: extras.contextTag ?? null
  };

  const result = store.insertExperience(payload);
  return { id: result.id, status: result.status };
}

export function retrieveExperience(
  store: MemoryStore,
  actionQuery: string,
  options: RetrieveExperienceOptions = {}
): string[] {
  const usedClock = options.clock ?? systemClock;
  const asOf = assertIsoUtcTimestamp(options.asOf ?? usedClock.nowUTC()).value;
  const rows = store.queryExperiences(actionQuery, asOf, options.limit ?? 10);

  return rows
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.writtenAt !== right.writtenAt) {
        return left.writtenAt < right.writtenAt ? 1 : -1;
      }
      return left.text.localeCompare(right.text);
    })
    .map((row) => row.text);
}
