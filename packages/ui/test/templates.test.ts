import { describe, it, expect } from "vitest";
import { TEMPLATES, PROMPT_PRESETS, TOOL_PRESETS, TOOL_CHIPS, WAIT_DURATIONS } from "../src/templates";
import { validateWorkflow } from "@nocturne/core";

describe("templates", () => {
  it("every template builds a schema-valid workflow", () => {
    for (const t of TEMPLATES) {
      const r = validateWorkflow(t.build());
      expect(r.ok, `${t.name}: ${r.errors.map((e) => e.message).join("; ")}`).toBe(true);
    }
  });

  it("template ids are unique and each build mints a fresh workflow id", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const t = TEMPLATES[0]!;
    expect(t.build().id).not.toBe(t.build().id);
  });

  it("the overnight template actually hands off output between steps", () => {
    const wf = TEMPLATES.find((t) => t.id === "overnight-refactor")!.build();
    const usesHandoff = wf.nodes.some((n) => n.type === "agent" && /\{\{steps\.[\w-]+\.output\}\}/.test((n as { data: { prompt: string } }).data.prompt));
    expect(usesHandoff).toBe(true);
  });

  it("the rate-limit template contains a limitReset wait node", () => {
    const wf = TEMPLATES.find((t) => t.id === "rate-limit-safe")!.build();
    expect(wf.nodes.some((n) => n.type === "wait" && (n as { data: { mode: string } }).data.mode === "limitReset")).toBe(true);
  });

  it("presets are populated and tool-preset entries are real tool names", () => {
    expect(PROMPT_PRESETS.length).toBeGreaterThan(3);
    expect(WAIT_DURATIONS.length).toBeGreaterThan(2);
    expect(TOOL_CHIPS).toContain("Read");
    for (const p of TOOL_PRESETS) {
      expect(p.tools.length).toBeGreaterThan(0);
      for (const tool of p.tools) expect(TOOL_CHIPS).toContain(tool);
    }
  });
});
