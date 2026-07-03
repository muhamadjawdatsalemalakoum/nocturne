import { FORMAT_VERSION, workflowSchema, type Workflow } from "./schema.js";
import { validateWorkflow, type ValidationResult } from "./validate.js";

export function newId(): string {
  // Available in Node 19+ and browsers in secure contexts (localhost qualifies).
  return crypto.randomUUID();
}

/** A fresh, valid workflow with a start and an end node wired together. */
export function newWorkflow(name = "Untitled workflow"): Workflow {
  return {
    nocturne: FORMAT_VERSION,
    id: newId(),
    name,
    description: "",
    params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 120 } },
      { id: "end", type: "end", position: { x: 640, y: 120 } },
    ],
    edges: [{ id: "e-start-end", source: "start", target: "end" }],
  };
}

/**
 * Serialize a workflow to the canonical, pretty-printed `.nocturne.json` string.
 * Normalizes the format version and applies schema defaults so the output is stable.
 * Throws if the workflow does not pass validation.
 */
export function exportWorkflow(wf: unknown): string {
  const normalized = normalizeOrThrow(wf);
  return JSON.stringify(normalized, null, 2) + "\n";
}

export interface ImportOutcome {
  workflow: Workflow;
  validation: ValidationResult;
  summary: ImportSummary;
}

export interface ImportSummary {
  name: string;
  description: string;
  nodeCount: number;
  agentSteps: Array<{
    id: string;
    title: string;
    model: string;
    permissionMode: string;
    allowedTools: string[];
    cwd: string;
  }>;
  waits: number;
  approvals: number;
  params: string[];
}

/**
 * Parse and validate an incoming `.nocturne.json` string.
 * Throws on malformed JSON or validation errors; returns warnings inside `validation`.
 */
export function importWorkflow(text: string): ImportOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  const validation = validateWorkflow(raw);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`Invalid workflow: ${first ? first.message : "unknown error"}`);
  }
  const workflow = workflowSchema.parse(raw);
  return { workflow, validation, summary: summarizeImport(workflow) };
}

export function summarizeImport(wf: Workflow): ImportSummary {
  const agentSteps = wf.nodes
    .filter((n) => n.type === "agent")
    .map((n) => {
      const d = (n as Extract<Workflow["nodes"][number], { type: "agent" }>).data;
      return {
        id: n.id,
        title: d.title,
        model: d.model,
        permissionMode: d.permissionMode,
        allowedTools: d.allowedTools,
        cwd: d.cwd,
      };
    });
  return {
    name: wf.name,
    description: wf.description,
    nodeCount: wf.nodes.length,
    agentSteps,
    waits: wf.nodes.filter((n) => n.type === "wait").length,
    approvals: wf.nodes.filter((n) => n.type === "approval").length,
    params: wf.params.map((p) => p.name),
  };
}

/** Validate + apply schema defaults, or throw with the first error. */
export function normalizeOrThrow(wf: unknown): Workflow {
  const validation = validateWorkflow(wf);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`Invalid workflow: ${first ? first.message : "unknown error"}`);
  }
  const parsed = workflowSchema.parse(wf);
  parsed.nocturne = FORMAT_VERSION;
  return parsed;
}
