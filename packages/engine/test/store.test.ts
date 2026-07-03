import { describe, it, expect, afterEach } from "vitest";
import { RunStore, atomicWrite } from "../src/index.js";
import type { RunState } from "../src/index.js";
import { tempHome } from "./helpers.js";
import { promises as fs } from "node:fs";
import path from "node:path";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeState(runId: string): RunState {
  return {
    runId,
    workflowId: "w",
    workflowName: "W",
    workflow: { nocturne: 1, id: "w", name: "W", description: "", params: [], nodes: [{ id: "start", type: "start", position: { x: 0, y: 0 } }], edges: [] },
    projectRoot: "/x",
    params: {},
    status: "queued",
    steps: {},
    totalCostUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("RunStore", () => {
  it("create/load round-trips and load-missing returns null", async () => {
    const { home, cleanup } = await tempHome();
    cleanups.push(cleanup);
    const store = new RunStore(home);
    await store.init();
    await store.create(fakeState("r1"));
    const back = await store.load("r1");
    expect(back?.runId).toBe("r1");
    expect(await store.load("nope")).toBeNull();
  });

  it("lists runs newest-first", async () => {
    const { home, cleanup } = await tempHome();
    cleanups.push(cleanup);
    const store = new RunStore(home);
    await store.init();
    const a = fakeState("a");
    a.createdAt = 100;
    const b = fakeState("b");
    b.createdAt = 200;
    await store.create(a);
    await store.create(b);
    const list = await store.list();
    expect(list.map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("appends and reads events", async () => {
    const { home, cleanup } = await tempHome();
    cleanups.push(cleanup);
    const store = new RunStore(home);
    await store.init();
    await store.create(fakeState("r"));
    await store.appendEvent({ type: "run.log", runId: "r", message: "hi", at: 1 });
    await store.appendEvent({ type: "run.log", runId: "r", message: "bye", at: 2 });
    const evs = await store.readEvents("r");
    // create() also writes a run.created event
    expect(evs.length).toBeGreaterThanOrEqual(3);
    expect(evs.some((e) => e.type === "run.log" && e.message === "bye")).toBe(true);
  });

  it("atomicWrite replaces existing content", async () => {
    const { home, cleanup } = await tempHome();
    cleanups.push(cleanup);
    const f = path.join(home, "x.json");
    await atomicWrite(f, "one");
    await atomicWrite(f, "two");
    expect(await fs.readFile(f, "utf8")).toBe("two");
    // no leftover temp files
    const entries = await fs.readdir(home);
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
  });
});
