import { z } from "zod";

/** Current workflow file format version. Loaders reject files with a higher number. */
export const FORMAT_VERSION = 1;

/** Model aliases the Claude CLI understands, plus `inherit` (use the run's session model). */
export const MODEL_ALIASES = ["inherit", "haiku", "sonnet", "opus"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** A model is a known alias or an explicit `claude-*` model id. */
export const modelSchema = z
  .string()
  .refine(
    (m) => (MODEL_ALIASES as readonly string[]).includes(m) || /^claude-[a-z0-9.-]+$/i.test(m),
    {
      message:
        "model must be one of inherit|haiku|sonnet|opus or an explicit claude-* model id",
    },
  );

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "auto",
]);

export const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const retrySchema = z.object({
  max: z.number().int().min(0).max(10),
  backoffSec: z.number().int().min(0).max(3600),
});

/** Node kinds. `start`/`end` are structural; the rest carry behaviour in `data`. */
export const nodeTypeSchema = z.enum(["start", "agent", "wait", "approval", "end"]);
export type NodeType = z.infer<typeof nodeTypeSchema>;

const baseNode = z.object({
  id: z.string().min(1),
  position: positionSchema,
});

export const startNodeSchema = baseNode.extend({
  type: z.literal("start"),
  data: z.object({}).optional(),
});

export const endNodeSchema = baseNode.extend({
  type: z.literal("end"),
  data: z.object({}).optional(),
});

export const agentNodeDataSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: modelSchema.default("inherit"),
  effort: effortSchema.optional(),
  /** Working directory RELATIVE to the run's projectRoot. Empty = projectRoot. */
  cwd: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  permissionMode: permissionModeSchema.default("dontAsk"),
  maxBudgetUsd: z.number().positive().optional(),
  /** If set, resume the named node's claude session instead of a fresh context. */
  continueFrom: z.string().nullable().default(null),
  retry: retrySchema.default({ max: 1, backoffSec: 60 }),
  /** Optional JSON schema for structured step output (maps to --json-schema). */
  outputSchema: z.unknown().nullable().default(null),
  /** Per-step timeout override in seconds. */
  timeoutSec: z.number().int().positive().optional(),
});
export type AgentNodeData = z.infer<typeof agentNodeDataSchema>;

export const agentNodeSchema = baseNode.extend({
  type: z.literal("agent"),
  data: agentNodeDataSchema,
});

export const waitNodeDataSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("duration"), minutes: z.number().positive().max(10080) }),
  z.object({ mode: z.literal("until"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  z.object({ mode: z.literal("limitReset") }),
]);
export type WaitNodeData = z.infer<typeof waitNodeDataSchema>;

export const waitNodeSchema = baseNode.extend({
  type: z.literal("wait"),
  data: waitNodeDataSchema,
});

export const approvalNodeSchema = baseNode.extend({
  type: z.literal("approval"),
  data: z.object({
    message: z.string().default("Approve to continue."),
  }),
});

export const nodeSchema = z.discriminatedUnion("type", [
  startNodeSchema,
  agentNodeSchema,
  waitNodeSchema,
  approvalNodeSchema,
  endNodeSchema,
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const paramSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "param name must be a valid identifier"),
  description: z.string().default(""),
  default: z.string().default(""),
});
export type WorkflowParam = z.infer<typeof paramSchema>;

export const workflowSchema = z.object({
  nocturne: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  params: z.array(paramSchema).default([]),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
});
export type Workflow = z.infer<typeof workflowSchema>;
