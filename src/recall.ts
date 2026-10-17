import { MemoryStore } from './store';
import { Clock, systemClock } from './clock';
import { assertIsoUtcTimestamp } from './utils';
import { MemoryRecord } from './types';

export interface RecallCandidate {
  memory: MemoryRecord;
  rank: number;
}

export class RecallService {
  private readonly store: MemoryStore;
  private readonly clock: Clock;

  public constructor(store: MemoryStore, clock?: Clock) {
    this.store = store;
    this.clock = clock ?? systemClock;
  }

  public recallAsOf(query: string, asOf: string, limit = 1): RecallCandidate[] {
    const canonicalAsOf = assertIsoUtcTimestamp(asOf).value;

    const rows = this.store.queryFacts(query, canonicalAsOf, ['active', 'contextual']);
    return rows
      .slice(0, limit)
      .map((memory, idx) => ({
        memory,
        rank: idx + 1
      }));
  }

  public recallNow(query: string, limit = 1): RecallCandidate[] {
    return this.recallAsOf(query, this.clock.nowUTC(), limit);
  }

  public detectContradictions(query: string): ReturnType<MemoryStore['detectContradictions']> {
    return this.store.detectContradictions(query, this.clock.nowUTC(), { mode: 'governed' });
  }

  public review(query: string): MemoryRecord[] {
    return this.store.queryFacts(query, this.clock.nowUTC(), ['flagged']);
  }
}
