import type { ClaudeResult } from "./types.js";

/**
 * Decides whether a claude result is a rate-limit hit, and when the limit resets.
 * Pluggable so a future UsageApiOracle (the unofficial usage endpoint) can replace it.
 */
export interface LimitOracle {
  isLimitError(r: ClaudeResult): boolean;
  /** Absolute ms timestamp to resume at; falls back to a conservative default. */
  resetAt(r: ClaudeResult, now: number): number;
}

/** Next wall-clock occurrence of HH:MM (local) at or after `now` (strictly after). */
export function nextLocalTime(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  return cand > now ? cand : cand + 24 * 3600 * 1000;
}

/**
 * Parse a reset time out of an error string. Handles:
 *   "resets at 3pm", "reset at 3:30 PM", "resets 15:00",
 *   ISO timestamps, and unix epoch seconds/millis.
 * Returns absolute ms or null.
 */
export function parseResetTime(text: string, now: number): number | null {
  if (!text) return null;

  // ISO 8601
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }

  // epoch near a "reset" keyword
  const epoch = text.match(/reset[^0-9]{0,20}(\d{10,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > now - 24 * 3600 * 1000) return ms;
  }

  // clock time following the word reset(s): "resets at 3:30pm", "reset 15:00"
  const clock = text.match(/reset[a-z]*\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return nextLocalTime(now, hour, minute);
  }

  return null;
}

export class ErrorParseOracle implements LimitOracle {
  constructor(private defaultWaitMinutes: number) {}

  isLimitError(r: ClaudeResult): boolean {
    if (!r.isError) return false;
    if (r.apiErrorStatus === 429) return true;
    const t = (r.text || "") + " " + safeStr(r.raw);
    return /limit/i.test(t) && /(reset|reached|try again|rate)/i.test(t);
  }

  resetAt(r: ClaudeResult, now: number): number {
    const t = (r.text || "") + " " + safeStr(r.raw);
    // parseResetTime tries absolute (ISO, epoch) before a bare local HH:MM, so the
    // most reliable signal wins. Floor the result so a mis-parsed/early reset can
    // never resume near-instantly and hot-loop the 429.
    const parsed = parseResetTime(t, now);
    const floor = now + 60 * 1000;
    if (parsed && parsed > now) return Math.max(parsed + 2 * 60 * 1000, floor); // +2 min jitter past the reset
    return Math.max(now + this.defaultWaitMinutes * 60 * 1000, floor);
  }
}

function safeStr(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}
