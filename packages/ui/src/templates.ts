import { newId, type Workflow } from "@nocturne/core";

type Model = "inherit" | "haiku" | "sonnet" | "opus";

interface StepSpec {
  title: string;
  prompt: string;
  model?: Model;
  tools?: string[];
  wait?: "limitReset";
  approval?: string;
}

function agentData(s: StepSpec) {
  return {
    title: s.title,
    prompt: s.prompt,
    model: s.model ?? "inherit",
    cwd: "",
    allowedTools: s.tools ?? [],
    permissionMode: "dontAsk" as const,
    continueFrom: null,
    retry: { max: 1, backoffSec: 60 },
    outputSchema: null,
  };
}

/** Build a linear workflow from a list of steps (agent / wait / approval). */
function linear(name: string, description: string, steps: StepSpec[]): Workflow {
  const nodes: Workflow["nodes"] = [{ id: "start", type: "start", position: { x: 0, y: 150 } }];
  const edges: Workflow["edges"] = [];
  let prev = "start";
  let x = 220;
  steps.forEach((s, i) => {
    const id = s.wait ? `wait-${i}` : s.approval ? `gate-${i}` : `step-${i}`;
    if (s.wait) nodes.push({ id, type: "wait", position: { x, y: 165 }, data: { mode: "limitReset" as const } });
    else if (s.approval) nodes.push({ id, type: "approval", position: { x, y: 165 }, data: { message: s.approval } });
    else nodes.push({ id, type: "agent", position: { x, y: 120 }, data: agentData(s) });
    edges.push({ id: `e-${prev}-${id}`, source: prev, target: id });
    prev = id;
    x += 280;
  });
  nodes.push({ id: "end", type: "end", position: { x, y: 150 } });
  edges.push({ id: `e-${prev}-end`, source: prev, target: "end" });
  return { nocturne: 1, id: newId(), name, description, params: [], nodes, edges };
}

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: "moon" | "wrench" | "search" | "shield" | "beaker";
  build: () => Workflow;
}

const READONLY = ["Read", "Grep", "Glob"];
const EDIT = ["Read", "Edit", "Write", "Grep", "Glob"];
const FULL = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

export const TEMPLATES: Template[] = [
  {
    id: "overnight-refactor",
    name: "Overnight refactor",
    description: "Analyze → implement → test, paced to survive rate limits.",
    icon: "moon",
    build: () =>
      linear("Overnight refactor", "Analyze, implement, and test a change overnight.", [
        {
          title: "Analyze codebase",
          prompt:
            "Survey this repository and produce a concrete refactoring plan for its weakest area: read the structure, identify the one module or pattern most worth improving (duplication, tangled responsibilities, dead code), and write a plan another engineer could execute without asking questions — the files to touch, the change per file, the order to make them in, and how to prove nothing broke. Do not change any code. Done when: the plan names real paths from THIS repo and every step has a verification note.",
          model: "haiku",
          tools: READONLY,
        },
        {
          title: "Implement change",
          prompt:
            "Execute this refactoring plan exactly. Work through it step by step, keeping each change minimal and behavior-preserving; if a step turns out to be wrong for the actual code, adapt with the smallest deviation and note what you changed and why. Done when: every plan step is applied or explicitly noted as skipped, and the code compiles/imports cleanly.\n\nPlan:\n{{steps.step-0.output}}",
          model: "sonnet",
          tools: EDIT,
        },
        {
          title: "Run tests & fix",
          prompt:
            "Run this repository's full test suite (find the real test command in package.json/Makefile/CI config — don't guess). If anything fails, fix the regressions introduced by the recent refactor — do not weaken, skip, or delete tests to get to green. Done when: the suite exits 0, and you report the command you ran, the final pass count, and every fix you made.",
          model: "sonnet",
          tools: FULL,
        },
      ]),
  },
  {
    id: "fix-tests",
    name: "Fix failing tests",
    description: "Find failures, fix them, and verify green.",
    icon: "beaker",
    build: () =>
      linear("Fix failing tests", "Diagnose and fix a failing test suite.", [
        {
          title: "Diagnose failures",
          prompt:
            "Run this repository's test suite (locate the real test command first) and diagnose every failure: for each one, record the test name, the error, and the most likely root cause with the file/line it points to. Distinguish product bugs from stale tests. Do not fix anything yet. Done when: every failure has a named suspect, ordered so that shared root causes are grouped.",
          model: "sonnet",
          tools: FULL,
        },
        {
          title: "Fix",
          prompt:
            "Fix the root causes in this diagnosis, favoring product-code fixes over test edits; only change a test when the diagnosis shows the test itself is stale, and never delete or skip one to force green. Done when: every diagnosed failure has a corresponding fix, each traceable to its root cause.\n\nDiagnosis:\n{{steps.step-0.output}}",
          model: "sonnet",
          tools: EDIT,
        },
        {
          title: "Verify",
          prompt:
            "Re-run the full test suite from a clean state and confirm it passes completely. Done when: the suite exits 0 — report the exact command, total passed, and runtime. If anything still fails, report precisely what and stop; do not attempt fixes in this step.",
          model: "haiku",
          tools: FULL,
        },
      ]),
  },
  {
    id: "research-summarize",
    name: "Research & summarize",
    description: "Investigate a question, then write a tight summary.",
    icon: "search",
    build: () =>
      linear("Research & summarize", "Investigate and summarize.", [
        {
          title: "Research",
          prompt:
            "Investigate the research question defined for this run (check the repo's notes/README for context if none was given). Gather primary facts — from this codebase and, where the question needs it, the web — and record each finding with its source (file path or URL) and date. Separate established facts from your inferences. Done when: the question can be answered from your notes alone, with at least one source per claim.",
          model: "sonnet",
          tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
        },
        {
          title: "Summarize",
          prompt:
            "Distill these research notes into a summary the reader can act on in two minutes: lead with the answer, then the supporting evidence in descending order of weight, then open questions. Keep every claim traceable to a source in the notes; cut anything that doesn't earn its lines. Done when: it fits on one screen and contains zero unsourced claims.\n\nNotes:\n{{steps.step-0.output}}",
          model: "haiku",
          tools: READONLY,
        },
      ]),
  },
  {
    id: "rate-limit-safe",
    name: "Rate-limit-safe pipeline",
    description: "A long job that waits out the reset and resumes — the hero feature.",
    icon: "moon",
    build: () =>
      linear("Rate-limit-safe pipeline", "Runs across the usage-limit reset, unattended.", [
        {
          title: "First pass",
          prompt:
            "Begin the large task defined for this run and take it to a clean midpoint: complete whole units of work (whole files, whole modules — nothing half-edited), then write a precise handoff: what is done, what remains, and exactly where the next agent should pick up. Done when: the repo is in a consistent state and the handoff would let a stranger continue without re-reading everything.",
          model: "sonnet",
          tools: EDIT,
        },
        { title: "Wait for reset", prompt: "", wait: "limitReset" },
        {
          title: "Second pass",
          prompt:
            "Fresh usage window. Read the handoff from the first pass (below), pick up exactly where it left off, and carry the task to completion — including a final consistency check over the files the first pass touched. Done when: nothing from the original task remains, and you report what each pass accomplished.\n\nHandoff:\n{{steps.step-0.output}}",
          model: "sonnet",
          tools: EDIT,
        },
      ]),
  },
  {
    id: "review-approve",
    name: "Implement · approve · ship",
    description: "Implement, pause for your approval, then ship.",
    icon: "shield",
    build: () =>
      linear("Implement · approve · ship", "With a human approval gate before shipping.", [
        {
          title: "Implement",
          prompt:
            "Implement the change defined for this run as a reviewable diff: keep it scoped (no drive-by refactors), match the codebase's existing style, and update any tests or docs the change makes stale. Finish with a short summary of what changed and why, written for the human who will review it at the gate. Done when: the diff is complete, coherent, and would pass this repo's checks.",
          model: "sonnet",
          tools: EDIT,
        },
        { title: "Review the diff", prompt: "", approval: "Review the diff before it ships — check scope, correctness, and anything touching auth/data/money." },
        {
          title: "Ship",
          prompt:
            "The change was human-approved. Ship it: create a well-named branch, commit with a message that explains the why (not just the what), push, and open a pull request whose description covers the change, the reasoning, and how it was verified. Done when: the PR exists — report its URL.",
          model: "haiku",
          tools: FULL,
        },
      ]),
  },
];

/** One-tap prompt starters for an agent step. */
export const PROMPT_PRESETS: Array<{ label: string; text: string }> = [
  { label: "Analyze", text: "Analyze the code in scope and produce a plan another engineer could execute without questions: files to touch, the change per file, the order, and how to verify each step. Don't change any code." },
  { label: "Implement", text: "Implement the change described above, keeping the diff minimal and matching the codebase's existing style. Update anything the change makes stale (tests, docs, types). Report what you changed and why." },
  { label: "Write tests", text: "Write tests for the new behavior: cover the happy path, the edge cases, and one failure mode. Run them and confirm they pass — and that they fail if the behavior is reverted." },
  { label: "Review", text: "Review the current diff for real defects: logic errors, unhandled edge cases, races, security issues. For each finding give file:line, a concrete failure scenario, and a suggested fix. No style nits." },
  { label: "Summarize", text: "Summarize what changed and why in a form a reviewer can absorb in one minute: the goal, the approach, each notable change, and how it was verified." },
  { label: "Use prior step", text: "Continue from the previous step's output below — pick up exactly where it left off.\n\n{{steps.PREV.output}}" },
];

/** Tool bundles + the individual tools offered as toggle chips. */
export const TOOL_PRESETS: Array<{ label: string; tools: string[] }> = [
  { label: "Read-only", tools: READONLY },
  { label: "Edit code", tools: EDIT },
  { label: "Full access", tools: FULL },
];
export const TOOL_CHIPS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"];

/** Duration presets for wait steps. */
export const WAIT_DURATIONS = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
];
