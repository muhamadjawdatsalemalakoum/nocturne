/** Abstraction over time so the scheduler and waits can be unit-tested deterministically. */
export interface Clock {
  now(): number;
  /** schedule fn after `ms`; returns a handle usable with clear(). */
  setTimer(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Manually-advanced clock for tests. */
export class ManualClock implements Clock {
  private t: number;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private seq = 0;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clear(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Advance time, firing any timers whose deadline is reached (in order). */
  advance(ms: number): void {
    const target = this.t + ms;
    // fire timers in chronological order until we reach target
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const next = due[0]!;
      this.timers = this.timers.filter((x) => x.id !== next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }

  get pending(): number {
    return this.timers.length;
  }
}
