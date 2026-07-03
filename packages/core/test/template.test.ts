import { describe, it, expect } from "vitest";
import { renderTemplate, extractRefs, TemplateError, type TemplateContext } from "../src/index.js";

const ctx: TemplateContext = {
  params: { ticket: "ABC-123" },
  steps: { a: { output: "analysis text" } },
  workflow: { id: "w1", name: "My Flow", description: "desc" },
  run: { projectRoot: "/home/x/proj" },
};

describe("template", () => {
  it("extracts references", () => {
    const refs = extractRefs("x {{params.ticket}} y {{ steps.a.output }}");
    expect(refs.map((r) => r.raw)).toEqual(["params.ticket", "steps.a.output"]);
  });

  it("renders params, steps, workflow and run refs", () => {
    expect(renderTemplate("Fix {{params.ticket}}", ctx)).toBe("Fix ABC-123");
    expect(renderTemplate("Given {{steps.a.output}}", ctx)).toBe("Given analysis text");
    expect(renderTemplate("Flow {{workflow.name}}", ctx)).toBe("Flow My Flow");
    expect(renderTemplate("Root {{run.projectRoot}}", ctx)).toBe("Root /home/x/proj");
  });

  it("tolerates whitespace inside braces", () => {
    expect(renderTemplate("{{   params.ticket   }}", ctx)).toBe("ABC-123");
  });

  it("throws on unknown param", () => {
    expect(() => renderTemplate("{{params.nope}}", ctx)).toThrow(TemplateError);
  });

  it("throws on unknown step", () => {
    expect(() => renderTemplate("{{steps.zzz.output}}", ctx)).toThrow(TemplateError);
  });

  it("throws on malformed step ref", () => {
    expect(() => renderTemplate("{{steps.a}}", ctx)).toThrow(TemplateError);
    expect(() => renderTemplate("{{steps.a.result}}", ctx)).toThrow(TemplateError);
  });

  it("throws on unknown root", () => {
    expect(() => renderTemplate("{{bogus.x}}", ctx)).toThrow(TemplateError);
  });

  it("leaves text without refs untouched", () => {
    expect(renderTemplate("plain text", ctx)).toBe("plain text");
  });
});
