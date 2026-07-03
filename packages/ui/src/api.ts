import type { Workflow, RunState, WorkflowSummary, RunEvent } from "./types";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => j<{ ok: boolean; version: string }>(r)),

  newWorkflow: (name?: string) =>
    fetch(`/api/workflows/new${name ? `?name=${encodeURIComponent(name)}` : ""}`).then((r) => j<Workflow>(r)),

  listWorkflows: () => fetch("/api/workflows").then((r) => j<WorkflowSummary[]>(r)),
  getWorkflow: (id: string) => fetch(`/api/workflows/${id}`).then((r) => j<Workflow>(r)),
  saveWorkflow: (wf: Workflow) =>
    fetch("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wf),
    }).then((r) => j<Workflow>(r)),
  deleteWorkflow: (id: string) =>
    fetch(`/api/workflows/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: boolean }>(r)),

  importWorkflow: (text: string) =>
    fetch("/api/workflows/import", { method: "POST", headers: { "content-type": "application/json" }, body: text }).then(
      (r) => j<{ workflow: Workflow; summary: ImportSummary; validation: ValidationResult }>(r),
    ),

  startRun: (body: { workflow?: Workflow; workflowId?: string; projectRoot: string; params?: Record<string, string> }) =>
    fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      (r) => j<RunState>(r),
    ),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => j<RunState>(r)),
  listRuns: () => fetch("/api/runs").then((r) => j<RunState[]>(r)),
  pauseRun: (id: string) => fetch(`/api/runs/${id}/pause`, { method: "POST" }).then((r) => j<RunState>(r)),
  resumeRun: (id: string) => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then((r) => j<RunState>(r)),
  cancelRun: (id: string) => fetch(`/api/runs/${id}/cancel`, { method: "POST" }).then((r) => j<RunState>(r)),
  approve: (id: string, nodeId: string, approved: boolean, note = "") =>
    fetch(`/api/runs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, approved, note }),
    }).then((r) => j<RunState>(r)),

  suggest: (body: { hours?: number; max?: number; projectRoot?: string } = {}) =>
    fetch("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<SuggestResult>(r)),
};

export interface SuggestionItem {
  workflow: Workflow;
  rationale: string;
  sourceSessions: string[];
}
export interface SuggestResult {
  suggestions: SuggestionItem[];
  sessionsScanned: number;
  windowHours: number;
  cost: number;
  note?: string;
}

export interface ImportSummary {
  name: string;
  description: string;
  nodeCount: number;
  agentSteps: Array<{ id: string; title: string; model: string; permissionMode: string; allowedTools: string[]; cwd: string }>;
  waits: number;
  approvals: number;
  params: string[];
}
export interface ValidationResult {
  ok: boolean;
  errors: Array<{ code: string; message: string; nodeId?: string }>;
  warnings: Array<{ code: string; message: string; nodeId?: string }>;
}

/** Connect to the daemon's live event stream; returns a disconnect fn. */
export function connectEvents(onEvent: (ev: RunEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data) as RunEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(open, 1000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
