import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Engine, RunStore, CliClaudeRunner, ManualClock, DEFAULT_CONFIG } from "@nocturne/engine";
import { newWorkflow, type Workflow } from "@nocturne/core";
import { Broadcaster, WorkflowStore, startServer, type RunningServer } from "@nocturne/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient } from "../src/daemon.js";
import { createMcpServer } from "../src/server.js";

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

function twoStep(): Workflow {
  return {
    nocturne: 1,
    id: "mcp-wf",
    name: "MCP Flow",
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nocturne-mcp-"));
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
      sessionsScanned: 4,
      windowHours: req.hours ?? 24,
      cost: 0.01,
    }),
  };
  const running: RunningServer = await startServer({ engine, workflowStore, runStore, broadcaster, suggester }, 0);
  const base = `http://127.0.0.1:${running.port}`;

  // wire an MCP client <-> our MCP server <-> the real daemon
  const mcpServer = createMcpServer(new DaemonClient(base));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientT);

  cleanups.push(async () => {
    await mcp.close().catch(() => {});
    await mcpServer.close().catch(() => {});
    await running.close();
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  return { mcp, base, projectRoot };
}

function toolText(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const c = r.content?.[0];
  return c && c.type === "text" ? (c.text ?? "") : JSON.stringify(res);
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
async function poll(fn: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("poll timed out");
}

describe("nocturne MCP server", () => {
  it("advertises all the workflow tools", async () => {
    const { mcp } = await harness();
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["nocturne_status", "list_workflows", "get_workflow", "save_workflow", "run_workflow", "list_runs", "get_run", "approve_step", "pause_run", "resume_run", "cancel_run", "suggest_workflows"]) {
      expect(names).toContain(n);
    }
  });

  it("reports daemon status", async () => {
    const { mcp } = await harness();
    const res = await mcp.callTool({ name: "nocturne_status", arguments: {} });
    expect(isError(res)).toBeFalsy();
    expect(toolText(res)).toMatch(/running at http/);
  });

  it("saves a workflow and lists it", async () => {
    const { mcp } = await harness();
    const save = await mcp.callTool({ name: "save_workflow", arguments: { workflow: twoStep() } });
    expect(toolText(save)).toContain("MCP Flow");
    const list = await mcp.callTool({ name: "list_workflows", arguments: {} });
    expect(toolText(list)).toContain("mcp-wf");
  });

  it("runs an inline workflow to completion and reports per-step output", async () => {
    const { mcp, projectRoot } = await harness();
    const start = await mcp.callTool({ name: "run_workflow", arguments: { workflow: twoStep(), projectRoot } });
    const startText = toolText(start);
    expect(isError(start)).toBeFalsy();
    const runId = startText.match(/run (\S+)/)?.[1];
    expect(runId).toBeTruthy();

    await poll(async () => {
      const r = await mcp.callTool({ name: "get_run", arguments: { runId } });
      return /completed/.test(toolText(r));
    });
    const final = toolText(await mcp.callTool({ name: "get_run", arguments: { runId } }));
    expect(final).toContain("completed");
    expect(final).toContain("STEP-OK");
  });

  it("requires projectRoot + a workflow to run", async () => {
    const { mcp, projectRoot } = await harness();
    const res = await mcp.callTool({ name: "run_workflow", arguments: { projectRoot } });
    expect(isError(res)).toBe(true);
    expect(toolText(res)).toMatch(/workflowId or an inline workflow/);
  });

  it("returns a clean tool error for an unknown run", async () => {
    const { mcp } = await harness();
    const res = await mcp.callTool({ name: "get_run", arguments: { runId: "does-not-exist" } });
    expect(isError(res)).toBe(true);
    expect(toolText(res)).toMatch(/404|not found/i);
  });

  it("drafts workflows via Retrace (suggest_workflows)", async () => {
    const { mcp } = await harness();
    const res = await mcp.callTool({ name: "suggest_workflows", arguments: { hours: 12 } });
    expect(isError(res)).toBeFalsy();
    const text = toolText(res);
    expect(text).toContain("Retraced flow");
    expect(text).toMatch(/4 recent session/);
  });
});
