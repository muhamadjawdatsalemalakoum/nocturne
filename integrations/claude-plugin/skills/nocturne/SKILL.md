---
name: nocturne
description: >-
  Design, launch, and monitor durable multi-step Claude Code workflows through the local Nocturne
  daemon — pipelines that survive the session closing and wait out usage-limit resets. Use when the
  user wants to run something overnight/unattended, kick off a multi-agent pipeline, check on or
  approve a running job, or turn their recent Claude Code sessions into a reusable workflow.
---

# Nocturne — durable workflow orchestration

Nocturne runs multi-step Claude Code pipelines that keep going after the current session ends and
**checkpoint → wait out the usage-limit reset → resume** on their own. The durable state lives in a
local daemon; you drive it through the `nocturne` MCP tools. It runs on the user's Claude
subscription (it spawns the official `claude` CLI), not metered API billing.

**Prerequisite:** the daemon must be running. If a tool reports it's unreachable, tell the user to
start it with `nocturne serve` (or `npm run serve` in the repo). Check with `nocturne_status`.

## When to reach for it

- "Run this refactor/test loop **overnight** / while I'm away" → `run_workflow`.
- "Kick off a multi-step pipeline on this repo" → `run_workflow` with `projectRoot` = the repo path.
- "How's my Nocturne run doing?" → `list_runs`, then `get_run`.
- "It's waiting for my approval" → `get_run` to see the gate node, then `approve_step`.
- "Turn what I did recently into a workflow" → `suggest_workflows` (Retrace), then `save_workflow`.

## How to use the tools

1. **Launch.** `run_workflow` needs an **absolute `projectRoot`** (the repo the agents work in) and
   either a saved `workflowId` (see `list_workflows`) or an inline `workflow` object. It returns a
   `runId` and returns immediately — the run continues unattended.
2. **Poll, don't block.** Use `get_run` with the `runId` to see per-step status, streamed output,
   and cost. A run may sit in `waiting_timer` (holding for a usage-limit/timer — it auto-resumes) or
   `waiting_approval` (needs you).
3. **Gates.** When `get_run` shows `waiting_approval`, call `approve_step` with the run id, the
   approval node id, and `approved: true/false`.
4. **Control.** `pause_run` / `resume_run` / `cancel_run` as needed (`resume_run` also resumes a
   limit wait immediately).
5. **Retrace.** `suggest_workflows` reads the user's recent local Claude Code sessions and drafts
   reusable workflows. Show the drafts; if the user likes one, `save_workflow` it (or `run_workflow`
   it directly). Everything stays on the user's machine.

## Good habits

- Always confirm the **`projectRoot`** with the user before launching a run — agents act in that dir.
- Prefer a **saved** workflow (`list_workflows` → `run_workflow` by id) over hand-authoring one.
- After launching, tell the user the `runId` and that they can close everything — the run survives.
- For visual editing (drag steps, set models, add wait/approval nodes), point them at the canvas at
  `http://localhost:5151`.
