/**
 * Minimal, safe template engine for step prompts.
 * Supports {{ path.with.dots }} references against a fixed set of roots:
 *   params.<name>           run-time parameter value
 *   steps.<nodeId>.output   an upstream step's text output
 *   workflow.name|description|id
 *   run.projectRoot
 *
 * No arbitrary code execution, no logic — substitution only.
 */

export interface TemplateRef {
  /** the raw inner expression, trimmed, e.g. "steps.n1.output" */
  raw: string;
  root: string;
  parts: string[];
}

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function extractRefs(template: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of template.matchAll(REF_RE)) {
    const raw = m[1]!.trim();
    const parts = raw.split(".").map((p) => p.trim());
    refs.push({ raw, root: parts[0] ?? "", parts });
  }
  return refs;
}

export interface TemplateContext {
  params: Record<string, string>;
  steps: Record<string, { output: string }>;
  workflow: { id: string; name: string; description: string };
  run: { projectRoot: string };
}

export class TemplateError extends Error {}

/** Resolve a single reference against a context, or throw TemplateError. */
export function resolveRef(ref: TemplateRef, ctx: TemplateContext): string {
  const { parts, raw } = ref;
  switch (parts[0]) {
    case "params": {
      const name = parts[1];
      if (!name || parts.length !== 2) throw new TemplateError(`Bad param reference: {{${raw}}}`);
      if (!(name in ctx.params)) throw new TemplateError(`Unknown param: {{${raw}}}`);
      return ctx.params[name] ?? "";
    }
    case "steps": {
      const nodeId = parts[1];
      if (!nodeId || parts[2] !== "output" || parts.length !== 3) {
        throw new TemplateError(`Bad step reference: {{${raw}}} (use steps.<id>.output)`);
      }
      const step = ctx.steps[nodeId];
      if (!step) throw new TemplateError(`Unknown step output: {{${raw}}}`);
      return step.output;
    }
    case "workflow": {
      const key = parts[1];
      if (key === "name") return ctx.workflow.name;
      if (key === "description") return ctx.workflow.description;
      if (key === "id") return ctx.workflow.id;
      throw new TemplateError(`Unknown workflow field: {{${raw}}}`);
    }
    case "run": {
      if (parts[1] === "projectRoot" && parts.length === 2) return ctx.run.projectRoot;
      throw new TemplateError(`Unknown run field: {{${raw}}}`);
    }
    default:
      throw new TemplateError(`Unknown reference root: {{${raw}}}`);
  }
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(REF_RE, (_full, expr: string) => {
    const raw = expr.trim();
    const parts = raw.split(".").map((p) => p.trim());
    return resolveRef({ raw, root: parts[0] ?? "", parts }, ctx);
  });
}
