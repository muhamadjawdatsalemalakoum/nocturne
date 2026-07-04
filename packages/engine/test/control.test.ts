import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Engine } from "../src/engine.js";
import { RunStore } from "../src/store.js";
import { CliClaudeRunner } from "../src/claude.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { Workflow } from "@nocturne/core";
import { fakeClaudePath, writeScenario, tempHome } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function oneStep(prompt = "do work"): Workflow {
  return {
    nocturne: 1,
    id: "ctl-wf",
    name: "Control",
    description: "",
    params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      { id: "a", type: "agent", position: { x: 1, y: 0 }, data: { title: "A", prompt, model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 0, backoffSec: 1 }, outputSchema: null } },
      { id: "end", type: "end", position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "end" },
    ],
  };
}

async function harness(scenario: unknown) {
  const { home, cleanup } = await tempHome();
  cleanups.push(cleanup);
  const projectRoot = path.join(home, "proj");
  await fs.mkdir(projectRoot, { recursive: true });
  const claudePath = await fakeClaudePath();
  const scenarioPath = await writeScenario(home, scenario);
  const store = new RunStore(home);
  await store.init();
  const engine = new Engine({
    store,
    config: { ...DEFAULT_CONFIG, claudePath },
    runner: new CliClaudeRunner(claudePath, { env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath } }),
  });
  return { engine, store, projectRoot };
}

async function poll(fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("poll timed out");
}

describe("engine control operations", () => {
  it("cancel kills an in-flight (hanging) agent child instead of letting it run on", async () => {
    const { engine, store, projectRoot } = await harness({ default: { hang: true } });
    const run = await engine.beginRun(oneStep(), projectRoot, {});
    await poll(async () => (await store.load(run.runId))?.steps["a"]?.status === "running");

    const t0 = Date.now();
    await engine.cancel(run.runId);
    await engine.idle(run.runId); // the batch promise must settle promptly after the kill
    const elapsed = Date.now() - t0;

    const final = (await store.load(run.runId))!;
    expect(final.status).toBe("canceled");
    // aborted step re-armed as pending (not failed) and no attempt burned
    expect(final.steps["a"]!.status).toBe("pending");
    expect(final.steps["a"]!.attempts).toBe(0);
    expect(elapsed).toBeLessThan(8000); // the hang scenario never exits on its own
  });

  it("pause kills the in-flight child; resume re-runs the step to completion", async () => {
    // first invocation hangs, the re-run (after resume) succeeds
    const { engine, store, projectRoot } = await harness({
      rules: [{ match: { any: true }, responses: [{ hang: true }, { ok: "SECOND-TRY", cost: 0.001 }] }],
    });
    const run = await engine.beginRun(oneStep(), projectRoot, {});
    await poll(async () => (await store.load(run.runId))?.steps["a"]?.status === "running");

    await engine.pause(run.runId);
    await engine.idle(run.runId);
    let s = (await store.load(run.runId))!;
    expect(s.status).toBe("paused");
    expect(s.steps["a"]!.status).toBe("pending");

    await engine.resume(run.runId);
    await engine.idle(run.runId);
    s = (await store.load(run.runId))!;
    expect(s.status).toBe("completed");
    expect(s.steps["a"]!.output).toBe("SECOND-TRY");
  });

  it("continueFrom resumes the named step's claude session (--resume plumbed through)", async () => {
    const wf = oneStep("first step");
    wf.nodes.splice(2, 0, {
      id: "b",
      type: "agent",
      position: { x: 1.5, y: 0 },
      data: { title: "B", prompt: "second step", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: "a", retry: { max: 0, backoffSec: 1 }, outputSchema: null },
    });
    wf.edges = [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "b", target: "end" },
    ];
    const { engine, projectRoot } = await harness({
      rules: [
        { match: { contains: "first step" }, responses: [{ ok: "A-DONE", sessionId: "sess-a", cost: 0.001 }] },
        { match: { contains: "second step" }, responses: [{ ok: "B-DONE", echoResume: true, cost: 0.001 }] },
      ],
    });
    const run = await engine.startRun(wf, projectRoot, {});
    expect(run.status).toBe("completed");
    expect(run.steps["a"]!.sessionId).toBe("sess-a");
    // fake-claude appends [resumed:<id>] when it received --resume
    expect(run.steps["b"]!.output).toContain("[resumed:sess-a]");
  });

  it("resume retries a failed step (failure pauses; resume re-arms and completes)", async () => {
    const { engine, store, projectRoot } = await harness({
      rules: [{ match: { any: true }, responses: [{ fail: "boom", status: 400 }, { ok: "RECOVERED", cost: 0.001 }] }],
    });
    const run = await engine.startRun(oneStep(), projectRoot, {});
    expect(run.status).toBe("paused");
    expect(run.steps["a"]!.status).toBe("failed");

    const resumed = await engine.resume(run.runId);
    await engine.idle(run.runId);
    const final = (await store.load(run.runId))!;
    expect(resumed).toBeTruthy();
    expect(final.status).toBe("completed");
    expect(final.steps["a"]!.output).toBe("RECOVERED");
    expect(final.steps["a"]!.error).toBeUndefined();
  });
});
