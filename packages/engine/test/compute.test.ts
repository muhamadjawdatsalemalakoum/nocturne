import { describe, it, expect } from "vitest";
import { computeWakeAt, systemClock } from "../src/index.js";

type WaitData = Parameters<typeof computeWakeAt>[0];

describe("computeWakeAt", () => {
  it("duration adds the minutes", () => {
    expect(computeWakeAt({ mode: "duration", minutes: 30 } as WaitData, 1000, systemClock)).toBe(1000 + 30 * 60 * 1000);
  });

  it("'until' lands on the next occurrence of the requested wall-clock HH:MM", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();

    const future = computeWakeAt({ mode: "until", time: "14:30" } as WaitData, now, systemClock);
    const fd = new Date(future);
    expect(fd.getHours()).toBe(14);
    expect(fd.getMinutes()).toBe(30);
    expect(future).toBeGreaterThan(now);

    // a time already passed today rolls to tomorrow, preserving the wall-clock HH:MM
    // (calendar-day increment, so it stays correct across a DST boundary)
    const past = computeWakeAt({ mode: "until", time: "08:00" } as WaitData, now, systemClock);
    const pd = new Date(past);
    expect(pd.getHours()).toBe(8);
    expect(pd.getMinutes()).toBe(0);
    expect(past).toBeGreaterThan(now);
  });
});
