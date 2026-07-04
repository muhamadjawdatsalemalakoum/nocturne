import { describe, it, expect } from "vitest";
import { STEP_LIBRARY, STEP_CATEGORIES, searchSteps } from "../src/steps";

describe("steps library", () => {
  it("every step is well-formed: unique id, known category, real prompt with a definition of done", () => {
    const ids = new Set<string>();
    for (const s of STEP_LIBRARY) {
      expect(ids.has(s.id), `dup id ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(STEP_CATEGORIES).toContain(s.category);
      expect(s.title.length).toBeGreaterThan(4);
      expect(s.prompt.length).toBeGreaterThan(120);
      expect(s.prompt).toMatch(/Done when:/);
      expect(s.keywords.length).toBeGreaterThan(1);
      if (s.tools) expect(s.tools.length).toBeGreaterThan(0);
    }
    // breadth: every category is populated — this library is for everyone
    for (const c of STEP_CATEGORIES) {
      expect(STEP_LIBRARY.some((s) => s.category === c), `empty category ${c}`).toBe(true);
    }
  });

  it("search matches across title, standard, and keywords; category filters", () => {
    expect(searchSteps("dry").some((s) => s.id === "code-dry")).toBe(true);
    expect(searchSteps("pivot").some((s) => s.id === "data-pivot")).toBe(true);
    expect(searchSteps("5 whys").some((s) => s.id === "ops-postmortem")).toBe(true);
    expect(searchSteps("bluf").some((s) => s.id === "docs-exec-summary")).toBe(true);
    expect(searchSteps("", "Writing").every((s) => s.category === "Writing")).toBe(true);
    expect(searchSteps("dry", "Writing")).toHaveLength(0);
    expect(searchSteps("")).toHaveLength(STEP_LIBRARY.length);
  });
});
