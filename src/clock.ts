export interface Clock {
  nowUTC(): string;
}

export const systemClock: Clock = {
  nowUTC() {
    return new Date().toISOString();
  }
};
