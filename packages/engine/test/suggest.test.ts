import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  compileDraft,
  parseDrafts,
  suggestWorkflows,
  WorkflowSuggester,
  RETRACE_SENTINEL,
  type WorkflowDraft,
} from "../src/suggest.js";
import type { ClaudeRunner, ClaudeRunOptions, ClaudeResult } from "../src/types.js";
import type { SessionDigest } from "../src/sessions.js";
import { validateWorkflow } from "@nocturne/core";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class FakeRunner implements ClaudeRunner {
  public lastPrompt = "";
  public calls = 0;
  constructor(private opts: { text?: string; isError?: boolean; cost?: number; timedOut?: boolean } = {}) {}
  async run(o: ClaudeRunOptions): Promise<ClaudeResult> {
    this.calls++;
    this.lastPrompt = o.prompt;
    return {
      isError: this.opts.isError ?? false,
      text: this.opts.text ?? "",
      costUsd: this.opts.cost ?? 0.02,
      raw: {},
      exitCode: this.opts.isError ? 1 : 0,
      timedOut: this.opts.timedOut,
    };
  }
}

function digest(id: string): SessionDigest {
  return {
    sessionId: id,
    project: "My Repo",
    cwd: "D:/x",
    gitBranch: "main",
    startedAt: 1,
    endedAt: 2,
    userPrompts: ["refactor auth"],
    tools: { Read: 2, Edit: 1 },
    files: ["src/auth.ts"],
    commands: ["npm test"],
    models: ["claude-sonnet-4"],
    messageCount: 4,
  };
}

const DRAFTS: { workflows: WorkflowDraft[] } = {
  workflows: [
    {
      name: "Auth refactor loop",
      description: "analyze, implement, test",
      rationale: "you repeated this by hand across sessions",
      sourceSessions: ["s1"],
      steps: [
        { kind: "agent", title: "Analyze", prompt: "Analyze the module in scope", model: "haiku", tools: ["Read", "Grep"] },
        { kind: "agent", title: "Implement", prompt: "Implement the change", model: "sonnet", tools: ["Read", "Edit", "Write"] },
        { kind: "wait" },
        { kind: "approval", message: "Review the diff before shipping" },
      ],
    },
    { name: "no agent", steps: [{ kind: "approval", message: "x" }] }, // must be dropped
  ],
};

describe("compileDraft", () => {
  it("builds a valid linear workflow and wires step handoffs", () => {
    const wf = compileDraft(DRAFTS.workflows[0]!);
    expect(wf).not.toBeNull();
    expect(validateWorkflow(wf).ok).toBe(true);
    const kinds = wf!.nodes.map((n) => n.type);
    expect(kinds[0]).toBe("start");
    expect(kinds[kinds.length - 1]).toBe("end");
    expect(wf!.nodes.filter((n) => n.type === "agent")).toHaveLength(2);
    expect(wf!.nodes.some((n) => n.type === "wait")).toBe(true);
    expect(wf!.nodes.some((n) => n.type === "approval")).toBe(true);
    const impl = wf!.nodes.find((n) => n.type === "agent" && (n.data as { title: string }).title === "Implement");
    expect((impl!.data as { prompt: string }).prompt).toContain("{{steps.step-0.output}}");
  });

  it("returns null when there is no runnable agent step", () => {
    expect(compileDraft(DRAFTS.workflows[1]!)).toBeNull();
  });

  it("strips model-authored placeholders from prompts before compiling", () => {
    const wf = compileDraft({ name: "x", steps: [{ kind: "agent", prompt: "Do {{steps.bogus.output}} the thing", model: "sonnet" }] });
    expect(wf).not.toBeNull();
    const p = (wf!.nodes.find((n) => n.type === "agent")!.data as { prompt: string }).prompt;
    expect(p).not.toContain("bogus");
    expect(validateWorkflow(wf).ok).toBe(true);
  });

  it("coerces unknown models to inherit", () => {
    const wf = compileDraft({ name: "x", steps: [{ kind: "agent", prompt: "go", model: "gpt-4o" }] });
    expect((wf!.nodes.find((n) => n.type === "agent")!.data as { model: string }).model).toBe("inherit");
  });
});

describe("parseDrafts", () => {
  it("parses a plain JSON object", () => {
    expect(parseDrafts(JSON.stringify(DRAFTS))).toHaveLength(2);
  });
  it("parses a fenced ```json block", () => {
    expect(parseDrafts("```json\n" + JSON.stringify(DRAFTS) + "\n```")).toHaveLength(2);
  });
  it("parses a bare array", () => {
    expect(parseDrafts(JSON.stringify(DRAFTS.workflows))).toHaveLength(2);
  });
  it("recovers JSON embedded in prose", () => {
    expect(parseDrafts("Sure! Here you go:\n" + JSON.stringify(DRAFTS) + "\nHope that helps.")).toHaveLength(2);
  });
  it("returns [] on junk", () => {
    expect(parseDrafts("no json at all")).toEqual([]);
  });
});

describe("suggestWorkflows", () => {
  it("compiles valid suggestions and drops invalid drafts", async () => {
    const runner = new FakeRunner({ text: JSON.stringify(DRAFTS), cost: 0.03 });
    const out = await suggestWorkflows({ runner, digests: [digest("s1")], cwd: os.tmpdir() });
    expect(out.suggestions).toHaveLength(1); // the no-agent draft was dropped
    expect(out.suggestions[0]!.rationale).toContain("repeated");
    expect(out.suggestions[0]!.sourceSessions).toEqual(["s1"]);
    expect(out.cost).toBe(0.03);
    expect(runner.lastPrompt).toContain(RETRACE_SENTINEL);
  });

  it("returns an error note when the agent fails", async () => {
    const runner = new FakeRunner({ isError: true, text: "Usage limit reached" });
    const out = await suggestWorkflows({ runner, digests: [digest("s1")], cwd: os.tmpdir() });
    expect(out.suggestions).toEqual([]);
    expect(out.error).toContain("Usage limit");
  });

  it("short-circuits with no digests", async () => {
    const runner = new FakeRunner({ text: JSON.stringify(DRAFTS) });
    const out = await suggestWorkflows({ runner, digests: [], cwd: os.tmpdir() });
    expect(out.suggestions).toEqual([]);
    expect(runner.calls).toBe(0);
  });
});

describe("WorkflowSuggester (end to end)", () => {
  const NOW = Date.parse("2026-07-03T12:00:00.000Z");

  async function projectsWithSession(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noc-sug-"));
    cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const sdir = path.join(dir, "slug");
    await fs.mkdir(sdir, { recursive: true });
    const at = NOW - 20 * 60_000;
    const events = [
      { type: "user", timestamp: new Date(at).toISOString(), sessionId: "s1", cwd: "D:/repo", message: { role: "user", content: "refactor auth" } },
      { type: "assistant", timestamp: new Date(at + 1000).toISOString(), sessionId: "s1", message: { model: "claude-sonnet-4", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } }] } },
    ];
    await fs.writeFile(path.join(sdir, "s1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"), "utf8");
    return dir;
  }

  it("gathers sessions and returns compiled suggestions", async () => {
    const sessionsDir = await projectsWithSession();
    const runner = new FakeRunner({ text: JSON.stringify(DRAFTS), cost: 0.05 });
    const suggester = new WorkflowSuggester({ runner, sessionsDir, now: () => NOW, defaultCwd: os.tmpdir() });
    const res = await suggester.suggest({ hours: 24, max: 5 });
    expect(res.sessionsScanned).toBe(1);
    expect(res.windowHours).toBe(24);
    expect(res.suggestions).toHaveLength(1);
    expect(res.cost).toBe(0.05);
    expect(res.note).toBeUndefined();
  });

  it("notes when there are no recent sessions", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "noc-empty-"));
    cleanups.push(async () => fs.rm(empty, { recursive: true, force: true }).catch(() => {}));
    const runner = new FakeRunner({ text: JSON.stringify(DRAFTS) });
    const suggester = new WorkflowSuggester({ runner, sessionsDir: empty, now: () => NOW, defaultCwd: os.tmpdir() });
    const res = await suggester.suggest({ hours: 24 });
    expect(res.sessionsScanned).toBe(0);
    expect(res.suggestions).toEqual([]);
    expect(res.note).toMatch(/No Claude Code sessions/);
    expect(runner.calls).toBe(0);
  });
});
