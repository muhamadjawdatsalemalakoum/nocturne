import { describe, it, expect } from "vitest";
import { defaultData, toRf, toWorkflow, freshId } from "../src/wf";
import { validateWorkflow, type Workflow } from "@nocturne/core";

const wf: Workflow = {
  nocturne: 1,
  id: "w1",
  name: "W",
  description: "d",
  params: [{ name: "t", description: "", default: "" }],
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "a",
      type: "agent",
      position: { x: 200, y: 0 },
      data: { title: "A", prompt: "p {{params.t}}", model: "haiku", cwd: "", allowedTools: ["Edit"], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null },
    },
    { id: "end", type: "end", position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "start", target: "a" },
    { id: "e2", source: "a", target: "end" },
  ],
};

describe("wf conversions", () => {
  it("defaultData gives sensible payloads per kind", () => {
    expect(defaultData("agent").model).toBe("inherit");
    expect(defaultData("agent").permissionMode).toBe("dontAsk");
    expect(defaultData("wait").mode).toBe("limitReset");
    expect(defaultData("approval").message).toBeTruthy();
    expect(defaultData("end")).toEqual({});
  });

  it("toRf → toWorkflow round-trips to a valid, equivalent workflow", () => {
    const { nodes, edges, meta } = toRf(wf);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
    const back = toWorkflow(meta, nodes, edges);
    expect(validateWorkflow(back).ok).toBe(true);
    expect(back.id).toBe("w1");
    expect(back.nodes.map((n) => n.id)).toEqual(["start", "a", "end"]);
    // start/end carry no data
    const start = back.nodes.find((n) => n.id === "start")!;
    expect("data" in start).toBe(false);
    // agent data preserved
    const a = back.nodes.find((n) => n.id === "a") as Extract<Workflow["nodes"][number], { type: "agent" }>;
    expect(a.data.allowedTools).toEqual(["Edit"]);
  });

  it("toWorkflow rounds fractional canvas positions to integers", () => {
    const { nodes, edges, meta } = toRf(wf);
    nodes[1]!.position = { x: 12.7, y: -3.2 };
    const back = toWorkflow(meta, nodes, edges);
    expect(back.nodes.find((n) => n.id === "a")!.position).toEqual({ x: 13, y: -3 });
  });

  it("freshId is unique and kind-prefixed", () => {
    const a = freshId("agent");
    const b = freshId("agent");
    expect(a).not.toBe(b);
    expect(a.startsWith("agent-")).toBe(true);
  });
});
