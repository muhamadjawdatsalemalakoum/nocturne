import { describe, it, expect } from "vitest";
import { workflowSchema, agentNodeDataSchema, modelSchema } from "../src/index.js";
import { linearWorkflow } from "./fixtures.js";

describe("schema", () => {
  it("accepts a valid workflow", () => {
    const r = workflowSchema.safeParse(linearWorkflow());
    expect(r.success).toBe(true);
  });

  it("applies agent-node defaults", () => {
    const d = agentNodeDataSchema.parse({ title: "t", prompt: "p" });
    expect(d.model).toBe("inherit");
    expect(d.permissionMode).toBe("dontAsk");
    expect(d.cwd).toBe("");
    expect(d.retry).toEqual({ max: 1, backoffSec: 60 });
    expect(d.continueFrom).toBeNull();
  });

  it("accepts model aliases and explicit ids, rejects junk", () => {
    for (const ok of ["inherit", "haiku", "sonnet", "opus", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(modelSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["gpt-4", "gemini", "", "sonnet-ish"]) {
      expect(modelSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an empty node list", () => {
    const wf = linearWorkflow();
    (wf as unknown as { nodes: unknown[] }).nodes = [];
    expect(workflowSchema.safeParse(wf).success).toBe(false);
  });

  it("rejects an unknown node type via discriminated union", () => {
    const wf = linearWorkflow();
    (wf.nodes as unknown[]).push({ id: "x", type: "loop", position: { x: 0, y: 0 } });
    expect(workflowSchema.safeParse(wf).success).toBe(false);
  });

  it("validates wait node modes", () => {
    const good = [
      { mode: "duration", minutes: 60 },
      { mode: "until", time: "02:30" },
      { mode: "limitReset" },
    ];
    for (const data of good) {
      const wf = linearWorkflow();
      (wf.nodes as unknown[]).push({ id: "w", type: "wait", position: { x: 0, y: 0 }, data });
      expect(workflowSchema.safeParse(wf).success).toBe(true);
    }
    const badTime = linearWorkflow();
    (badTime.nodes as unknown[]).push({ id: "w", type: "wait", position: { x: 0, y: 0 }, data: { mode: "until", time: "25:00" } });
    expect(workflowSchema.safeParse(badTime).success).toBe(false);
  });

  it("rejects an invalid param identifier", () => {
    const wf = linearWorkflow();
    wf.params = [{ name: "has-dash", description: "", default: "" }];
    expect(workflowSchema.safeParse(wf).success).toBe(false);
  });
});
