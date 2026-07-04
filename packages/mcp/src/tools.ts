import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DaemonClient, DaemonDownError, type RunState, type SuggestResult, type WorkflowSummary } from "./daemon.js";

/** A tool handler result in the MCP content shape. */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const money = (n: number | undefined): string => `$${(n ?? 0).toFixed(3)}`;
const clip = (s: string, n = 240): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function stepMark(status: string): string {
  switch (status) {
    case "succeeded": return "done";
    case "running": return "running";
    case "waiting": return "waiting";
    case "failed": return "failed";
    case "skipped": return "skipped";
    default: return status;
  }
}

function fmtWorkflowList(list: WorkflowSummary[]): string {
  if (!list.length) return "No saved workflows yet. Design one in the canvas, or call save_workflow.";
  return (
    `${list.length} workflow${list.length === 1 ? "" : "s"}:\n` +
    list.map((w) => `• ${w.name} — ${w.nodeCount} nodes · id: ${w.id}${w.description ? `\n  ${clip(w.description, 120)}` : ""}`).join("\n")
  );
}

function fmtRun(run: RunState): string {
  const steps = Object.values(run.steps);
  const lines = steps.map((s) => {
    const cost = s.costUsd ? ` · ${money(s.costUsd)}` : "";
    const out = s.error ? ` — error: ${clip(s.error, 160)}` : s.output ? ` — ${clip(s.output, 160)}` : "";
    return `  [${stepMark(s.status)}] ${s.nodeId} (${s.type})${cost}${out}`;
  });
  let head = `Run ${run.runId} · ${run.status} · ${money(run.totalCostUsd)}`;
  if (run.status === "waiting_approval" && run.waitingApprovalNodeId) {
    head += `\n→ awaiting approval on node "${run.waitingApprovalNodeId}" (use approve_step).`;
  }
  if (run.status === "waiting_timer" && run.wakeAt) {
    head += `\n→ waiting until ${new Date(run.wakeAt).toISOString()} (limit/timer); will auto-resume, or resume_run now.`;
  }
  if (run.error) head += `\n→ error: ${clip(run.error, 200)}`;
  return `${head}\n${lines.join("\n")}`;
}

function fmtRunList(runs: RunState[]): string {
  if (!runs.length) return "No runs yet.";
  return (
    `${runs.length} run${runs.length === 1 ? "" : "s"} (newest first):\n` +
    runs
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((r) => `• ${r.workflowName} · ${r.status} · ${money(r.totalCostUsd)} · id: ${r.runId}`)
      .join("\n")
  );
}

function fmtSuggestions(res: SuggestResult): string {
  if (!res.suggestions.length) {
    return res.note ?? `No workflows suggested from ${res.sessionsScanned} sessions in the last ${res.windowHours}h.`;
  }
  const head = `Drafted ${res.suggestions.length} workflow${res.suggestions.length === 1 ? "" : "s"} from ${res.sessionsScanned} recent session${res.sessionsScanned === 1 ? "" : "s"} (${res.windowHours}h · ${money(res.cost)}):`;
  const body = res.suggestions
    .map((s, i) => {
      const steps = s.workflow.nodes.filter((n) => n.type === "agent").length;
      return `${i + 1}. ${s.workflow.name} — ${steps} step${steps === 1 ? "" : "s"}\n   ${clip(s.workflow.description ?? "", 140)}${s.rationale ? `\n   why: ${clip(s.rationale, 160)}` : ""}`;
    })
    .join("\n");
  // include the raw workflows so the agent can save_workflow/run_workflow one directly (bounded)
  let json = JSON.stringify(res.suggestions.map((s) => s.workflow));
  if (json.length > 60_000) {
    json =
      JSON.stringify(res.suggestions.slice(0, 4).map((s) => s.workflow)) +
      "\n(…more suggestions omitted for size — narrow with the `max` argument.)";
  }
  return `${head}\n${body}\n\nTo keep or run one, pass its workflow object to save_workflow / run_workflow. Workflows:\n${json}`;
}

/** Run a handler, converting daemon/validation errors into a clean tool error. */
function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((e: unknown) => {
    if (e instanceof DaemonDownError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  });
}

/** Register every Nocturne tool on the given MCP server. */
export function registerTools(server: McpServer, client: DaemonClient): void {
  server.registerTool(
    "nocturne_status",
    { title: "Nocturne status", description: "Check whether the Nocturne daemon is running and reachable." },
    () =>
      guard(async () => {
        const h = await client.health();
        return ok(`Nocturne daemon v${h.version} is running at ${client.baseUrl}.`);
      }),
  );

  server.registerTool(
    "list_workflows",
    { title: "List workflows", description: "List the workflows saved in the Nocturne library." },
    () => guard(async () => ok(fmtWorkflowList(await client.listWorkflows()))),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow",
      description: "Fetch one saved workflow as a full .nocturne.json object (by id).",
      inputSchema: { id: z.string().min(1).describe("the workflow id (from list_workflows)") },
    },
    ({ id }) => guard(async () => ok(JSON.stringify(await client.getWorkflow(id), null, 2))),
  );

  server.registerTool(
    "save_workflow",
    {
      title: "Save workflow",
      description:
        "Validate and save a workflow to the library. Pass a full Nocturne workflow object (nocturne/id/name/nodes/edges/params) — e.g. one from get_workflow, suggest_workflows, or a canvas export. The daemon validates it and rejects absolute paths/secrets.",
      inputSchema: { workflow: z.record(z.string(), z.unknown()).describe("a full .nocturne.json workflow object") },
    },
    ({ workflow }) =>
      guard(async () => {
        const wf = await client.saveWorkflow(workflow);
        return ok(`Saved "${wf.name}" (id: ${wf.id}, ${wf.nodes.length} nodes).`);
      }),
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run workflow",
      description:
        "Start a durable run. Provide either workflowId (a saved workflow) or an inline workflow object, plus projectRoot (the absolute path to the repo the agents work in). The run keeps going after this call returns — poll it with get_run.",
      inputSchema: {
        workflowId: z.string().optional().describe("id of a saved workflow (or pass `workflow`)"),
        workflow: z.record(z.string(), z.unknown()).optional().describe("an inline .nocturne.json workflow object"),
        projectRoot: z.string().describe("absolute path to the project directory the agents run in"),
        params: z.record(z.string(), z.string()).optional().describe("values for the workflow's {{params}}"),
      },
    },
    ({ workflowId, workflow, projectRoot, params }) =>
      guard(async () => {
        if (!workflowId && !workflow) return err("Provide either workflowId or an inline workflow object.");
        const run = await client.startRun({
          ...(workflowId ? { workflowId } : {}),
          ...(workflow ? { workflow: workflow as never } : {}),
          projectRoot,
          ...(params ? { params } : {}),
        });
        return ok(`Started run ${run.runId} for "${run.workflowName}" (status: ${run.status}). Poll get_run for progress; it survives this session ending.`);
      }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "List recent runs (optionally filtered by workflowId) with status and cost.",
      inputSchema: { workflowId: z.string().optional().describe("only runs of this workflow") },
    },
    ({ workflowId }) => guard(async () => ok(fmtRunList(await client.listRuns(workflowId)))),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description: "Get a run's current status, per-step state, outputs, and total cost.",
      inputSchema: { runId: z.string().min(1).describe("the run id (from run_workflow / list_runs)") },
    },
    ({ runId }) => guard(async () => ok(fmtRun(await client.getRun(runId)))),
  );

  server.registerTool(
    "approve_step",
    {
      title: "Approve step",
      description: "Approve or reject a run that is paused at a human approval gate.",
      inputSchema: {
        runId: z.string().min(1),
        nodeId: z.string().min(1).describe("the approval node id (shown by get_run when waiting_approval)"),
        approved: z.boolean(),
        note: z.string().optional(),
      },
    },
    ({ runId, nodeId, approved, note }) =>
      guard(async () => {
        const run = await client.approve(runId, nodeId, approved, note ?? "");
        return ok(`${approved ? "Approved" : "Rejected"} "${nodeId}". Run is now ${run.status}.`);
      }),
  );

  const lifecycle = (
    name: "pause_run" | "resume_run" | "cancel_run",
    verb: "pause" | "resume" | "cancel",
    desc: string,
  ) =>
    server.registerTool(
      name,
      { title: name.replace("_", " "), description: desc, inputSchema: { runId: z.string().min(1) } },
      ({ runId }) =>
        guard(async () => {
          const run = await client[verb](runId);
          return ok(`Run ${runId} is now ${run.status}.`);
        }),
    );
  lifecycle("pause_run", "pause", "Pause a running run (it can be resumed later).");
  lifecycle("resume_run", "resume", "Resume a paused run, or resume a limit/timer wait immediately.");
  lifecycle("cancel_run", "cancel", "Cancel a run.");

  server.registerTool(
    "suggest_workflows",
    {
      title: "Suggest workflows (Retrace)",
      description:
        "Retrace: read the user's recent local Claude Code sessions and draft reusable workflows from what they did. Returns drafted workflows you can save_workflow or run_workflow.",
      inputSchema: {
        hours: z.number().int().positive().max(168).optional().describe("how far back to look (default 24)"),
        max: z.number().int().positive().max(12).optional().describe("max suggestions (default 5)"),
        projectRoot: z.string().optional().describe("optional project dir to run the analysis in"),
      },
    },
    ({ hours, max, projectRoot }) =>
      guard(async () =>
        ok(
          fmtSuggestions(
            await client.suggest({
              ...(hours ? { hours } : {}),
              ...(max ? { max } : {}),
              ...(projectRoot ? { projectRoot } : {}),
            }),
          ),
        ),
      ),
  );
}
