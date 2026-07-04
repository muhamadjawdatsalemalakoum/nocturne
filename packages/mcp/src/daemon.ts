import type { Workflow } from "@nocturne/core";

/**
 * A thin, typed HTTP client to the running Nocturne daemon's REST API.
 * The MCP server is a stateless adapter — all durable state (runs, waits,
 * checkpoints) lives in the daemon; these methods just forward to it.
 */

const DEFAULT_URL = "http://127.0.0.1:5151";

/** Resolve the daemon base URL (NOCTURNE_DAEMON_URL / NOCTURNE_URL, else localhost:5151). */
export function daemonUrl(): string {
  const u = process.env["NOCTURNE_DAEMON_URL"] || process.env["NOCTURNE_URL"] || DEFAULT_URL;
  return u.replace(/\/+$/, "");
}

/** Thrown when the daemon can't be reached — carries a user-actionable hint. */
export class DaemonDownError extends Error {
  constructor(public base: string, cause?: unknown) {
    super(
      `Can't reach the Nocturne daemon at ${base}. Start it with \`nocturne serve\` ` +
        `(or set NOCTURNE_DAEMON_URL if it runs elsewhere).`,
    );
    this.name = "DaemonDownError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  updatedAt: number;
}

export interface StepRecord {
  nodeId: string;
  type: string;
  status: string;
  attempts?: number;
  output?: string;
  error?: string;
  costUsd?: number;
  wakeAt?: number;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  steps: Record<string, StepRecord>;
  totalCostUsd: number;
  wakeAt?: number;
  waitingApprovalNodeId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
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

export interface StartRunBody {
  workflowId?: string;
  workflow?: Workflow;
  projectRoot: string;
  params?: Record<string, string>;
}

/** Default per-request timeout; the daemon's own endpoints are fast except suggest (LLM). */
const DEFAULT_TIMEOUT_MS = 45_000;
const SUGGEST_TIMEOUT_MS = 300_000;
/** Cap on a single daemon response (guards against a misbehaving/compromised NOCTURNE_DAEMON_URL). */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class DaemonClient {
  constructor(
    private base: string = daemonUrl(),
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.base;
  }

  private async req<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const label = `${init?.method ?? "GET"} ${path}`;
    try {
      const res = await this.fetchImpl(this.base + path, { ...init, signal: ctrl.signal });
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_RESPONSE_BYTES) throw new Error(`${label} returned an oversized response (${len} bytes).`);
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (body && typeof body.error === "string") msg = body.error;
        } catch {
          /* non-JSON body */
        }
        throw new Error(`${label} failed (${res.status}): ${msg}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
      if (e instanceof TypeError) throw new DaemonDownError(this.base, e); // network-level fetch failure
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.req<T>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.req("/api/health");
  }
  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.req("/api/workflows");
  }
  getWorkflow(id: string): Promise<Workflow> {
    return this.req(`/api/workflows/${encodeURIComponent(id)}`);
  }
  saveWorkflow(wf: unknown): Promise<Workflow> {
    return this.post("/api/workflows", wf);
  }
  startRun(body: StartRunBody): Promise<RunState> {
    return this.post("/api/runs", body);
  }
  listRuns(workflowId?: string): Promise<RunState[]> {
    return this.req(`/api/runs${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`);
  }
  getRun(id: string): Promise<RunState> {
    return this.req(`/api/runs/${encodeURIComponent(id)}`);
  }
  pause(id: string): Promise<RunState> {
    return this.post(`/api/runs/${encodeURIComponent(id)}/pause`);
  }
  resume(id: string): Promise<RunState> {
    return this.post(`/api/runs/${encodeURIComponent(id)}/resume`);
  }
  cancel(id: string): Promise<RunState> {
    return this.post(`/api/runs/${encodeURIComponent(id)}/cancel`);
  }
  approve(id: string, nodeId: string, approved: boolean, note = ""): Promise<RunState> {
    return this.post(`/api/runs/${encodeURIComponent(id)}/approve`, { nodeId, approved, note });
  }
  suggest(body: { hours?: number; max?: number; projectRoot?: string }): Promise<SuggestResult> {
    return this.post("/api/suggest", body, SUGGEST_TIMEOUT_MS);
  }
}
