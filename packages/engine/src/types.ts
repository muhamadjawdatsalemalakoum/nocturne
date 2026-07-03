import type { Workflow } from "@nocturne/core";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_timer"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting";

export interface StepRecord {
  nodeId: string;
  type: string;
  status: StepStatus;
  attempts: number;
  sessionId?: string;
  output?: string;
  costUsd?: number;
  error?: string;
  /** consecutive rate-limit hits for this step (bounds a mis-parsed-reset retry loop). */
  limitHits?: number;
  /** for waiting steps (wait node or limit backoff): absolute ms timestamp to wake. */
  wakeAt?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowName: string;
  /** immutable snapshot of the workflow this run executes. */
  workflow: Workflow;
  projectRoot: string;
  params: Record<string, string>;
  status: RunStatus;
  steps: Record<string, StepRecord>;
  /** earliest wake time across waiting steps (drives the scheduler). */
  wakeAt?: number;
  waitingApprovalNodeId?: string;
  totalCostUsd: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type RunEvent =
  | { type: "run.created"; runId: string; at: number }
  | { type: "run.status"; runId: string; status: RunStatus; at: number; detail?: string }
  | { type: "step.status"; runId: string; nodeId: string; status: StepStatus; at: number; detail?: string }
  | { type: "step.output"; runId: string; nodeId: string; output: string; costUsd: number; at: number }
  | { type: "step.activity"; runId: string; nodeId: string; kind: "text" | "tool" | "thinking"; text: string; at: number }
  | { type: "run.log"; runId: string; message: string; at: number };

/** A live activity emitted while an agent step is working (streaming mode). */
export interface ClaudeActivity {
  kind: "text" | "tool" | "thinking";
  text: string;
}

export interface ClaudeRunOptions {
  prompt: string;
  /** omit for `inherit` */
  model?: string;
  effort?: string;
  /** absolute working directory */
  cwd: string;
  allowedTools?: string[];
  permissionMode?: string;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  outputSchema?: unknown;
  timeoutMs: number;
  /** when provided, the runner streams (--output-format stream-json) and calls this per event. */
  onActivity?: (a: ClaudeActivity) => void;
}

export interface ClaudeResult {
  isError: boolean;
  apiErrorStatus?: number;
  text: string;
  sessionId?: string;
  costUsd: number;
  raw: unknown;
  exitCode: number;
  stderr?: string;
  /** set when the process was killed for exceeding timeoutMs */
  timedOut?: boolean;
  /** set when the child failed to spawn (bad binary path, missing cwd, ENOENT) */
  spawnError?: boolean;
}

export interface ClaudeRunner {
  run(opts: ClaudeRunOptions): Promise<ClaudeResult>;
}

export interface EngineConfig {
  claudePath: string;
  maxConcurrent: number;
  webhookUrl?: string;
  defaultLimitWaitMinutes: number;
  autoResumeOnStart: boolean;
  /** optional long-lived subscription token (claude setup-token) injected into the child env. */
  oauthToken?: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  claudePath: "claude",
  maxConcurrent: 2,
  defaultLimitWaitMinutes: 60,
  autoResumeOnStart: true,
};
