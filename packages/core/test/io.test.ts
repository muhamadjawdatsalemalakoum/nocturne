import { describe, it, expect } from "vitest";
import { exportWorkflow, importWorkflow, newWorkflow, summarizeImport } from "../src/index.js";
import { linearWorkflow } from "./fixtures.js";

describe("io", () => {
  it("newWorkflow produces a valid start/end skeleton", () => {
    const wf = newWorkflow("Hello");
    expect(wf.name).toBe("Hello");
    expect(wf.nodes.some((n) => n.type === "start")).toBe(true);
    expect(wf.nodes.some((n) => n.type === "end")).toBe(true);
    // round-trips through export without throwing
    expect(() => exportWorkflow(wf)).not.toThrow();
  });

  it("export -> import round-trips to an equivalent object", () => {
    const wf = linearWorkflow();
    const text = exportWorkflow(wf);
    const back = importWorkflow(text);
    expect(back.workflow.id).toBe(wf.id);
    expect(back.workflow.nodes).toHaveLength(wf.nodes.length);
    // re-export is byte-stable
    expect(exportWorkflow(back.workflow)).toBe(text);
  });

  it("export refuses an invalid workflow", () => {
    const wf = linearWorkflow();
    wf.edges.push({ id: "cyc", source: "b", target: "a" });
    expect(() => exportWorkflow(wf)).toThrow(/Invalid workflow/);
  });

  it("import rejects malformed JSON", () => {
    expect(() => importWorkflow("{not json")).toThrow(/Not valid JSON/);
  });

  it("import rejects a future format version", () => {
    const wf = linearWorkflow();
    (wf as { nocturne: number }).nocturne = 99;
    expect(() => importWorkflow(JSON.stringify(wf))).toThrow(/Invalid workflow/);
  });

  it("summarizeImport lists agent steps, tools and models", () => {
    const s = summarizeImport(linearWorkflow());
    expect(s.nodeCount).toBe(4);
    expect(s.agentSteps).toHaveLength(2);
    expect(s.agentSteps[1]!.allowedTools).toContain("Edit");
    expect(s.agentSteps[0]!.model).toBe("haiku");
    expect(s.params).toContain("ticket");
  });
});
