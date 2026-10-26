import {
  assertIsoUtcTimestamp,
  normalizeConfidence,
  normalizeDerivedFrom,
  stableMemoryId
} from './utils.ts';
import type { MemoryInput, MemoryRecord } from './types.ts';

export function normalizeIncomingMemory(input: MemoryInput): MemoryRecord {
  if (typeof input.subjectKey !== 'string' || input.subjectKey.trim().length === 0) {
    throw new Error('subjectKey must be non-empty');
  }

  const subjectKey = input.subjectKey.trim();
  const text = input.text.trim();

  if (text.length === 0) {
    throw new Error('text must contain non-whitespace content');
  }

  const normalizedValidFrom = assertIsoUtcTimestamp(input.validFrom).value;
  const normalizedWrittenAt = assertIsoUtcTimestamp(input.writtenAt).value;
  const confidence = normalizeConfidence(input.confidence);
  const derivedFrom = normalizeDerivedFrom(input.derivedFrom ?? null);

  const canonicalText = text.trim();

  return {
    id: stableMemoryId(subjectKey, canonicalText, normalizedValidFrom),
    kind: input.kind,
    subjectKey,
    text: canonicalText,
    validFrom: normalizedValidFrom,
    writtenAt: normalizedWrittenAt,
    confidence,
    sourceTrajectory: input.sourceTrajectory ?? null,
    sourceTurn: input.sourceTurn ?? null,
    derivedFrom,
    status: input.status ?? 'active',
    supersededBy: null,
    supersededAt: null,
    contextTag: input.contextTag?.trim() || null
  };
}

export function cloneMemory(memory: MemoryRecord): MemoryRecord {
  return { ...memory };
}
