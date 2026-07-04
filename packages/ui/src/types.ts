import type { Workflow } from "@nocturne/core";

export type { Workflow };
export type NodeKind = "start" | "agent" | "wait" | "approval" | "condition" | "end";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "waiting";
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

export interface StepRecord {
  nodeId: string;
  type: string;
  status: StepStatus;
  attempts: number;
  output?: string;
  error?: string;
  costUsd?: number;
  wakeAt?: number;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  steps: Record<string, StepRecord>;
  totalCostUsd: number;
  wakeAt?: number;
  waitingApprovalNodeId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  updatedAt: number;
}

export type Activity = { kind: "text" | "tool" | "thinking"; text: string; at: number };

export type RunEvent =
  | { type: "run.status"; runId: string; status: RunStatus; at: number; detail?: string }
  | { type: "step.status"; runId: string; nodeId: string; status: StepStatus; at: number; detail?: string }
  | { type: "step.output"; runId: string; nodeId: string; output: string; costUsd: number; at: number }
  | { type: "step.activity"; runId: string; nodeId: string; kind: "text" | "tool" | "thinking"; text: string; at: number }
  | { type: "run.created"; runId: string; at: number }
  | { type: "run.log"; runId: string; message: string; at: number };
