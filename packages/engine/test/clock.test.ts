import { describe, it, expect } from "vitest";
import { ManualClock } from "../src/index.js";

describe("ManualClock", () => {
  it("fires timers when time advances past their deadline", () => {
    const c = new ManualClock(1000);
    const fired: string[] = [];
    c.setTimer(() => fired.push("a"), 500);
    c.setTimer(() => fired.push("b"), 1500);
    c.advance(400);
    expect(fired).toEqual([]);
    c.advance(200); // now 1600, past 'a' (1500)
    expect(fired).toEqual(["a"]);
    c.advance(1000); // now 2600, past 'b' (2500)
    expect(fired).toEqual(["a", "b"]);
  });

  it("fires timers in chronological order", () => {
    const c = new ManualClock(0);
    const fired: number[] = [];
    c.setTimer(() => fired.push(3), 3000);
    c.setTimer(() => fired.push(1), 1000);
    c.setTimer(() => fired.push(2), 2000);
    c.advance(5000);
    expect(fired).toEqual([1, 2, 3]);
  });

  it("clear cancels a timer", () => {
    const c = new ManualClock(0);
    let fired = false;
    const h = c.setTimer(() => (fired = true), 1000);
    c.clear(h);
    c.advance(2000);
    expect(fired).toBe(false);
  });

  it("advances now() even with no timers", () => {
    const c = new ManualClock(100);
    c.advance(50);
    expect(c.now()).toBe(150);
  });
});
