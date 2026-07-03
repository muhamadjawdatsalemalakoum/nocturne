import { describe, it, expect, afterEach } from "vitest";
import {
  Engine,
  RunStore,
  CliClaudeRunner,
  ManualClock,
  ErrorParseOracle,
  DEFAULT_CONFIG,
  type EngineConfig,
  type RunState,
} from "../src/index.js";
import { linearWorkflow, diamondWorkflow } from "../../core/test/fixtures.js";
import { fakeClaudePath, writeScenario, tempHome } from "./helpers.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(scenario: unknown, cfg: Partial<EngineConfig> = {}) {
  const { home, cleanup } = await tempHome();
  cleanups.push(cleanup);
  // a real project root the runs execute in, containing the "src" subdir the fixture uses
  const projectRoot = path.join(home, "proj");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  const store = new RunStore(home);
  await store.init();
  const claudePath = await fakeClaudePath();
  const scenarioPath = await writeScenario(home, scenario);
  const runner = new CliClaudeRunner(claudePath, {
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath },
  });
  const clock = new ManualClock(0);
  const config: EngineConfig = { ...DEFAULT_CONFIG, claudePath, maxConcurrent: 4, ...cfg };
  const events: string[] = [];
  const activities: Array<{ nodeId: string; kind: string; text: string }> = [];
  const webhookCalls: Array<{ url: string; body: unknown }> = [];
  const engine = new Engine({
    store,
    runner,
    clock,
    config,
    oracle: new ErrorParseOracle(config.defaultLimitWaitMinutes),
    onEvent: (e) => {
      events.push(`${e.type}:${"nodeId" in e ? e.nodeId : ""}:${"status" in e ? e.status : ""}`);
      if (e.type === "step.activity") activities.push({ nodeId: e.nodeId, kind: e.kind, text: e.text });
    },
    postWebhook: async (url, body) => {
      webhookCalls.push({ url, body });
    },
  });
  return { engine, store, clock, home, projectRoot, events, activities, scenarioPath, webhookCalls };
}

describe("engine — happy paths", () => {
  it("runs a linear workflow and hands off output between steps", async () => {
    const { engine, projectRoot } = await harness({
      rules: [
        { match: { contains: "Analyze ticket" }, responses: [{ ok: "ANALYSIS" }] },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    const state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("completed");
    expect(state.steps["a"]!.output).toBe("ANALYSIS");
    // b only produces FIXED if it saw a's output injected into its prompt
    expect(state.steps["b"]!.output).toBe("FIXED");
    expect(state.steps["end"]!.status).toBe("succeeded");
  });

  it("fans out and joins, injecting both branch outputs into the join step", async () => {
    const { engine, projectRoot } = await harness({
      rules: [
        { match: { contains: "branch b" }, responses: [{ ok: "B-OUT" }] },
        { match: { contains: "branch c" }, responses: [{ ok: "C-OUT" }] },
        { match: { contains: "join" }, responses: [{ ok: "JOINED", echoPrompt: true }] },
      ],
      default: { ok: "A-OUT" },
    });
    const state = await engine.startRun(diamondWorkflow(), projectRoot, {});
    expect(state.status).toBe("completed");
    const joinOut = state.steps["d"]!.output ?? "";
    expect(joinOut).toContain("B-OUT");
    expect(joinOut).toContain("C-OUT");
  });
});

describe("engine — realtime activity", () => {
  it("streams tool and text activity while a step runs", async () => {
    const { engine, activities, projectRoot } = await harness({
      rules: [
        { match: { contains: "Analyze ticket" }, responses: [{ ok: "ANALYSIS", tools: ["Edit src/foo.ts"] }] },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    const state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("completed");
    const forA = activities.filter((a) => a.nodeId === "a");
    expect(forA.some((a) => a.kind === "tool" && a.text.includes("Edit src/foo.ts"))).toBe(true);
    expect(forA.some((a) => a.kind === "text" && a.text.includes("ANALYSIS"))).toBe(true);
  });
});

describe("engine — durability (the whole point)", () => {
  it("rate-limits, suspends into waiting_timer, then auto-resumes after the reset", async () => {
    const { engine, clock, projectRoot } = await harness({
      rules: [
        {
          match: { contains: "Analyze ticket" },
          responses: [{ limit: "5-hour usage limit reached. Try again later." }, { ok: "ANALYSIS" }],
        },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    let state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("waiting_timer");
    expect(state.steps["a"]!.status).toBe("waiting");
    expect(state.wakeAt).toBe(60 * 60 * 1000); // default 60-min wait

    clock.advance(60 * 60 * 1000 + 5000); // past the reset -> timer fires
    await engine.idle(state.runId);

    state = (await engine.resume(state.runId))!;
    expect(state.status).toBe("completed");
    expect(state.steps["a"]!.output).toBe("ANALYSIS");
    expect(state.steps["b"]!.output).toBe("FIXED");
  });

  it("retries a transient error after backoff, then succeeds", async () => {
    const { engine, clock, projectRoot } = await harness({
      rules: [
        {
          match: { contains: "Analyze ticket" },
          responses: [{ fail: "temporary upstream error", status: 503 }, { ok: "ANALYSIS" }],
        },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    let state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("waiting_timer"); // scheduled retry
    expect(state.steps["a"]!.status).toBe("waiting");

    clock.advance(120 * 1000);
    await engine.idle(state.runId);
    state = (await engine.resume(state.runId))!;
    expect(state.status).toBe("completed");
    expect(state.steps["a"]!.attempts).toBe(2);
  });

  it("pauses on an auth error with an actionable message", async () => {
    const { engine, projectRoot } = await harness({
      rules: [{ match: { contains: "Analyze ticket" }, responses: [{ auth: true }] }],
    });
    const state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("paused");
    expect(state.steps["a"]!.status).toBe("failed");
    expect(state.steps["a"]!.error).toMatch(/setup-token/);
  });
});

describe("engine — approvals", () => {
  function withApproval(): RunState["workflow"] {
    const wf = linearWorkflow();
    // insert an approval between a and b
    wf.nodes.push({ id: "gate", type: "approval", position: { x: 0, y: 0 }, data: { message: "Review before fix" } });
    wf.edges = [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "gate" },
      { id: "e3", source: "gate", target: "b" },
      { id: "e4", source: "b", target: "end" },
    ];
    return wf;
  }

  it("suspends at an approval gate and resumes when approved", async () => {
    const { engine, projectRoot } = await harness({
      rules: [
        { match: { contains: "Analyze ticket" }, responses: [{ ok: "ANALYSIS" }] },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    let state = await engine.startRun(withApproval(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("waiting_approval");
    expect(state.waitingApprovalNodeId).toBe("gate");

    state = (await engine.approve(state.runId, "gate", true))!;
    expect(state.status).toBe("completed");
    expect(state.steps["b"]!.output).toBe("FIXED");
  });

  it("pauses when an approval is rejected", async () => {
    const { engine, projectRoot } = await harness({
      rules: [{ match: { contains: "Analyze ticket" }, responses: [{ ok: "ANALYSIS" }] }],
    });
    let state = await engine.startRun(withApproval(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("waiting_approval");
    state = (await engine.approve(state.runId, "gate", false, "not good enough"))!;
    expect(state.status).toBe("paused");
    expect(state.steps["gate"]!.status).toBe("failed");
  });
});

describe("engine — pause / resume", () => {
  function waitWorkflow(): RunState["workflow"] {
    return {
      nocturne: 1,
      id: "wait-wf",
      name: "Wait",
      description: "",
      params: [],
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 } },
        { id: "w", type: "wait", position: { x: 1, y: 0 }, data: { mode: "duration", minutes: 60 } },
        { id: "end", type: "end", position: { x: 2, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "start", target: "w" },
        { id: "e2", source: "w", target: "end" },
      ],
    };
  }

  it("stays paused across a clock advance, then resume skips the wait and completes", async () => {
    const { engine, store, clock, projectRoot } = await harness({ default: { ok: "OK" } });
    let state = await engine.startRun(waitWorkflow(), projectRoot, {});
    expect(state.status).toBe("waiting_timer");

    await engine.pause(state.runId);
    // a paused run must not be resurrected by the clock/scheduler
    clock.advance(60 * 60 * 1000 + 5000);
    await engine.idle(state.runId);
    expect((await store.load(state.runId))!.status).toBe("paused");

    // resume "now" fires the pending wait immediately and runs to completion
    state = (await engine.resume(state.runId))!;
    expect(state.status).toBe("completed");
  });
});

describe("engine — crash recovery", () => {
  it("recovers a run left mid-flight and drives it to completion", async () => {
    const { engine, store, projectRoot } = await harness({
      rules: [
        { match: { contains: "Analyze ticket" }, responses: [{ ok: "ANALYSIS" }] },
        { match: { contains: "Given ANALYSIS" }, responses: [{ ok: "FIXED" }] },
      ],
    });
    // simulate a daemon that died while step 'a' was running
    const wf = linearWorkflow();
    const now = Date.now();
    const crashed: RunState = {
      runId: "crashed-run",
      workflowId: wf.id,
      workflowName: wf.name,
      workflow: wf,
      projectRoot: projectRoot,
      params: { ticket: "T-1" },
      status: "running",
      steps: {
        start: { nodeId: "start", type: "start", status: "succeeded", attempts: 0, output: "" },
        a: { nodeId: "a", type: "agent", status: "running", attempts: 1 },
        b: { nodeId: "b", type: "agent", status: "pending", attempts: 0 },
        end: { nodeId: "end", type: "end", status: "pending", attempts: 0 },
      },
      totalCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.create(crashed);

    await engine.recoverInterrupted();
    await engine.idle("crashed-run");

    const state = await store.load("crashed-run");
    expect(state?.status).toBe("completed");
    expect(state?.steps["a"]!.output).toBe("ANALYSIS");
    expect(state?.steps["b"]!.output).toBe("FIXED");
  });
});

describe("engine — notifications", () => {
  it("fires the webhook on completion", async () => {
    const { engine, webhookCalls, projectRoot } = await harness(
      { rules: [{ match: { any: true }, responses: [{ ok: "OK" }] }] },
      { webhookUrl: "http://example.test/hook" },
    );
    const state = await engine.startRun(linearWorkflow(), projectRoot, { ticket: "T-1" });
    expect(state.status).toBe("completed");
    expect(webhookCalls.length).toBeGreaterThanOrEqual(1);
    const completed = webhookCalls.find((c) => (c.body as { event: string }).event === "completed");
    expect(completed).toBeTruthy();
    expect(completed!.url).toBe("http://example.test/hook");
  });
});
