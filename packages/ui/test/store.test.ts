import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/store";
import { newWorkflow } from "@nocturne/core";
import type { RunState } from "../src/types";

const s = () => useStore.getState();
beforeEach(() => s().loadWorkflow(newWorkflow("T")));

function runState(): RunState {
  return {
    runId: "r1",
    workflowId: "w",
    workflowName: "T",
    status: "running",
    projectRoot: "/x",
    params: {},
    steps: { a: { nodeId: "a", type: "agent", status: "running", attempts: 0 } },
    totalCostUsd: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as RunState;
}

describe("ui store", () => {
  it("loadWorkflow populates the graph and resets run/selection", () => {
    expect(s().nodes.length).toBe(2); // start + end
    expect(s().edges.length).toBe(1);
    expect(s().meta.name).toBe("T");
    expect(s().run).toBeNull();
    expect(s().selectedId).toBeNull();
  });

  it("addNode appends a node, selects it, and currentWorkflow reflects it", () => {
    s().addNode("agent", { x: 200, y: 0 });
    expect(s().nodes.some((n) => n.type === "agent")).toBe(true);
    expect(s().selectedId).toBeTruthy();
    expect(s().currentWorkflow().nodes.length).toBe(3);
  });

  it("updateNodeData patches only the target node", () => {
    s().addNode("agent", { x: 0, y: 0 });
    const id = s().selectedId!;
    s().updateNodeData(id, { title: "Renamed", model: "haiku" });
    const n = s().nodes.find((x) => x.id === id)!;
    expect((n.data as { title: string }).title).toBe("Renamed");
    expect((n.data as { model: string }).model).toBe("haiku");
    // sibling untouched
    expect(s().nodes.find((x) => x.id === "start")!.data).toEqual({});
  });

  it("deleteSelected removes the node and every edge touching it", () => {
    s().addNode("agent", { x: 0, y: 0 });
    const id = s().selectedId!;
    s().onConnect({ source: "start", target: id, sourceHandle: null, targetHandle: null });
    expect(s().edges.some((e) => e.target === id)).toBe(true);
    s().select(id);
    s().deleteSelected();
    expect(s().nodes.some((n) => n.id === id)).toBe(false);
    expect(s().edges.some((e) => e.source === id || e.target === id)).toBe(false);
  });

  it("duplicateSelected clones data but refuses start/end", () => {
    s().addNode("agent", { x: 0, y: 0 });
    const id = s().selectedId!;
    s().updateNodeData(id, { title: "Orig" });
    s().select(id);
    s().duplicateSelected();
    const dup = s().selectedId!;
    expect(dup).not.toBe(id);
    expect((s().nodes.find((n) => n.id === dup)!.data as { title: string }).title).toBe("Orig");
    // start cannot be duplicated
    const before = s().nodes.length;
    s().select("start");
    s().duplicateSelected();
    expect(s().nodes.length).toBe(before);
  });

  it("applyEvent updates run/step state and ignores foreign runIds", () => {
    s().setRun(runState());
    s().applyEvent({ type: "step.status", runId: "r1", nodeId: "a", status: "succeeded", at: 1 });
    expect(s().run!.steps.a!.status).toBe("succeeded");
    s().applyEvent({ type: "step.output", runId: "r1", nodeId: "a", output: "OUT", costUsd: 0.01, at: 2 });
    expect(s().run!.steps.a!.output).toBe("OUT");
    expect(s().run!.totalCostUsd).toBeCloseTo(0.01);
    s().applyEvent({ type: "run.status", runId: "OTHER", status: "failed", at: 3 });
    expect(s().run!.status).not.toBe("failed");
  });

  it("refuses to delete the structural start/end nodes", () => {
    const before = s().nodes.length;
    s().select("start");
    s().deleteSelected();
    s().select("end");
    s().deleteSelected();
    expect(s().nodes.length).toBe(before);
    expect(s().nodes.some((n) => n.type === "start")).toBe(true);
  });

  it("applyEvent accumulates activity and bounds it to the cap", () => {
    s().setRun(runState());
    for (let i = 0; i < 70; i++) s().applyEvent({ type: "step.activity", runId: "r1", nodeId: "a", kind: "text", text: `t${i}`, at: i });
    expect(s().activity.a!.length).toBe(60);
    expect(s().activity.a!.at(-1)!.text).toBe("t69");
  });
});
