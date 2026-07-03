import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  Engine,
  RunStore,
  CliClaudeRunner,
  ManualClock,
  DEFAULT_CONFIG,
} from "@nocturne/engine";
import { newWorkflow, type Workflow } from "@nocturne/core";
import { Broadcaster, WorkflowStore, startServer, type RunningServer } from "../src/index.js";

const engineTestDir = path.resolve(fileURLToPath(import.meta.url), "../../../engine/test");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeClaudePath(): Promise<string> {
  if (process.platform === "win32") return path.join(engineTestDir, "fixtures", "fake-claude.cmd");
  const sh = path.join(engineTestDir, "fixtures", "fake-claude");
  await fs.writeFile(sh, `#!/bin/sh\nexec node "${path.join(engineTestDir, "fixtures", "fake-claude.mjs")}" "$@"\n`);
  await fs.chmod(sh, 0o755);
  return sh;
}

/** Two-agent workflow: start -> a -> b -> end. */
function twoStep(): Workflow {
  return {
    nocturne: 1,
    id: "srv-wf",
    name: "Server Flow",
    description: "",
    params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      { id: "a", type: "agent", position: { x: 1, y: 0 }, data: { title: "A", prompt: "do a", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 1 }, outputSchema: null } },
      { id: "b", type: "agent", position: { x: 2, y: 0 }, data: { title: "B", prompt: "do b", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 1 }, outputSchema: null } },
      { id: "end", type: "end", position: { x: 3, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "b" },
      { id: "e3", source: "b", target: "end" },
    ],
  };
}

async function harness() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nocturne-srv-"));
  const projectRoot = path.join(home, "proj");
  await fs.mkdir(projectRoot, { recursive: true });
  const claudePath = await fakeClaudePath();
  const scenarioPath = path.join(home, "scen.json");
  await fs.writeFile(scenarioPath, JSON.stringify({ default: { ok: "STEP-OK", cost: 0.002 } }));

  const runStore = new RunStore(home);
  await runStore.init();
  const workflowStore = new WorkflowStore(home);
  await workflowStore.init();
  const broadcaster = new Broadcaster();
  const engine = new Engine({
    store: runStore,
    config: { ...DEFAULT_CONFIG, claudePath },
    clock: new ManualClock(0),
    runner: new CliClaudeRunner(claudePath, { env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath } }),
    onEvent: (ev) => broadcaster.broadcast(ev),
  });
  const suggester = {
    suggest: async (req: { hours?: number; max?: number; projectRoot?: string }) => ({
      suggestions: [{ workflow: newWorkflow("Retraced flow"), rationale: "seen across sessions", sourceSessions: ["s1"] }],
      sessionsScanned: 3,
      windowHours: req.hours ?? 24,
      cost: 0.012,
    }),
  };
  const running: RunningServer = await startServer({ engine, workflowStore, runStore, broadcaster, suggester }, 0);
  const base = `http://127.0.0.1:${running.port}`;
  cleanups.push(async () => {
    await running.close();
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  return { base, running, projectRoot, engine };
}

async function poll(fn: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("poll timed out");
}

describe("server — health & library", () => {
  it("reports health", async () => {
    const { base } = await harness();
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it("saves, lists, gets and deletes workflows", async () => {
    const { base } = await harness();
    const wf = newWorkflow("Lib Test");
    const saved = await (await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wf) })).json();
    expect(saved.id).toBe(wf.id);

    const list = await (await fetch(`${base}/api/workflows`)).json();
    expect(list.some((w: { id: string }) => w.id === wf.id)).toBe(true);

    const got = await (await fetch(`${base}/api/workflows/${wf.id}`)).json();
    expect(got.name).toBe("Lib Test");

    const del = await (await fetch(`${base}/api/workflows/${wf.id}`, { method: "DELETE" })).json();
    expect(del.deleted).toBe(true);
    expect((await fetch(`${base}/api/workflows/${wf.id}`)).status).toBe(404);
  });

  it("rejects a path-traversal workflow id (POST and PUT)", async () => {
    const { base } = await harness();
    const wf = newWorkflow("Evil");
    (wf as { id: string }).id = "../../../evil";
    const post = await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wf) });
    expect(post.status).toBe(400);
    // PUT forces the id from the URL param — must also be rejected
    const good = newWorkflow("Ok");
    const put = await fetch(`${base}/api/workflows/${encodeURIComponent("../../evil")}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(good) });
    expect(put.status).toBe(400);
  });

  it("blocks cross-origin state-changing requests", async () => {
    const { base } = await harness();
    const r = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify(newWorkflow("x")),
    });
    expect(r.status).toBe(403);
    // a localhost origin is allowed through
    const ok = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify(newWorkflow("y")),
    });
    expect(ok.status).toBe(200);
  });

  it("rejects an invalid workflow on save with 400", async () => {
    const { base } = await harness();
    const bad = newWorkflow("Bad");
    bad.edges.push({ id: "cyc", source: "end", target: "start" });
    bad.edges.push({ id: "cyc2", source: "start", target: "end" });
    // create an actual cycle end->start->end
    const r = await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    expect(r.status).toBe(400);
  });
});

describe("server — import/export", () => {
  it("imports a valid workflow and returns a review summary", async () => {
    const { base } = await harness();
    const wf = twoStep();
    const r = await fetch(`${base}/api/workflows/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wf) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.summary.agentSteps).toHaveLength(2);
    expect(body.workflow.id).toBe("srv-wf");
  });

  it("round-trips export -> import", async () => {
    const { base } = await harness();
    const wf = twoStep();
    await fetch(`${base}/api/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wf) });
    const text = await (await fetch(`${base}/api/workflows/${wf.id}/export`)).text();
    const reimport = await (await fetch(`${base}/api/workflows/import`, { method: "POST", headers: { "content-type": "application/json" }, body: text })).json();
    expect(reimport.workflow.id).toBe(wf.id);
  });
});

describe("server — runs & websocket", () => {
  it("starts a run, streams events over ws, and completes", async () => {
    const { base, running, projectRoot } = await harness();

    const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (d) => received.push(JSON.parse(d.toString()).type));

    const started = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: twoStep(), projectRoot, params: {} }),
    })).json();
    expect(started.runId).toBeTruthy();

    await poll(async () => {
      const s = await (await fetch(`${base}/api/runs/${started.runId}`)).json();
      return s.status === "completed";
    });

    const final = await (await fetch(`${base}/api/runs/${started.runId}`)).json();
    expect(final.status).toBe("completed");
    expect(final.steps.a.output).toBe("STEP-OK");
    expect(final.steps.b.output).toBe("STEP-OK");
    expect(final.totalCostUsd).toBeCloseTo(0.004, 5);

    // ws must have seen at least one status/step event
    expect(received.length).toBeGreaterThan(0);
    ws.close();
  });

  it("lists runs and filters by workflowId", async () => {
    const { base, projectRoot } = await harness();
    await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: twoStep(), projectRoot, params: {} }) })).json();
    const list = await (await fetch(`${base}/api/runs?workflowId=srv-wf`)).json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((r: { workflowId: string }) => r.workflowId === "srv-wf")).toBe(true);
  });

  it("rejects a run with a non-existent projectRoot", async () => {
    const { base } = await harness();
    const r = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: twoStep(), projectRoot: "/does/not/exist/xyz", params: {} }) });
    expect(r.status).toBe(400);
  });

  it("validates an inline workflow before running it (rejects invalid with 400)", async () => {
    const { base, projectRoot } = await harness();
    const bad = { nocturne: 1, id: "x", name: "x", nodes: [], edges: [] }; // no start/end
    const r = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: bad, projectRoot, params: {} }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Invalid workflow/);
  });

  it("returns a JSON 404 for an unknown /api path (never SPA HTML)", async () => {
    const { base } = await harness();
    const r = await fetch(`${base}/api/does-not-exist`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBeTruthy();
  });
});

describe("server — retrace", () => {
  it("suggests workflows from recent sessions", async () => {
    const { base } = await harness();
    const r = await fetch(`${base}/api/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 12, max: 3 }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.windowHours).toBe(12);
    expect(body.sessionsScanned).toBe(3);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].workflow.name).toBe("Retraced flow");
    expect(body.suggestions[0].rationale).toContain("sessions");
  });
});
