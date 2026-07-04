// Independent end-to-end audit: exercises advertised features through the REAL
// entry points (the daemon bin, the REST API, the bundled MCP server) against the
// scripted fake-claude — including a literal SIGKILL crash-recovery test.
// Run: node scripts/audit-e2e.mjs   (exits non-zero on any failure)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5188;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), `nocturne-audit-${Date.now()}`);
const PROJ = path.join(HOME, "proj");
const FAKE = path.join(root, "packages", "engine", "test", "fixtures", process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
const results = [];
let daemon = null;

const ok = (name) => { results.push([name, true]); console.log(`  PASS  ${name}`); };
const fail = (name, why) => { results.push([name, false]); console.log(`  FAIL  ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeScenario(s) { writeFileSync(path.join(HOME, "scenario.json"), JSON.stringify(s)); try { rmSync(path.join(HOME, "scenario.json.state.json")) } catch {} }

function startDaemon() {
  const child = spawn(process.execPath, [path.join(root, "packages", "server", "bin", "nocturne.mjs"), "serve", "--port", String(PORT)], {
    env: { ...process.env, NOCTURNE_HOME: HOME, FAKE_CLAUDE_SCENARIO: path.join(HOME, "scenario.json") },
    stdio: ["ignore", "pipe", "pipe"], cwd: root,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}
async function waitHealthy(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}
const api = async (p, init) => { const r = await fetch(BASE + p, init); if (!r.ok) throw new Error(`${p} → ${r.status}: ${await r.text()}`); return r.json(); };
const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function until(fn, ms = 30000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(150); } }

const agent = (id, prompt, extra = {}) => ({ id, type: "agent", position: { x: 0, y: 0 }, data: { title: id, prompt, model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 0, backoffSec: 1 }, outputSchema: null, ...extra } });
const wf = (id, nodes, edges, params = []) => ({ nocturne: 1, id, name: id, description: "", params, nodes, edges });

async function main() {
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(path.join(HOME, "config.json"), JSON.stringify({ claudePath: FAKE, maxConcurrent: 2, defaultLimitWaitMinutes: 60, autoResumeOnStart: true }));
  writeScenario({ default: { ok: "OK", cost: 0.001 } });

  console.log("\n— boot via real bin —");
  daemon = startDaemon();
  if (await waitHealthy()) ok("daemon boots via bin/nocturne.mjs"); else return fail("daemon boots", "health never came up");

  console.log("\n— fan-out/join + params + handoffs (REST) —");
  writeScenario({ rules: [{ match: { contains: "JOIN" }, responses: [{ ok: "JOINED", echoPrompt: true, cost: 0.001 }] }], default: { ok: "BRANCH-DONE", cost: 0.001 } });
  const fanout = wf("audit-fan", [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    agent("a", "branch a for {{params.who}}"), agent("b", "branch b"),
    agent("j", "JOIN {{steps.a.output}} + {{steps.b.output}}"),
    { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [
    { id: "e1", source: "start", target: "a" }, { id: "e2", source: "start", target: "b" },
    { id: "e3", source: "a", target: "j" }, { id: "e4", source: "b", target: "j" },
    { id: "e5", source: "j", target: "end" },
  ], [{ name: "who", description: "", default: "" }]);
  const r1 = await post("/api/runs", { workflow: fanout, projectRoot: PROJ, params: { who: "auditor" } });
  const done1 = await until(async () => { const s = await api(`/api/runs/${r1.runId}`); return s.status === "completed" ? s : null; });
  if (done1.steps.j.output.includes("BRANCH-DONE") && done1.steps.j.output.includes("PROMPT<")) ok("fan-out → AND-join with param + handoff substitution");
  else fail("fan-out/join", JSON.stringify(done1.steps.j.output).slice(0, 120));

  console.log("\n— if/else condition: branch taken, other subtree skipped (REST) —");
  writeScenario({ rules: [{ match: { contains: "probe" }, responses: [{ ok: "verdict: SHIP", cost: 0.001 }] }], default: { ok: "OK", cost: 0.001 } });
  const condWf = wf("audit-cond", [
    { id: "start", type: "start", position: { x: 0, y: 0 } }, agent("probe", "probe the state"),
    { id: "gate", type: "condition", position: { x: 0, y: 0 }, data: { title: "Ship?", left: "{{steps.probe.output}}", op: "contains", value: "SHIP" } },
    agent("yes", "ship path"), agent("no", "hold path"),
    { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [
    { id: "c1", source: "start", target: "probe" }, { id: "c2", source: "probe", target: "gate" },
    { id: "c3", source: "gate", target: "yes", branch: "true" }, { id: "c4", source: "gate", target: "no", branch: "false" },
    { id: "c5", source: "yes", target: "end" }, { id: "c6", source: "no", target: "end" },
  ]);
  const rc = await post("/api/runs", { workflow: condWf, projectRoot: PROJ });
  const dc = await until(async () => { const s = await api(`/api/runs/${rc.runId}`); return s.status === "completed" ? s : null; });
  if (dc.steps.gate.output === "true" && dc.steps.yes.status === "succeeded" && dc.steps.no.status === "skipped") ok("condition routes true-branch; false subtree skipped; join completes");
  else fail("condition", JSON.stringify({ gate: dc.steps.gate.output, yes: dc.steps.yes.status, no: dc.steps.no.status }));

  console.log("\n— approval gate (REST) —");
  const gate = wf("audit-gate", [
    { id: "start", type: "start", position: { x: 0, y: 0 } }, agent("impl", "implement"),
    { id: "g", type: "approval", position: { x: 0, y: 0 }, data: { message: "check it" } },
    agent("ship", "ship it"), { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [
    { id: "e1", source: "start", target: "impl" }, { id: "e2", source: "impl", target: "g" },
    { id: "e3", source: "g", target: "ship" }, { id: "e4", source: "ship", target: "end" },
  ]);
  const r2 = await post("/api/runs", { workflow: gate, projectRoot: PROJ });
  await until(async () => (await api(`/api/runs/${r2.runId}`)).status === "waiting_approval");
  await post(`/api/runs/${r2.runId}/approve`, { nodeId: "g", approved: true });
  const done2 = await until(async () => { const s = await api(`/api/runs/${r2.runId}`); return s.status === "completed" ? s : null; });
  ok("approval gate pauses run; approve completes it");

  console.log("\n— limit → waiting_timer → auto-resume (REST, real clock ~3min: parsed reset + anti-hot-loop jitter) —");
  writeScenario({ rules: [{ match: { contains: "LIMITED" }, responses: [{ limit: `Usage limit reached. resets at ${new Date(Date.now() + 61_000).toISOString()}` }, { ok: "AFTER-RESET", cost: 0.001 }] }], default: { ok: "OK", cost: 0.001 } });
  const lim = wf("audit-limit", [
    { id: "start", type: "start", position: { x: 0, y: 0 } }, agent("l", "LIMITED work"),
    { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [{ id: "e1", source: "start", target: "l" }, { id: "e2", source: "l", target: "end" }]);
  const r3 = await post("/api/runs", { workflow: lim, projectRoot: PROJ });
  await until(async () => (await api(`/api/runs/${r3.runId}`)).status === "waiting_timer");
  ok("rate-limit error suspends into waiting_timer with parsed floor");
  const done3 = await until(async () => { const s = await api(`/api/runs/${r3.runId}`); return s.status === "completed" ? s : null; }, 260000);
  if (done3.steps.l.output === "AFTER-RESET") ok("auto-resume after the wait completes the step (unattended)");
  else fail("auto-resume", done3.steps.l.output);

  console.log("\n— SIGKILL crash recovery (the durability claim, literally) —");
  writeScenario({ rules: [{ match: { contains: "SLOW" }, responses: [{ ok: "SLOW-DONE", delayMs: 1500, cost: 0.001, tools: ["Read a", "Edit b", "Bash c"] }] }], default: { ok: "OK", cost: 0.001 } });
  const crash = wf("audit-crash", [
    { id: "start", type: "start", position: { x: 0, y: 0 } }, agent("s1", "SLOW step one"), agent("s2", "step two"),
    { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [{ id: "e1", source: "start", target: "s1" }, { id: "e2", source: "s1", target: "s2" }, { id: "e3", source: "s2", target: "end" }]);
  const r4 = await post("/api/runs", { workflow: crash, projectRoot: PROJ });
  await until(async () => (await api(`/api/runs/${r4.runId}`)).steps.s1.status === "running");
  daemon.kill("SIGKILL"); // no goodbye
  await sleep(500);
  writeScenario({ default: { ok: "RECOVERED", cost: 0.001 } });
  daemon = startDaemon();
  if (!(await waitHealthy())) return fail("crash recovery", "daemon did not restart");
  const done4 = await until(async () => { const s = await api(`/api/runs/${r4.runId}`); return s.status === "completed" ? s : null; }, 45000);
  if (done4.steps.s1.output === "RECOVERED" && done4.steps.s2.output === "RECOVERED") ok("SIGKILL mid-step → restart → run auto-resumes and completes");
  else fail("crash recovery", JSON.stringify({ s1: done4.steps.s1.output, s2: done4.steps.s2.output }));

  console.log("\n— cancel kills the in-flight child (REST) —");
  writeScenario({ rules: [{ match: { contains: "HANG" }, responses: [{ hang: true }] }], default: { ok: "OK", cost: 0.001 } });
  const hang = wf("audit-hang", [
    { id: "start", type: "start", position: { x: 0, y: 0 } }, agent("h", "HANG forever"),
    { id: "end", type: "end", position: { x: 0, y: 0 } },
  ], [{ id: "e1", source: "start", target: "h" }, { id: "e2", source: "h", target: "end" }]);
  const r5 = await post("/api/runs", { workflow: hang, projectRoot: PROJ });
  await until(async () => (await api(`/api/runs/${r5.runId}`)).steps.h.status === "running");
  const t0 = Date.now();
  await post(`/api/runs/${r5.runId}/cancel`, {});
  const s5 = await until(async () => { const s = await api(`/api/runs/${r5.runId}`); return s.status === "canceled" && s.steps.h.status !== "running" ? s : null; }, 10000);
  if (Date.now() - t0 < 9000 && s5.steps.h.status === "pending") ok("cancel tree-kills a hanging child promptly; step re-armed");
  else fail("cancel kill", `${Date.now() - t0}ms, step=${s5.steps.h.status}`);

  console.log("\n— Retrace via REST (fake sessions + scripted drafts) —");
  const sess = path.join(HOME, "sessions", "D--proj");
  mkdirSync(sess, { recursive: true });
  const nowIso = (m) => new Date(Date.now() - m * 60000).toISOString();
  writeFileSync(path.join(sess, "s1.jsonl"), [
    JSON.stringify({ type: "user", timestamp: nowIso(30), sessionId: "s1", cwd: "D:/proj", message: { role: "user", content: "fix the checkout bug" } }),
    JSON.stringify({ type: "assistant", timestamp: nowIso(29), sessionId: "s1", message: { model: "claude-sonnet-4", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/x.ts" } }] } }),
  ].join("\n"));
  // daemon reads NOCTURNE_SESSIONS_DIR at suggest-time via env — restart daemon with it set
  daemon.kill("SIGKILL"); await sleep(400);
  daemon = spawn(process.execPath, [path.join(root, "packages", "server", "bin", "nocturne.mjs"), "serve", "--port", String(PORT)], {
    env: { ...process.env, NOCTURNE_HOME: HOME, FAKE_CLAUDE_SCENARIO: path.join(HOME, "scenario.json"), NOCTURNE_SESSIONS_DIR: path.join(HOME, "sessions") },
    stdio: ["ignore", "ignore", "ignore"], cwd: root,
  });
  if (!(await waitHealthy())) return fail("retrace", "daemon restart failed");
  writeScenario({ rules: [{ match: { contains: "NOCTURNE_RETRACE_V1" }, responses: [{ ok: JSON.stringify({ workflows: [{ name: "Checkout fix loop", description: "d", rationale: "r", sourceSessions: ["s1"], steps: [{ kind: "agent", title: "Fix", prompt: "fix checkout", model: "sonnet", tools: ["Edit"] }] }] }), cost: 0.002 }] }], default: { ok: "OK", cost: 0.001 } });
  const sug = await post("/api/suggest", { hours: 24, max: 3 });
  if (sug.suggestions.length === 1 && sug.suggestions[0].workflow.nodes.some((n) => n.type === "agent")) ok("Retrace: sessions → digests → drafted, compiled, validated workflow");
  else fail("retrace", JSON.stringify(sug).slice(0, 200));

  console.log("\n— full loop through the BUNDLED MCP server (stdio) —");
  const mcp = spawn(process.execPath, [path.join(root, "integrations", "claude-plugin", "server", "index.cjs")], {
    env: { ...process.env, NOCTURNE_DAEMON_URL: BASE }, stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = ""; const pending = new Map();
  mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
  const rpc = (id, method, params) => new Promise((res, rej) => { pending.set(id, res); setTimeout(() => rej(new Error(`rpc ${method} timeout`)), 20000); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const runRes = await rpc(2, "tools/call", { name: "run_workflow", arguments: { workflow: wf("audit-mcp", [{ id: "start", type: "start", position: { x: 0, y: 0 } }, agent("m", "via mcp"), { id: "end", type: "end", position: { x: 0, y: 0 } }], [{ id: "e1", source: "start", target: "m" }, { id: "e2", source: "m", target: "end" }]), projectRoot: PROJ } });
  const runId = /run (\S+) /.exec(runRes.result.content[0].text)?.[1];
  let mcpDone = false;
  for (let k = 0; k < 40 && !mcpDone; k++) { const g = await rpc(10 + k, "tools/call", { name: "get_run", arguments: { runId } }); mcpDone = /completed/.test(g.result.content[0].text); if (!mcpDone) await sleep(300); }
  mcp.kill();
  if (mcpDone) ok("bundled MCP server: run_workflow → get_run → completed (real stdio)");
  else fail("mcp loop", "never completed");

  console.log("\n— library + import/export round-trip (REST) —");
  await post("/api/workflows", fanout);
  const listed = await api("/api/workflows");
  const exported = await (await fetch(`${BASE}/api/workflows/${fanout.id}/export`)).text();
  const reimport = await post("/api/workflows/import", JSON.parse(exported));
  if (listed.some((w) => w.id === fanout.id) && reimport.workflow.id === fanout.id && reimport.summary.agentSteps.length === 3) ok("library save/list + export → import round-trip with review summary");
  else fail("library/import", "mismatch");
}

main().catch((e) => { fail("audit aborted", e.message); }).finally(() => {
  try { daemon?.kill("SIGKILL"); } catch {}
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
  const failed = results.filter(([, p]) => !p);
  console.log(`\n=== AUDIT: ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
});
