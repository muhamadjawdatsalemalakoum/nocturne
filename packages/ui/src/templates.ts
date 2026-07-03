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
        { title: "Analyze codebase", prompt: "Analyze the module in scope and produce a concrete change plan with file-level steps.", model: "haiku", tools: READONLY },
        { title: "Implement change", prompt: "Implement the plan from the previous step.\n\nPlan:\n{{steps.step-0.output}}", model: "sonnet", tools: EDIT },
        { title: "Run tests & fix", prompt: "Run the test suite, and fix any failures introduced by the change.", model: "sonnet", tools: FULL },
      ]),
  },
  {
    id: "fix-tests",
    name: "Fix failing tests",
    description: "Find failures, fix them, and verify green.",
    icon: "beaker",
    build: () =>
      linear("Fix failing tests", "Diagnose and fix a failing test suite.", [
        { title: "Diagnose failures", prompt: "Run the tests and summarize each failure with its likely root cause.", model: "sonnet", tools: FULL },
        { title: "Fix", prompt: "Fix the failures identified here:\n{{steps.step-0.output}}", model: "sonnet", tools: EDIT },
        { title: "Verify", prompt: "Re-run the full test suite and confirm everything passes.", model: "haiku", tools: FULL },
      ]),
  },
  {
    id: "research-summarize",
    name: "Research & summarize",
    description: "Investigate a question, then write a tight summary.",
    icon: "search",
    build: () =>
      linear("Research & summarize", "Investigate and summarize.", [
        { title: "Research", prompt: "Research the question and gather the key facts with sources.", model: "sonnet", tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] },
        { title: "Summarize", prompt: "Write a tight, well-organized summary of:\n{{steps.step-0.output}}", model: "haiku", tools: READONLY },
      ]),
  },
  {
    id: "rate-limit-safe",
    name: "Rate-limit-safe pipeline",
    description: "A long job that waits out the reset and resumes — the hero feature.",
    icon: "moon",
    build: () =>
      linear("Rate-limit-safe pipeline", "Runs across the usage-limit reset, unattended.", [
        { title: "First pass", prompt: "Do the first half of the work.", model: "sonnet", tools: EDIT },
        { title: "Wait for reset", prompt: "", wait: "limitReset" },
        { title: "Second pass", prompt: "Continue with the second half.", model: "sonnet", tools: EDIT },
      ]),
  },
  {
    id: "review-approve",
    name: "Implement · approve · ship",
    description: "Implement, pause for your approval, then ship.",
    icon: "shield",
    build: () =>
      linear("Implement · approve · ship", "With a human approval gate before shipping.", [
        { title: "Implement", prompt: "Implement the change.", model: "sonnet", tools: EDIT },
        { title: "Review the diff", prompt: "", approval: "Review the diff before it ships." },
        { title: "Ship", prompt: "Commit and open a pull request.", model: "haiku", tools: FULL },
      ]),
  },
];

/** One-tap prompt starters for an agent step. */
export const PROMPT_PRESETS: Array<{ label: string; text: string }> = [
  { label: "Analyze", text: "Analyze the code in scope and produce a concrete plan." },
  { label: "Implement", text: "Implement the change described above." },
  { label: "Write tests", text: "Write tests covering the new behavior." },
  { label: "Review", text: "Review the diff for bugs and edge cases." },
  { label: "Summarize", text: "Summarize what changed and why." },
  { label: "Use prior step", text: "Continue, using the previous step's output:\n{{steps.PREV.output}}" },
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
