import { describe, it, expect } from "vitest";
import { validateWorkflow, isAbsolutePathLike } from "../src/index.js";
import { linearWorkflow, diamondWorkflow } from "./fixtures.js";

describe("validate", () => {
  it("passes valid linear and diamond workflows", () => {
    expect(validateWorkflow(linearWorkflow()).ok).toBe(true);
    expect(validateWorkflow(diamondWorkflow()).ok).toBe(true);
  });

  it("flags absolute cwd paths", () => {
    expect(isAbsolutePathLike("C:\\Users\\x")).toBe(true);
    expect(isAbsolutePathLike("/etc/passwd")).toBe(true);
    expect(isAbsolutePathLike("\\\\server\\share")).toBe(true);
    expect(isAbsolutePathLike("src/sub")).toBe(false);
    expect(isAbsolutePathLike("")).toBe(false);

    const wf = linearWorkflow();
    (wf.nodes[2] as { data: { cwd: string } }).data.cwd = "C:\\evil";
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "abs-path")).toBe(true);
  });

  it("errors on more than one start node", () => {
    const wf = linearWorkflow();
    (wf.nodes as unknown[]).push({ id: "start2", type: "start", position: { x: 0, y: 0 } });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "start")).toBe(true);
  });

  it("errors on a cycle", () => {
    const wf = linearWorkflow();
    wf.edges.push({ id: "cyc", source: "b", target: "a" });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "cycle")).toBe(true);
  });

  it("errors when a step references a non-upstream output", () => {
    const wf = linearWorkflow();
    // make 'a' reference 'b', which is downstream of it
    (wf.nodes[1] as { data: { prompt: string } }).data.prompt = "use {{steps.b.output}}";
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "bad-ref")).toBe(true);
  });

  it("errors on an unknown param reference", () => {
    const wf = linearWorkflow();
    (wf.nodes[1] as { data: { prompt: string } }).data.prompt = "use {{params.nope}}";
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "bad-ref")).toBe(true);
  });

  it("warns on embedded secrets but does not fail", () => {
    const wf = linearWorkflow();
    (wf.nodes[1] as { data: { prompt: string } }).data.prompt =
      "here is a key sk-ant-abcdefghijklmnop do the thing";
    const r = validateWorkflow(wf);
    expect(r.warnings.some((w) => w.code === "secret")).toBe(true);
  });

  it("warns on a secret hidden in a param default (not just prompts)", () => {
    const wf = linearWorkflow();
    wf.params = [...wf.params, { name: "key", description: "", default: "sk-ant-abcdefghijklmnop" }];
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(true); // still a warning, not an error
    expect(r.warnings.some((w) => w.code === "secret")).toBe(true);
  });

  it("errors when continueFrom is not upstream", () => {
    const wf = linearWorkflow();
    (wf.nodes[1] as { data: { continueFrom: string } }).data.continueFrom = "b";
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "bad-continue")).toBe(true);
  });

  it("errors on dangling edges", () => {
    const wf = linearWorkflow();
    wf.edges.push({ id: "bad", source: "ghost", target: "a" });
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "dangling-edge")).toBe(true);
  });

  // regression: ancestor computation must not depend on node/edge declaration order
  it("accepts an upstream ref regardless of node/edge declaration order", () => {
    const mkAgent = (id: string, prompt: string) => ({
      id,
      type: "agent" as const,
      position: { x: 0, y: 0 },
      data: { title: id, prompt, model: "haiku" as const, cwd: "", allowedTools: [], permissionMode: "dontAsk" as const, continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null },
    });
    const wf = {
      nocturne: 1,
      id: "order",
      name: "Order",
      description: "",
      params: [],
      // nodes listed with `top` before its predecessors, edges with g->top before p->top
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 } },
        mkAgent("top", "top {{steps.p.output}}"),
        mkAgent("p", "use {{steps.g.output}}"),
        mkAgent("g", "g"),
        { id: "end", type: "end", position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "start", target: "g" },
        { id: "e2", source: "g", target: "p" },
        { id: "e3", source: "g", target: "top" },
        { id: "e4", source: "p", target: "top" },
        { id: "e5", source: "top", target: "end" },
      ],
    };
    const r = validateWorkflow(wf);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // regression: validation must reject template refs the renderer would throw on
  it("rejects over-dotted template refs that render would reject", () => {
    for (const bad of ["{{run.projectRoot.x}}", "{{params.ticket.x}}", "{{workflow.name.x}}"]) {
      const wf = linearWorkflow();
      (wf.nodes[1] as { data: { prompt: string } }).data.prompt = bad;
      const r = validateWorkflow(wf);
      expect(r.ok, `should reject ${bad}`).toBe(false);
      expect(r.errors.some((e) => e.code === "bad-ref")).toBe(true);
    }
  });

  it("rejects continueFrom pointing at a non-agent node", () => {
    // start -> a -> w(wait) -> b -> end ; b.continueFrom = w should error
    const wf = linearWorkflow();
    (wf.nodes as unknown[]).splice(2, 0, { id: "w", type: "wait", position: { x: 0, y: 0 }, data: { mode: "limitReset" } });
    wf.edges = [
      { id: "e1", source: "start", target: "a" },
      { id: "e2", source: "a", target: "w" },
      { id: "e3", source: "w", target: "b" },
      { id: "e4", source: "b", target: "end" },
    ];
    (wf.nodes.find((n) => n.id === "b") as { data: { continueFrom: string } }).data.continueFrom = "w";
    const r = validateWorkflow(wf);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "bad-continue")).toBe(true);
  });
});
