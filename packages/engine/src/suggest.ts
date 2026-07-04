import { promises as fs } from "node:fs";
import os from "node:os";
import { newId, normalizeOrThrow, type Workflow } from "@nocturne/core";
import { gatherRecentSessions, type SessionDigest } from "./sessions.js";
import type { ClaudeRunner } from "./types.js";

/**
 * Retrace: turn recent Claude Code sessions into reusable workflow drafts.
 *
 * The daemon distills the last N hours of local transcripts into digests
 * (see sessions.ts), hands them to a Claude subagent, and the subagent returns
 * workflow *intent* as JSON. We compile that intent into real, schema-valid
 * `.nocturne.json` graphs here — the model never has to get positions, ids, or
 * edges right; it only describes the steps.
 */

/** Marker at the top of the meta-prompt (lets the fake-claude fixture recognise a Retrace call). */
export const RETRACE_SENTINEL = "NOCTURNE_RETRACE_V1";

const KNOWN_MODELS = new Set(["inherit", "haiku", "sonnet", "opus"]);
const KNOWN_TOOLS = new Set(["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Task"]);
const MAX_STEPS = 8;

/** One step of a drafted workflow, as returned by the model (loosely typed on purpose). */
export interface DraftStep {
  kind?: "agent" | "wait" | "approval";
  title?: string;
  prompt?: string;
  model?: string;
  tools?: unknown;
  message?: string;
}

export interface WorkflowDraft {
  name?: string;
  description?: string;
  rationale?: string;
  sourceSessions?: unknown;
  steps?: DraftStep[];
}

export interface WorkflowSuggestion {
  workflow: Workflow;
  /** why this was suggested / when to reach for it. */
  rationale: string;
  /** session ids this pattern was distilled from. */
  sourceSessions: string[];
}

function normModel(m?: string): string {
  if (typeof m !== "string" || !m) return "inherit";
  const s = m.toLowerCase();
  if (KNOWN_MODELS.has(s)) return s;
  if (/^claude-[a-z0-9.-]+$/i.test(m)) return m;
  return "inherit";
}

function normTools(t: unknown): string[] {
  if (!Array.isArray(t)) return [];
  const out: string[] = [];
  for (const x of t) {
    if (typeof x !== "string") continue;
    // accept a known bare tool or an MCP-style tool id; drop anything odd
    if (KNOWN_TOOLS.has(x) || /^[A-Za-z][A-Za-z0-9_.-]*$/.test(x)) {
      if (!out.includes(x)) out.push(x);
    }
  }
  return out;
}

/** Strip template placeholders — the model can't know our compiled node ids. */
function stripRefs(s: string): string {
  return s.replace(/\{\{[^}]*\}\}/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

function agentData(prompt: string, title: string, model: string, tools: string[]) {
  return {
    title: title || "Step",
    prompt,
    model,
    cwd: "",
    allowedTools: tools,
    permissionMode: "dontAsk" as const,
    continueFrom: null,
    retry: { max: 1, backoffSec: 60 },
    outputSchema: null,
  };
}

/**
 * Compile one draft into a valid linear Workflow, or null if it has no usable
 * agent step or fails validation. Handoffs between agent steps are wired
 * automatically (each agent after the first receives the previous one's output).
 */
export function compileDraft(draft: WorkflowDraft): Workflow | null {
  const rawSteps = Array.isArray(draft.steps) ? draft.steps.slice(0, MAX_STEPS) : [];
  const nodes: Workflow["nodes"] = [{ id: "start", type: "start", position: { x: 0, y: 150 } }];
  const edges: Workflow["edges"] = [];
  let prev = "start";
  let prevAgentId: string | null = null;
  let x = 240;
  let agentCount = 0;
  let i = 0;

  for (const s of rawSteps) {
    const kind = s.kind ?? (s.message && !s.prompt ? "approval" : "agent");
    const id = `${kind === "agent" ? "step" : kind === "wait" ? "wait" : "gate"}-${i}`;

    if (kind === "wait") {
      nodes.push({ id, type: "wait", position: { x, y: 165 }, data: { mode: "limitReset" } });
    } else if (kind === "approval") {
      const message = stripRefs(String(s.message ?? s.title ?? "Approve to continue.")) || "Approve to continue.";
      nodes.push({ id, type: "approval", position: { x, y: 165 }, data: { message } });
    } else {
      let prompt = stripRefs(String(s.prompt ?? ""));
      if (!prompt) continue; // agent with no prompt is useless — skip it
      if (prevAgentId) prompt += `\n\nPrevious step output:\n{{steps.${prevAgentId}.output}}`;
      nodes.push({
        id,
        type: "agent",
        position: { x, y: 120 },
        data: agentData(prompt, String(s.title ?? "Step"), normModel(s.model), normTools(s.tools)),
      });
      prevAgentId = id;
      agentCount++;
    }
    edges.push({ id: `e-${prev}-${id}`, source: prev, target: id });
    prev = id;
    x += 280;
    i++;
  }

  if (agentCount === 0) return null; // nothing to run

  const endId = "end";
  nodes.push({ id: endId, type: "end", position: { x, y: 150 } });
  edges.push({ id: `e-${prev}-${endId}`, source: prev, target: endId });

  const wf: Workflow = {
    nocturne: 1,
    id: newId(),
    name: String(draft.name ?? "Suggested workflow").slice(0, 80).trim() || "Suggested workflow",
    description: stripRefs(String(draft.description ?? "")).slice(0, 400),
    params: [],
    nodes,
    edges,
  };

  try {
    return normalizeOrThrow(wf);
  } catch {
    return null; // a malformed draft never reaches the user
  }
}

/** Pull a `{ workflows: [...] }` object out of model output (tolerates fences / prose). */
export function parseDrafts(text: string): WorkflowDraft[] {
  if (!text) return [];
  const tryParse = (s: string): WorkflowDraft[] | null => {
    try {
      const o = JSON.parse(s) as unknown;
      if (Array.isArray(o)) return o as WorkflowDraft[];
      if (o && typeof o === "object" && Array.isArray((o as { workflows?: unknown }).workflows)) {
        return (o as { workflows: WorkflowDraft[] }).workflows;
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  const fenced = text.replace(/```(?:json)?/gi, "```");
  const stripped = fenced.includes("```") ? fenced.split("```").filter(Boolean).join("\n") : fenced;
  const direct = tryParse(stripped.trim());
  if (direct) return direct;
  // fall back to the first {...} or [...] span
  const objStart = stripped.indexOf("{");
  const objEnd = stripped.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    const span = tryParse(stripped.slice(objStart, objEnd + 1));
    if (span) return span;
  }
  const arrStart = stripped.indexOf("[");
  const arrEnd = stripped.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    const span = tryParse(stripped.slice(arrStart, arrEnd + 1));
    if (span) return span;
  }
  return [];
}

function buildSuggestPrompt(digests: SessionDigest[], max: number): string {
  const slim = digests.map((d) => ({
    sessionId: d.sessionId,
    project: d.project,
    gitBranch: d.gitBranch,
    prompts: d.userPrompts,
    tools: d.tools,
    files: d.files,
    commands: d.commands,
    models: d.models,
  }));
  return [
    RETRACE_SENTINEL,
    "You design unattended workflows for Nocturne, a runner that executes multi-step Claude Code",
    "pipelines durably (each step is a fresh subagent; runs survive restarts and wait out usage",
    "limits). Below are digests of the user's recent Claude Code sessions: their prompts, the",
    "tools/files/commands each session touched, and the models used.",
    "",
    "Your job: mine these sessions for ROUTINES — recurring shapes of work the user does by hand",
    "and would want executed the same careful way every time, even at 3am. Then express each",
    "routine as a pipeline of steps.",
    "",
    "What qualifies as a routine worth suggesting:",
    "- It recurs (same shape appears in 2+ sessions), OR it's one session whose shape is clearly",
    "  periodic work: a release checklist, a client deliverable, a review pass, a content pipeline.",
    "- It decomposes into 2–6 steps with a natural order (investigate → change → verify → ship).",
    "- Sloppiness costs something (a client sees it, tests break, a release goes out wrong) —",
    "  that's what makes 'get it right every time' valuable.",
    "What does NOT qualify: one-off debugging archaeology, exploratory poking, anything you'd",
    "have to invent details for that the sessions don't show. Zero suggestions is an acceptable",
    "answer; a generic filler workflow is not.",
    "",
    "Writing the steps — this is where quality lives:",
    "- Each step's prompt goes to a FRESH agent with no memory of these sessions and no chat",
    "  context. Fold in the specifics the sessions reveal: real directory/module names, the",
    "  actual test command they ran, the framework in play. A prompt that would work on any",
    "  repo is too vague to be one of these steps.",
    "- Give every step a definition of done it can check itself against ('all tests pass',",
    "  'the doc builds with no warnings'), not just an activity.",
    "- Do NOT write {{placeholders}} or refer to 'the previous step' — Nocturne pipes each",
    "  step's output into the next automatically.",
    "- Models: haiku for reading/verifying/summarizing; sonnet for implementation; opus only",
    "  when a step needs real judgment (architecture, tricky review). Cheap where cheap works.",
    "- Tools: grant the minimum that step needs, from: Read, Edit, Write, Bash, Grep, Glob,",
    "  WebSearch, WebFetch. A read/analysis step gets no Write/Bash.",
    "- Insert { \"kind\": \"wait\" } between heavy phases when the whole routine plausibly",
    "  outlasts a usage window; insert { \"kind\": \"approval\" } (with a message saying exactly",
    "  what to check) before anything irreversible or outward-facing: commits, pushes,",
    "  deploys, sends.",
    "",
    "Name each workflow as the routine it performs — specific and verb-shaped ('Ship the weekly",
    "client build', not 'Development workflow'). The rationale must point at the evidence:",
    "which sessions show this pattern and why automating it pays.",
    "",
    `Suggest at most ${max}; if two candidates are near-duplicates, merge them. Return ONLY a`,
    "JSON object, no prose, exactly this shape:",
    '{ "workflows": [ {',
    '  "name": "short verb-shaped title",',
    '  "description": "one line: what it does end to end",',
    '  "rationale": "the evidence: which sessions show this, and why automating it pays",',
    '  "sourceSessions": ["<sessionId>"],',
    '  "steps": [',
    '    { "kind": "agent", "title": "...", "prompt": "self-contained instruction with a definition of done", "model": "haiku|sonnet|opus|inherit", "tools": ["Read","Edit","Bash"] },',
    '    { "kind": "wait" },',
    '    { "kind": "approval", "message": "exactly what to check before continuing" }',
    "  ]",
    "} ] }",
    "",
    "Sessions:",
    JSON.stringify(slim),
  ].join("\n");
}

export interface SuggestGenOptions {
  runner: ClaudeRunner;
  digests: SessionDigest[];
  cwd: string;
  model?: string;
  timeoutMs?: number;
  max?: number;
}

export interface SuggestGenResult {
  suggestions: WorkflowSuggestion[];
  cost: number;
  raw: string;
  error?: string;
}

/** Core generation: prompt -> model -> parse -> compile -> validate. */
export async function suggestWorkflows(opts: SuggestGenOptions): Promise<SuggestGenResult> {
  const max = Math.max(1, Math.min(opts.max ?? 5, 12));
  if (!opts.digests.length) return { suggestions: [], cost: 0, raw: "" };

  const prompt = buildSuggestPrompt(opts.digests, max);
  const model = opts.model && opts.model !== "inherit" ? opts.model : undefined;
  const res = await opts.runner.run({
    prompt,
    model,
    cwd: opts.cwd,
    allowedTools: [],
    permissionMode: "dontAsk",
    timeoutMs: opts.timeoutMs ?? 120_000,
  });

  if (res.isError) {
    const msg = res.text?.trim() || (res.timedOut ? "the suggestion agent timed out" : "the suggestion agent failed");
    return { suggestions: [], cost: res.costUsd ?? 0, raw: res.text ?? "", error: msg };
  }

  const drafts = parseDrafts(res.text);
  const suggestions: WorkflowSuggestion[] = [];
  for (const d of drafts) {
    if (suggestions.length >= max) break;
    const wf = compileDraft(d);
    if (!wf) continue;
    const sources = Array.isArray(d.sourceSessions)
      ? (d.sourceSessions.filter((s) => typeof s === "string") as string[])
      : [];
    suggestions.push({ workflow: wf, rationale: String(d.rationale ?? "").slice(0, 400), sourceSessions: sources });
  }
  return { suggestions, cost: res.costUsd ?? 0, raw: res.text ?? "" };
}

// ---- daemon-facing orchestration ----

export interface SuggestRequest {
  hours?: number;
  max?: number;
  projectRoot?: string;
}

export interface SuggestResult {
  suggestions: WorkflowSuggestion[];
  sessionsScanned: number;
  windowHours: number;
  cost: number;
  /** friendly explanation when there's nothing to show (no sessions, agent error, …). */
  note?: string;
}

export interface Suggester {
  suggest(req: SuggestRequest): Promise<SuggestResult>;
}

async function pickCwd(projectRoot: string | undefined, fallback: string): Promise<string> {
  if (projectRoot) {
    const st = await fs.stat(projectRoot).catch(() => null);
    if (st?.isDirectory()) return projectRoot;
  }
  return fallback;
}

/** Ties session-gathering and generation together for the daemon. */
export class WorkflowSuggester implements Suggester {
  constructor(
    private opts: {
      runner: ClaudeRunner;
      sessionsDir?: string;
      model?: string;
      now?: () => number;
      defaultCwd?: string;
    },
  ) {}

  async suggest(req: SuggestRequest): Promise<SuggestResult> {
    const hours = Math.max(1, Math.min(Math.floor(req.hours ?? 24), 168));
    const now = this.opts.now?.() ?? Date.now();
    const digests = await gatherRecentSessions({ hours, now, dir: this.opts.sessionsDir });
    if (!digests.length) {
      return { suggestions: [], sessionsScanned: 0, windowHours: hours, cost: 0, note: `No Claude Code sessions found in the last ${hours}h.` };
    }
    const cwd = await pickCwd(req.projectRoot, this.opts.defaultCwd ?? process.cwd() ?? os.homedir());
    const gen = await suggestWorkflows({ runner: this.opts.runner, digests, cwd, model: this.opts.model, max: req.max ?? 5 });
    const note =
      gen.error ??
      (gen.suggestions.length ? undefined : "No repeatable workflows stood out in these sessions.");
    return {
      suggestions: gen.suggestions,
      sessionsScanned: digests.length,
      windowHours: hours,
      cost: gen.cost,
      note,
    };
  }
}
