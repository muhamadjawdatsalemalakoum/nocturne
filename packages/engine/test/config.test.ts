import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/index.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "noc-cfg-"));
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

describe("engine config", () => {
  it("returns defaults when no config file exists", async () => {
    expect(await loadConfig(await tmp())).toEqual(DEFAULT_CONFIG);
  });

  it("save then load round-trips and keeps defaults for unset keys", async () => {
    const d = await tmp();
    await saveConfig({ ...DEFAULT_CONFIG, maxConcurrent: 5, webhookUrl: "http://hook" }, d);
    const c = await loadConfig(d);
    expect(c.maxConcurrent).toBe(5);
    expect(c.webhookUrl).toBe("http://hook");
    expect(c.claudePath).toBe(DEFAULT_CONFIG.claudePath);
  });

  it("merges a partial config file over the defaults", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "config.json"), JSON.stringify({ maxConcurrent: 9 }));
    const c = await loadConfig(d);
    expect(c.maxConcurrent).toBe(9);
    expect(c.autoResumeOnStart).toBe(DEFAULT_CONFIG.autoResumeOnStart);
    expect(c.defaultLimitWaitMinutes).toBe(DEFAULT_CONFIG.defaultLimitWaitMinutes);
  });

  it("falls back to defaults on corrupt json", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "config.json"), "{ not json");
    expect(await loadConfig(d)).toEqual(DEFAULT_CONFIG);
  });

  it("clamps/sanitizes out-of-range or wrong-typed values", async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, "config.json"), JSON.stringify({ maxConcurrent: "abc", defaultLimitWaitMinutes: -5 }));
    const c = await loadConfig(d);
    expect(c.maxConcurrent).toBe(DEFAULT_CONFIG.maxConcurrent); // "abc" → NaN → default
    expect(c.defaultLimitWaitMinutes).toBe(0); // clamped to ≥ 0

    const d2 = await tmp();
    await fs.writeFile(path.join(d2, "config.json"), JSON.stringify({ maxConcurrent: 0 }));
    expect((await loadConfig(d2)).maxConcurrent).toBe(1); // clamped to ≥ 1
  });
});
