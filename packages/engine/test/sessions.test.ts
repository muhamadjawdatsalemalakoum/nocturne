import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  gatherRecentSessions,
  digestTranscript,
  redactSecrets,
  claudeProjectsDir,
} from "../src/sessions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env["NOCTURNE_SESSIONS_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
});

async function tempDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "noc-sessions-"));
  cleanups.push(async () => fs.rm(d, { recursive: true, force: true }).catch(() => {}));
  return d;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Write a transcript file under <projects>/<slug>/<id>.jsonl and set its mtime. */
async function writeTranscript(
  projects: string,
  slug: string,
  id: string,
  events: unknown[],
  mtimeMs?: number,
): Promise<string> {
  const dir = path.join(projects, slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  if (mtimeMs !== undefined) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const t = (minsAgo: number) => NOW - minsAgo * 60_000;

function sessionEvents(sid: string, atMs: number, cwd = "D:/Coding Projects/My Repo") {
  return [
    { type: "user", timestamp: iso(atMs), sessionId: sid, cwd, gitBranch: "main", message: { role: "user", content: "Refactor the auth module and keep tests green" } },
    { type: "assistant", timestamp: iso(atMs + 1000), sessionId: sid, cwd, message: { model: "claude-sonnet-4", content: [
      { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
      { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      { type: "text", text: "done" },
    ] } },
    { type: "user", timestamp: iso(atMs + 2000), sessionId: sid, cwd, message: { role: "user", content: "now update the changelog" } },
  ];
}

describe("redactSecrets", () => {
  it("masks api keys and tokens", () => {
    expect(redactSecrets("key sk-ant-abcdef0123456789 end")).toContain("«redacted»");
    expect(redactSecrets("ghp_" + "a".repeat(30))).toBe("«redacted»");
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});

describe("claudeProjectsDir", () => {
  it("honors NOCTURNE_SESSIONS_DIR verbatim", () => {
    process.env["NOCTURNE_SESSIONS_DIR"] = "/tmp/x/projects";
    expect(claudeProjectsDir()).toBe("/tmp/x/projects");
  });
  it("appends projects/ to CLAUDE_CONFIG_DIR", () => {
    process.env["CLAUDE_CONFIG_DIR"] = path.join("/tmp", "cfg");
    expect(claudeProjectsDir()).toBe(path.join("/tmp", "cfg", "projects"));
  });
});

describe("digestTranscript", () => {
  it("extracts prompts, tools, files, commands, models and timing", async () => {
    const dir = await tempDir();
    const file = await writeTranscript(dir, "slug", "s1", sessionEvents("s1", t(30)));
    const d = await digestTranscript(file, { sinceMs: t(24 * 60), slug: "slug" });
    expect(d).not.toBeNull();
    expect(d!.sessionId).toBe("s1");
    expect(d!.project).toBe("My Repo");
    expect(d!.gitBranch).toBe("main");
    expect(d!.userPrompts).toEqual([
      "Refactor the auth module and keep tests green",
      "now update the changelog",
    ]);
    expect(d!.tools).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(d!.files).toContain("src/auth.ts");
    expect(d!.commands).toContain("npm test");
    expect(d!.models).toEqual(["claude-sonnet-4"]);
    expect(d!.messageCount).toBe(3);
  });

  it("returns null for a session that ended before the window", async () => {
    const dir = await tempDir();
    const file = await writeTranscript(dir, "slug", "old", sessionEvents("old", t(48 * 60)));
    const d = await digestTranscript(file, { sinceMs: t(24 * 60), slug: "slug" });
    expect(d).toBeNull();
  });

  it("skips malformed lines, noise prompts, and sidechain chatter", async () => {
    const dir = await tempDir();
    const file = await writeTranscript(dir, "slug", "s2", [
      "{ this is not json",
      { type: "user", timestamp: iso(t(10)), sessionId: "s2", message: { role: "user", content: "<command-name>/compact</command-name>" } },
      { type: "user", isSidechain: true, timestamp: iso(t(9)), sessionId: "s2", message: { role: "user", content: "internal subagent prompt" } },
      { type: "user", timestamp: iso(t(8)), sessionId: "s2", message: { role: "user", content: "real user intent here" } },
      { type: "assistant", timestamp: iso(t(7)), sessionId: "s2", message: { model: "<synthetic>", content: [] } },
    ]);
    const d = await digestTranscript(file, { sinceMs: t(24 * 60), slug: "slug" });
    expect(d).not.toBeNull();
    expect(d!.userPrompts).toEqual(["real user intent here"]);
    expect(d!.models).toEqual([]); // <synthetic> is dropped
  });

  it("redacts secrets inside prompts", async () => {
    const dir = await tempDir();
    const file = await writeTranscript(dir, "slug", "s3", [
      { type: "user", timestamp: iso(t(5)), sessionId: "s3", message: { role: "user", content: "use token sk-ant-0123456789abcdef please" } },
      { type: "assistant", timestamp: iso(t(4)), sessionId: "s3", message: { model: "claude-haiku-4", content: [{ type: "tool_use", name: "Read", input: {} }] } },
    ]);
    const d = await digestTranscript(file, { sinceMs: t(24 * 60), slug: "slug" });
    expect(d!.userPrompts[0]).toContain("«redacted»");
    expect(d!.userPrompts[0]).not.toContain("sk-ant-");
  });
});

describe("gatherRecentSessions", () => {
  it("returns digests for in-window sessions, newest first, and skips old ones", async () => {
    const dir = await tempDir();
    await writeTranscript(dir, "projA", "recent", sessionEvents("recent", t(30)), t(30));
    await writeTranscript(dir, "projB", "older-inwindow", sessionEvents("older", t(600)), t(600));
    await writeTranscript(dir, "projA", "ancient", sessionEvents("ancient", t(48 * 60)), t(48 * 60));

    const digests = await gatherRecentSessions({ hours: 24, now: NOW, dir });
    const ids = digests.map((d) => d.sessionId);
    expect(ids).toContain("recent");
    expect(ids).toContain("older");
    expect(ids).not.toContain("ancient");
    // newest (recent) first
    expect(ids[0]).toBe("recent");
  });

  it("returns [] when the projects directory does not exist", async () => {
    const digests = await gatherRecentSessions({ hours: 24, now: NOW, dir: path.join(os.tmpdir(), "does-not-exist-xyz") });
    expect(digests).toEqual([]);
  });

  it("respects maxSessions", async () => {
    const dir = await tempDir();
    for (let i = 0; i < 4; i++) {
      await writeTranscript(dir, "p", `s${i}`, sessionEvents(`s${i}`, t(10 + i)), t(10 + i));
    }
    const digests = await gatherRecentSessions({ hours: 24, now: NOW, dir, maxSessions: 2 });
    expect(digests).toHaveLength(2);
  });
});
