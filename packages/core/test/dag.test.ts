import { describe, it, expect } from "vitest";
import { topoSort, findCycle, unreachableNodes, buildDag } from "../src/index.js";
import { linearWorkflow, diamondWorkflow } from "./fixtures.js";

describe("dag", () => {
  it("topo-sorts a linear graph in order", () => {
    const order = topoSort(linearWorkflow());
    expect(order).toEqual(["start", "a", "b", "end"]);
  });

  it("topo-sorts a diamond with join after both branches", () => {
    const order = topoSort(diamondWorkflow());
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("b"));
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("c"));
    expect(order.indexOf("end")).toBe(order.length - 1);
  });

  it("detects join nodes have two predecessors", () => {
    const { predecessors } = buildDag(diamondWorkflow());
    expect(predecessors.get("d")).toEqual(expect.arrayContaining(["b", "c"]));
    expect(predecessors.get("d")).toHaveLength(2);
  });

  it("finds no cycle in a DAG", () => {
    expect(findCycle(linearWorkflow())).toEqual([]);
    expect(findCycle(diamondWorkflow())).toEqual([]);
  });

  it("finds a cycle when one is introduced", () => {
    const wf = linearWorkflow();
    wf.edges.push({ id: "cyc", source: "b", target: "a" });
    const cyc = findCycle(wf);
    expect(cyc.length).toBeGreaterThan(0);
    expect(cyc).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("throws when topo-sorting a cyclic graph", () => {
    const wf = linearWorkflow();
    wf.edges.push({ id: "cyc", source: "b", target: "a" });
    expect(() => topoSort(wf)).toThrow();
  });

  it("reports unreachable nodes", () => {
    const wf = linearWorkflow();
    (wf.nodes as unknown[]).push({
      id: "orphan",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { title: "o", prompt: "p", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null },
    });
    expect(unreachableNodes(wf)).toContain("orphan");
    expect(unreachableNodes(wf)).not.toContain("a");
  });
});
