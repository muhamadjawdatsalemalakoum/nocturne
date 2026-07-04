import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Engine, evalCondition } from "../src/engine.js";
import { RunStore } from "../src/store.js";
import { CliClaudeRunner } from "../src/claude.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { validateWorkflow, type Workflow, type TemplateContext } from "@nocturne/core";
import { fakeClaudePath, writeScenario, tempHome } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const agent = (id: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  id, type: "agent" as const, position: { x: 0, y: 0 },
  data: { title: id, prompt, model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk" as const, continueFrom: null, retry: { max: 0, backoffSec: 1 }, outputSchema: null, ...extra },
});

/** start → probe → cond(output contains "SHIP") → yes: ship / no: hold → end (join). */
function branchy(): Workflow {
  return {
    nocturne: 1, id: "cond-wf", name: "Branchy", description: "", params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      agent("probe", "probe it"),
      { id: "cond", type: "condition", position: { x: 0, y: 0 }, data: { title: "If", left: "{{steps.probe.output}}", op: "contains", value: "SHIP" } },
      agent("ship", "ship it"),
      agent("hold", "hold it"),
      { id: "end", type: "end", position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "probe" },
      { id: "e2", source: "probe", target: "cond" },
      { id: "e3", source: "cond", target: "ship", branch: "true" },
      { id: "e4", source: "cond", target: "hold", branch: "false" },
      { id: "e5", source: "ship", target: "end" },
      { id: "e6", source: "hold", target: "end" },
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

describe("condition evaluation (pure)", () => {
  const ctx: TemplateContext = { params: { n: "5" }, steps: { a: { output: "All tests PASS" } }, workflow: { id: "w", name: "w", description: "" }, run: { projectRoot: "/" } };
  it("covers every operator", () => {
    expect(evalCondition({ title: "", left: "{{steps.a.output}}", op: "contains", value: "pass" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{steps.a.output}}", op: "not_contains", value: "FAIL" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{params.n}}", op: "equals", value: "5" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{params.n}}", op: "not_equals", value: "6" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{steps.a.output}}", op: "matches", value: "tests?\\s+pass" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{steps.a.output}}", op: "not_empty", value: "" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{params.n}}", op: "gt", value: "4" }, ctx)).toBe(true);
    expect(evalCondition({ title: "", left: "{{params.n}}", op: "lt", value: "4" }, ctx)).toBe(false);
  });
});

describe("condition validation", () => {
  it("requires exactly one true and one false edge", () => {
    const wf = branchy();
    wf.edges = wf.edges.filter((e) => e.id !== "e4"); // drop the false edge
    const v = validateWorkflow(wf);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === "bad-branches")).toBe(true);
  });
  it("rejects branch labels on non-condition edges and accepts the valid graph", () => {
    const good = validateWorkflow(branchy());
    expect(good.ok).toBe(true);
    const wf = branchy();
    wf.edges[0]!.branch = "true"; // start → probe mislabeled
    expect(validateWorkflow(wf).errors.some((e) => e.code === "bad-branches")).toBe(true);
  });
});

describe("condition execution", () => {
  it("takes the true branch and skips the false subtree (join still completes)", async () => {
    const { engine, projectRoot } = await harness({
      rules: [{ match: { contains: "probe" }, responses: [{ ok: "verdict: SHIP it", cost: 0.001 }] }],
      default: { ok: "OK", cost: 0.001 },
    });
    const run = await engine.startRun(branchy(), projectRoot, {});
    expect(run.status).toBe("completed");
    expect(run.steps["cond"]!.output).toBe("true");
    expect(run.steps["ship"]!.status).toBe("succeeded");
    expect(run.steps["hold"]!.status).toBe("skipped");
    expect(run.steps["end"]!.status).toBe("succeeded");
  });

  it("takes the false branch when the predicate misses", async () => {
    const { engine, projectRoot } = await harness({
      rules: [{ match: { contains: "probe" }, responses: [{ ok: "verdict: HOLD for review", cost: 0.001 }] }],
      default: { ok: "OK", cost: 0.001 },
    });
    const run = await engine.startRun(branchy(), projectRoot, {});
    expect(run.status).toBe("completed");
    expect(run.steps["cond"]!.output).toBe("false");
    expect(run.steps["ship"]!.status).toBe("skipped");
    expect(run.steps["hold"]!.status).toBe("succeeded");
  });

  it("skip cascades through a chain on the untaken branch", async () => {
    const wf = branchy();
    // extend the false branch: hold → hold2 → end
    wf.nodes.splice(5, 0, agent("hold2", "hold more"));
    wf.edges = wf.edges.filter((e) => e.id !== "e6");
    wf.edges.push({ id: "e6a", source: "hold", target: "hold2" }, { id: "e6b", source: "hold2", target: "end" });
    const { engine, projectRoot } = await harness({
      rules: [{ match: { contains: "probe" }, responses: [{ ok: "SHIP", cost: 0.001 }] }],
      default: { ok: "OK", cost: 0.001 },
    });
    const run = await engine.startRun(wf, projectRoot, {});
    expect(run.status).toBe("completed");
    expect(run.steps["hold"]!.status).toBe("skipped");
    expect(run.steps["hold2"]!.status).toBe("skipped");
    expect(run.steps["end"]!.status).toBe("succeeded");
  });
});

describe("repeat (run count)", () => {
  it("runs the step N times and joins the outputs, accumulating cost", async () => {
    const wf: Workflow = {
      nocturne: 1, id: "rep-wf", name: "Rep", description: "", params: [],
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 } },
        agent("r", "do the pass", { repeat: 3 }),
        { id: "end", type: "end", position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "start", target: "r" },
        { id: "e2", source: "r", target: "end" },
      ],
    };
    const { engine, projectRoot } = await harness({ default: { ok: "PASS-DONE", cost: 0.002 } });
    const run = await engine.startRun(wf, projectRoot, {});
    expect(run.status).toBe("completed");
    const out = run.steps["r"]!.output!;
    expect(out.split("PASS-DONE")).toHaveLength(4); // 3 occurrences
    expect(out).toContain("---");
    expect(run.steps["r"]!.costUsd).toBeCloseTo(0.006, 5);
    expect(run.totalCostUsd).toBeCloseTo(0.006, 5);
  });
});
