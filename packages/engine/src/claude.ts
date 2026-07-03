import spawn from "cross-spawn";
import type { ClaudeRunOptions, ClaudeResult, ClaudeRunner, ClaudeActivity } from "./types.js";

/**
 * Env keys (matched case-insensitively) that break subscription auth, MITM the child,
 * or leak a parent Claude session into it. Includes proxy vars and custom headers that
 * could reroute or override OAuth auth the same way a poisoned base URL would.
 */
const STRIP_EXACT_CI = new Set([
  "anthropic_base_url", // a poisoned proxy/base url here causes 401s (verified empirically)
  "anthropic_api_key", // force subscription (OAuth) auth, never API-key metering
  "anthropic_auth_token",
  "anthropic_custom_headers", // could inject Authorization/x-api-key overriding subscription auth
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "baggage",
  "ai_agent",
]);

/** Prefixes stripped wholesale. Note: we deliberately keep CLAUDE_CONFIG_DIR (finds credentials). */
const STRIP_PREFIX = ["CLAUDE_CODE_", "CLAUDECODE"];

/** Build a clean child environment for spawning the official claude binary. */
export function sanitizeEnv(
  base: NodeJS.ProcessEnv,
  opts: { oauthToken?: string } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_EXACT_CI.has(k.toLowerCase())) continue;
    if (STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  if (opts.oauthToken) out["CLAUDE_CODE_OAUTH_TOKEN"] = opts.oauthToken;
  return out;
}

/** Compose the argv for `claude -p` from a node's run options. */
export function buildArgs(opts: ClaudeRunOptions): string[] {
  const streaming = typeof opts.onActivity === "function";
  const args = streaming
    ? ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"]
    : ["-p", opts.prompt, "--output-format", "json"];
  if (opts.model && opts.model !== "inherit") args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.allowedTools && opts.allowedTools.length) {
    args.push("--allowedTools", opts.allowedTools.join(" "));
  }
  if (typeof opts.maxBudgetUsd === "number") args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.outputSchema != null) args.push("--json-schema", JSON.stringify(opts.outputSchema));
  return args;
}

/** Pull the result JSON out of the CLI stdout (last parseable JSON object wins). */
export function parseCliJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall back to the last line that parses
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("{") && !s.startsWith("[")) continue;
      try {
        return JSON.parse(s);
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** Short human label for a tool_use block, e.g. "Edit src/foo.ts". */
function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const hint =
    (typeof i["file_path"] === "string" && i["file_path"]) ||
    (typeof i["path"] === "string" && i["path"]) ||
    (typeof i["command"] === "string" && (i["command"] as string).slice(0, 60)) ||
    (typeof i["pattern"] === "string" && i["pattern"]) ||
    (typeof i["query"] === "string" && i["query"]) ||
    "";
  return hint ? `${name} ${hint}` : name;
}

/** Pull activities (text/tool) out of one stream-json event. */
export function extractActivities(event: unknown): ClaudeActivity[] {
  const e = (event ?? {}) as Record<string, unknown>;
  const out: ClaudeActivity[] = [];
  if (e["type"] === "assistant") {
    const message = (e["message"] ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim()) {
        out.push({ kind: "text", text: block["text"] as string });
      } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        out.push({ kind: "thinking", text: block["thinking"] as string });
      } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        out.push({ kind: "tool", text: toolLabel(block["name"] as string, block["input"]) });
      }
    }
  }
  return out;
}

function toResult(
  raw: unknown,
  exitCode: number,
  stderr: string,
  timedOut: boolean,
  spawnError = false,
): ClaudeResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const isError = timedOut || spawnError || o["is_error"] === true || exitCode !== 0 || raw == null;
  return {
    isError,
    apiErrorStatus: typeof o["api_error_status"] === "number" ? (o["api_error_status"] as number) : undefined,
    text: typeof o["result"] === "string" ? (o["result"] as string) : "",
    sessionId: typeof o["session_id"] === "string" ? (o["session_id"] as string) : undefined,
    costUsd: typeof o["total_cost_usd"] === "number" ? (o["total_cost_usd"] as number) : 0,
    raw: raw ?? { stderr, exitCode, timedOut, spawnError },
    exitCode,
    stderr,
    timedOut,
    spawnError,
  };
}

const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB cap on captured output

export class CliClaudeRunner implements ClaudeRunner {
  constructor(
    private claudePath: string,
    private opts: { oauthToken?: string; env?: NodeJS.ProcessEnv } = {},
  ) {}

  run(o: ClaudeRunOptions): Promise<ClaudeResult> {
    const args = buildArgs(o);
    const env = sanitizeEnv(this.opts.env ?? process.env, { oauthToken: this.opts.oauthToken });
    const streaming = typeof o.onActivity === "function";
    return new Promise<ClaudeResult>((resolve) => {
      const child = spawn(this.claudePath, args, {
        cwd: o.cwd,
        env,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      let timedOut = false;
      let settled = false;
      // streaming state
      let lineBuf = "";
      let streamResult: unknown = null;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, o.timeoutMs);

      const handleLine = (line: string) => {
        const s = line.trim();
        if (!s) return;
        let ev: unknown;
        try {
          ev = JSON.parse(s);
        } catch {
          return; // ignore non-JSON noise
        }
        const type = (ev as Record<string, unknown>)["type"];
        if (type === "result") streamResult = ev;
        for (const act of extractActivities(ev)) o.onActivity!(act);
      };

      child.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        if (streaming) {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            handleLine(line);
          }
          // guard against a pathological newline-less stream growing unbounded
          if (lineBuf.length > MAX_BUFFER) lineBuf = lineBuf.slice(-MAX_BUFFER);
        } else if (out.length < MAX_BUFFER) {
          out += chunk;
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (err.length < MAX_BUFFER) err += d.toString();
      });

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (streaming) {
          if (lineBuf.trim()) handleLine(lineBuf);
          resolve(toResult(streamResult, exitCode, err, timedOut));
        } else {
          resolve(toResult(parseCliJson(out), exitCode, err, timedOut));
        }
      };

      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(toResult(null, -1, String(e), timedOut, true));
      });
      child.on("close", (code) => finish(code ?? -1));
    });
  }
}
