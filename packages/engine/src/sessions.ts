import { createReadStream, promises as fs } from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

/**
 * Reads Claude Code's local session transcripts and distills each into a compact,
 * privacy-scrubbed digest. This is the input to Retrace — the daemon feeds these
 * digests to a Claude subagent that drafts reusable workflows from what you did.
 *
 * Everything here is local and read-only: the transcripts never leave the machine,
 * and obvious secrets are redacted before a digest is ever built.
 */

/** A compact, shareable summary of one Claude Code session. */
export interface SessionDigest {
  sessionId: string;
  /** Human-readable project label (cwd basename, falling back to the folder slug). */
  project: string;
  cwd?: string;
  gitBranch?: string;
  /** ms epoch of the first/last dated event in the session. */
  startedAt: number;
  endedAt: number;
  /** the user's prompts, truncated + redacted, oldest first (capped). */
  userPrompts: string[];
  /** tool name -> times used (Read, Edit, Bash, Task, …). */
  tools: Record<string, number>;
  /** distinct file paths the session read/edited (capped). */
  files: string[];
  /** distinct shell commands run, truncated (capped). */
  commands: string[];
  /** distinct models used (haiku/sonnet/opus/claude-*). */
  models: string[];
  /** total user+assistant messages (a rough sense of session size). */
  messageCount: number;
}

export interface GatherOptions {
  /** how far back to look, in hours (default 24). */
  hours?: number;
  /** "now" in ms epoch (injectable for tests). */
  now?: number;
  /** the Claude projects directory to scan (defaults to the resolved location). */
  dir?: string;
  /** max sessions to return, newest first (default 40). */
  maxSessions?: number;
  /** max prompts kept per session (default 14). */
  maxPromptsPerSession?: number;
}

const HOUR_MS = 3_600_000;
const MAX_PROMPT_CHARS = 280;
const MAX_FILES = 24;
const MAX_COMMANDS = 20;
const MAX_LINES = 50_000; // hard cap so a pathological transcript can't stall a scan
const MTIME_SLACK_MS = 5 * 60_000;

/**
 * Where Claude Code keeps per-project session transcripts.
 * Overridable for tests/preview via NOCTURNE_SESSIONS_DIR (points straight at the
 * projects dir) or CLAUDE_CONFIG_DIR (the config root; projects live under it).
 */
export function claudeProjectsDir(): string {
  const override = process.env["NOCTURNE_SESSIONS_DIR"];
  if (override) return override;
  const cfg = process.env["CLAUDE_CONFIG_DIR"];
  if (cfg) return path.join(cfg, "projects");
  return path.join(os.homedir(), ".claude", "projects");
}

const SECRET_RES: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(bearer\s+)[a-zA-Z0-9._-]{20,}/gi,
];

/** Mask anything that looks like an API key/token before it enters a digest. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_RES) out = out.replace(re, "«redacted»");
  return out;
}

/** Prompts that are harness/tool noise rather than real user intent. */
function isNoisePrompt(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  return (
    t.startsWith("<") || // <command-name>, <local-command…>, <system-reminder>
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted") ||
    t.startsWith("This session is being continued")
  );
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function tsOf(o: Record<string, unknown>): number | undefined {
  const ts = o["timestamp"];
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Salient hint for a tool_use block: the file, command, or query it acted on. */
function toolTarget(input: unknown): { file?: string; command?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const file =
    (typeof i["file_path"] === "string" && (i["file_path"] as string)) ||
    (typeof i["path"] === "string" && (i["path"] as string)) ||
    (typeof i["notebook_path"] === "string" && (i["notebook_path"] as string)) ||
    undefined;
  const command = typeof i["command"] === "string" ? (i["command"] as string) : undefined;
  return { file: file || undefined, command };
}

/**
 * Distill one `.jsonl` transcript into a SessionDigest, or null if the session
 * ended before `sinceMs` (outside the window) or contained nothing usable.
 */
export async function digestTranscript(
  file: string,
  opts: { sinceMs: number; slug?: string; maxPrompts?: number },
): Promise<SessionDigest | null> {
  const maxPrompts = opts.maxPrompts ?? 14;
  const prompts: string[] = [];
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  const commands = new Set<string>();
  const models = new Set<string>();
  let sessionId = "";
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = 0;
  let messageCount = 0;
  let lines = 0;

  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const raw of rl) {
      if (++lines > MAX_LINES) break;
      const line = raw.trim();
      if (!line) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = o["type"];
      if (type !== "user" && type !== "assistant") continue;
      if (o["isSidechain"] === true) continue; // subagent internal chatter

      const ts = tsOf(o);
      if (ts !== undefined) {
        if (ts < startedAt) startedAt = ts;
        if (ts > endedAt) endedAt = ts;
      }
      if (!sessionId && typeof o["sessionId"] === "string") sessionId = o["sessionId"] as string;
      if (!cwd && typeof o["cwd"] === "string") cwd = o["cwd"] as string;
      if (!gitBranch && typeof o["gitBranch"] === "string" && o["gitBranch"]) gitBranch = o["gitBranch"] as string;

      const message = (o["message"] ?? {}) as Record<string, unknown>;

      if (type === "user") {
        const content = message["content"];
        if (typeof content === "string") {
          messageCount++;
          if (!isNoisePrompt(content) && prompts.length < maxPrompts) {
            prompts.push(clip(redactSecrets(content), MAX_PROMPT_CHARS));
          }
        }
        continue;
      }

      // assistant
      messageCount++;
      if (typeof message["model"] === "string" && message["model"] !== "<synthetic>") {
        models.add(message["model"] as string);
      }
      const blocks = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
      for (const b of blocks) {
        if (b["type"] !== "tool_use" || typeof b["name"] !== "string") continue;
        const name = b["name"] as string;
        tools[name] = (tools[name] ?? 0) + 1;
        const { file: f, command } = toolTarget(b["input"]);
        if (f && files.size < MAX_FILES) files.add(f);
        if (command && commands.size < MAX_COMMANDS) commands.add(clip(redactSecrets(command), 100));
      }
    }
  } finally {
    rl.close();
  }

  if (endedAt === 0 || endedAt < opts.sinceMs) return null; // no dated activity, or too old
  if (prompts.length === 0 && Object.keys(tools).length === 0) return null; // nothing to learn from

  const slug = opts.slug ?? "";
  const project = (cwd && path.basename(cwd)) || slugToLabel(slug) || "project";
  return {
    sessionId: sessionId || path.basename(file, ".jsonl"),
    project,
    cwd,
    gitBranch,
    startedAt: Number.isFinite(startedAt) ? startedAt : endedAt,
    endedAt,
    userPrompts: prompts,
    tools,
    files: [...files],
    commands: [...commands],
    models: [...models],
    messageCount,
  };
}

/** Best-effort readable name from a "D--Coding-Projects-My-Repo" folder slug. */
function slugToLabel(slug: string): string {
  if (!slug) return "";
  const parts = slug.split("-").filter(Boolean);
  return parts.slice(-3).join(" ") || slug;
}

/**
 * Scan the Claude projects directory and return digests for sessions active within
 * the last `hours`, newest first. Files untouched since the window are skipped by
 * mtime before they're ever opened.
 */
export async function gatherRecentSessions(opts: GatherOptions = {}): Promise<SessionDigest[]> {
  const now = opts.now ?? Date.now();
  const sinceMs = now - (opts.hours ?? 24) * HOUR_MS;
  const dir = opts.dir ?? claudeProjectsDir();
  const maxSessions = opts.maxSessions ?? 40;
  const maxPrompts = opts.maxPromptsPerSession ?? 14;

  let slugs: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  // collect candidate files (mtime within window) across all projects
  const candidates: Array<{ file: string; slug: string; mtime: number }> = [];
  for (const slug of slugs) {
    const projDir = path.join(dir, slug);
    let names: string[] = [];
    try {
      names = await fs.readdir(projDir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = path.join(projDir, n);
      try {
        const st = await fs.stat(file);
        if (st.isFile() && st.mtimeMs >= sinceMs - MTIME_SLACK_MS) {
          candidates.push({ file, slug, mtime: st.mtimeMs });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  const out: SessionDigest[] = [];
  for (const c of candidates) {
    if (out.length >= maxSessions) break;
    try {
      const d = await digestTranscript(c.file, { sinceMs, slug: c.slug, maxPrompts });
      if (d) out.push(d);
    } catch {
      /* skip unreadable transcript */
    }
  }

  out.sort((a, b) => b.endedAt - a.endedAt);
  return out.slice(0, maxSessions);
}
