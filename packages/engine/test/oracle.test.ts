import { describe, it, expect } from "vitest";
import { ErrorParseOracle, parseResetTime, nextLocalTime } from "../src/index.js";
import type { ClaudeResult } from "../src/index.js";

const base: ClaudeResult = { isError: true, text: "", costUsd: 0, raw: {}, exitCode: 0 };

describe("oracle", () => {
  it("parses am/pm reset times to the next occurrence", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime(); // 10:00 local
    const at = parseResetTime("Usage limit reached. resets at 3pm", now)!;
    expect(at).toBe(nextLocalTime(now, 15, 0));
    expect(at).toBeGreaterThan(now);
  });

  it("parses 24h reset times", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const at = parseResetTime("resets 15:30", now)!;
    expect(at).toBe(nextLocalTime(now, 15, 30));
  });

  // the current (mid-2026) official Claude Code session-limit error format
  it("parses the official '· resets 3:45pm' session-limit format", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const at = parseResetTime("You've hit your session limit · resets 3:45pm", now)!;
    expect(at).toBe(nextLocalTime(now, 15, 45));
    const o = new ErrorParseOracle(60);
    expect(o.isLimitError({ isError: true, text: "You've hit your session limit · resets 3:45pm", costUsd: 0, raw: {}, exitCode: 0 })).toBe(true);
  });

  it("rolls to tomorrow when the time already passed today", () => {
    const now = new Date(2026, 0, 1, 16, 0, 0).getTime(); // 16:00
    const at = parseResetTime("resets at 3pm", now)!;
    expect(at).toBeGreaterThan(now);
    expect(at - now).toBeGreaterThan(20 * 3600 * 1000); // ~23h away
  });

  it("parses ISO timestamps", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    const at = parseResetTime("try again after 2026-01-01T12:00:00Z", now)!;
    expect(at).toBe(Date.parse("2026-01-01T12:00:00Z"));
  });

  it("returns null when nothing parseable", () => {
    expect(parseResetTime("no time here", Date.now())).toBeNull();
  });

  it("detects limit errors by status and by text", () => {
    const o = new ErrorParseOracle(60);
    expect(o.isLimitError({ ...base, apiErrorStatus: 429 })).toBe(true);
    expect(o.isLimitError({ ...base, text: "usage limit reached, resets at 3pm" })).toBe(true);
    expect(o.isLimitError({ ...base, isError: false })).toBe(false);
    expect(o.isLimitError({ ...base, text: "some other failure" })).toBe(false);
  });

  it("resetAt uses the parsed time plus jitter, else the default", () => {
    const o = new ErrorParseOracle(60);
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const parsed = o.resetAt({ ...base, text: "resets at 3pm" }, now);
    expect(parsed).toBe(nextLocalTime(now, 15, 0) + 2 * 60 * 1000);

    const fallback = o.resetAt({ ...base, text: "limit reached" }, now);
    expect(fallback).toBe(now + 60 * 60 * 1000);
  });
});
