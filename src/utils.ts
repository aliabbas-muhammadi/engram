import { createHash } from 'node:crypto';

export interface ParsedTimestamp {
  value: string;
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function assertIsoUtcTimestamp(input: string): ParsedTimestamp {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('timestamp must be non-empty ISO-8601 UTC string');
  }

  if (!input.endsWith('Z')) {
    throw new Error(`timestamp must be UTC ('Z'): ${input}`);
  }

  if (!ISO_UTC_RE.test(input)) {
    throw new Error(`malformed timestamp: ${input}`);
  }

  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== input.slice(0, 19)) {
    throw new Error(`invalid timestamp: ${input}`);
  }

  return { value: parsed.toISOString() };
}

export function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    throw new Error('confidence must be a finite number');
  }

  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be in [0,1]: ${confidence}`);
  }

  return Number(confidence.toFixed(6));
}

export function assertRecallLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative safe integer');
  }
}

export function stableMemoryId(subjectKey: string, text: string, validFrom: string): string {
  const payload = JSON.stringify([
    String(subjectKey).trim(),
    String(text).trim(),
    String(validFrom)
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export function normalizeDerivedFrom(derivedFrom: string[] | undefined | null): string | null {
  if (!derivedFrom || derivedFrom.length === 0) return null;

  const normalized = [...new Set(derivedFrom.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error('derived_from entries must be non-empty strings');
    }
    return item.trim();
  }).sort())];

  return JSON.stringify(normalized);
}

export function toCanonicalText(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildSafeFtsMatch(rawQuery: string): string | null {
  const trimmed = (rawQuery ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const reservedOperators = new Set(['or', 'and', 'not', 'near']);
  const tokens = trimmed.split(/\s+/g);
  const safeTokens: string[] = [];

  for (const token of tokens) {
    const normalized = token
      .normalize('NFKC')
      .replace(/[()]/g, ' ')
      .replace(/[\*\"]/g, ' ')
      .replace(/'/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      continue;
    }

    const fragments = normalized.split(/\s+/g);
    for (const fragment of fragments) {
      if (!fragment) {
        continue;
      }

      if (reservedOperators.has(fragment.toLowerCase())) {
        continue;
      }

      const safe = fragment.replace(/"/g, '""');
      safeTokens.push(`"${safe}"`);
    }
  }

  if (safeTokens.length === 0) {
    return null;
  }

  return safeTokens.join(' ');
}
