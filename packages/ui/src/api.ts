import type { Workflow, RunState, WorkflowSummary, RunEvent } from "./types";
import { initRemote, remoteActive, remoteFetch, remoteEvents } from "./remote";

/**
 * Nocturne Anywhere: when the page carries (or remembers) an internet pairing
 * payload, every request and the event stream reroute through the E2E-encrypted
 * tunnel instead of hitting a local daemon. Decided once, at load.
 */
const REMOTE = initRemote();

/**
 * LAN pairing token. A phone opens the QR URL (…/?token=xyz) once; we stash the
 * token, strip it from the address bar, and attach it to every request + the WS.
 * On localhost the daemon ignores it entirely.
 */
const TOKEN_KEY = "nocturne.pairToken";
export function pairToken(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked (private mode) — localhost works tokenless anyway
  }
}
(() => {
  try {
    const url = new URL(location.href);
    const t = url.searchParams.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      url.searchParams.delete("token");
      history.replaceState(null, "", url.toString());
    }
  } catch { /* non-browser context */ }
})();

const _fetch: typeof fetch = (input, init = {}) => {
  if (REMOTE && remoteActive()) return remoteFetch(input, init);
  const t = pairToken();
  if (!t) return fetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${t}`);
  return fetch(input, { ...init, headers });
};

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
  health: () => _fetch("/api/health").then((r) => j<{ ok: boolean; version: string }>(r)),

  newWorkflow: (name?: string) =>
    _fetch(`/api/workflows/new${name ? `?name=${encodeURIComponent(name)}` : ""}`).then((r) => j<Workflow>(r)),

  listWorkflows: () => _fetch("/api/workflows").then((r) => j<WorkflowSummary[]>(r)),
  getWorkflow: (id: string) => _fetch(`/api/workflows/${id}`).then((r) => j<Workflow>(r)),
  saveWorkflow: (wf: Workflow) =>
    _fetch("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wf),
    }).then((r) => j<Workflow>(r)),
  deleteWorkflow: (id: string) =>
    _fetch(`/api/workflows/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: boolean }>(r)),

  importWorkflow: (text: string) =>
    _fetch("/api/workflows/import", { method: "POST", headers: { "content-type": "application/json" }, body: text }).then(
      (r) => j<{ workflow: Workflow; summary: ImportSummary; validation: ValidationResult }>(r),
    ),

  startRun: (body: { workflow?: Workflow; workflowId?: string; projectRoot: string; params?: Record<string, string> }) =>
    _fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      (r) => j<RunState>(r),
    ),
  getRun: (id: string) => _fetch(`/api/runs/${id}`).then((r) => j<RunState>(r)),
  listRuns: () => _fetch("/api/runs").then((r) => j<RunState[]>(r)),
  pauseRun: (id: string) => _fetch(`/api/runs/${id}/pause`, { method: "POST" }).then((r) => j<RunState>(r)),
  resumeRun: (id: string) => _fetch(`/api/runs/${id}/resume`, { method: "POST" }).then((r) => j<RunState>(r)),
  cancelRun: (id: string) => _fetch(`/api/runs/${id}/cancel`, { method: "POST" }).then((r) => j<RunState>(r)),
  approve: (id: string, nodeId: string, approved: boolean, note = "") =>
    _fetch(`/api/runs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, approved, note }),
    }).then((r) => j<RunState>(r)),

  suggest: (body: { hours?: number; max?: number; projectRoot?: string } = {}) =>
    _fetch("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<SuggestResult>(r)),

  pair: () => _fetch("/api/pair").then((r) => j<PairInfo>(r)),
};

export interface PairInfo {
  lan: boolean;
  token?: string;
  port?: number;
  addresses?: string[];
  /** Nocturne Anywhere invitation (present when the daemon runs with --remote). */
  remote?: { url: string; name: string };
}

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
  if (REMOTE && remoteActive()) return remoteEvents(onEvent);
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const t = pairToken();
    ws = new WebSocket(`${proto}://${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`);
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
