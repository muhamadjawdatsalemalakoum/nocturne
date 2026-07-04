# Nocturne — Product & Engineering Spec (v1)

> Working name: **Nocturne**. Design Claude Code workflows on a canvas. Run them while you sleep — durably, locally, on the subscription you already pay for.
> (Name is a placeholder config value; renaming touches `package.json` names and one constants file.)

## 1. Positioning

Anthropic split durability and control across two surfaces that don't overlap:

| Capability | Anthropic cloud (Routines / web) | Anthropic local (CLI / Desktop) | **Nocturne** |
|---|---|---|---|
| Survives session close / laptop sleep | ✅ | ❌ | ✅ |
| Runs in *your* environment (local files, MCP servers, toolchain) | ❌ fresh clone only | ✅ | ✅ |
| Your permission rules, watchable | ❌ | ✅ | ✅ |
| Flat-rate subscription economics | capped + metered overage | ✅ | ✅ |
| Durable multi-step orchestration w/ waits + resume | partial | ❌ | ✅ |
| Visual design surface | ❌ | ❌ | ✅ |

**One-line pitch:** use 100 % of the plan you're already paying for — including the hours you're asleep.

Core insight: *"works on your subscription"* and *"limit-aware auto-resume"* are one feature.
Unattended subscription execution is impossible without an engine that checkpoints, waits out
the 5-hour window reset, and resumes exactly where it stopped. That engine is the product;
the canvas is the on-ramp; the portable workflow file is the network effect.

Non-goals (v1): cloud execution, API-key metering, conditional/LLM-judged branch nodes,
marketplace/gallery hosting, non-Claude agents.

## 2. System overview

Three packages in one npm-workspaces monorepo, plus an e2e suite:

```
packages/core     Pure TS. Workflow schema (zod), validation, import/export,
                  template engine, DAG utilities. Zero runtime deps beyond zod.
packages/engine   The daemon: run executor, checkpoint store, wait scheduler,
                  limit oracle, claude CLI adapter, REST + WebSocket server,
                  CLI entry (`nocturne`). Serves the built UI.
packages/ui       The canvas: Vite + React + @xyflow/react. Infinite Figma-style
                  canvas, inspector, run visualization, import/export UX.
e2e/              Playwright tests driving daemon + UI + fake-claude together.
```

Runtime requirements: Node ≥ 20, Claude Code CLI installed and logged in.
Default port **5151** (`nocturne serve` → `http://localhost:5151`).
State root: `~/.nocturne/` (override: `NOCTURNE_HOME`, used by all tests).

```
~/.nocturne/
  config.json            # claudePath, maxConcurrent, webhookUrl, autoResumeOnStart…
  workflows/<id>.json    # saved library (same format as export)
  runs/<runId>/
    state.json           # canonical checkpoint (atomic tmp+rename writes)
    events.ndjson        # append-only event log (drives UI timeline + audit)
    steps/<nodeId>.json  # per-step record: prompt sent, output, sessionId, cost, timings
```

## 3. Workflow file format v1 (`*.nocturne.json`)

The exported file **is** the library format **is** the canvas document. One format everywhere.

```jsonc
{
  "nocturne": 1,                     // format version (int). Loaders reject > known.
  "id": "uuid",
  "name": "Overnight refactor",
  "description": "…",
  "params": [                        // fill-in-at-run-time inputs → {{params.x}}
    { "name": "ticket", "description": "Issue to fix", "default": "" }
  ],
  "nodes": [
    { "id": "start",  "type": "start", "position": {"x":0,"y":0} },

    { "id": "n1", "type": "agent", "position": {"x":220,"y":0},
      "data": {
        "title": "Implement fix",
        "prompt": "Fix {{params.ticket}}. Prior analysis:\n{{steps.n0.output}}",
        "model": "sonnet",           // 'inherit' | 'haiku' | 'sonnet' | 'opus' | full model id
        "effort": "high",            // optional: low|medium|high|xhigh|max
        "cwd": "",                   // RELATIVE to projectRoot chosen at run time
        "allowedTools": ["Edit", "Write", "Bash(npm *)"],
        "permissionMode": "dontAsk", // default; see §6 security
        "maxBudgetUsd": 2,           // optional hard cap (maps to --max-budget-usd)
        "continueFrom": null,        // nodeId → chain that step's claude session (--resume)
        "retry": { "max": 1, "backoffSec": 60 },
        "outputSchema": null         // optional JSON schema (maps to --json-schema)
      } },

    { "id": "w1", "type": "wait", "position": {"x":440,"y":0},
      "data": { "mode": "limitReset" } },
      // modes: duration {minutes} | until {time:"02:00"} next occurrence, local | limitReset

    { "id": "g1", "type": "approval", "position": {"x":660,"y":0},
      "data": { "message": "Review the diff before push step runs." } },

    { "id": "end", "type": "end", "position": {"x":880,"y":0} }
  ],
  "edges": [ { "id": "e1", "source": "start", "target": "n1" }, … ]
}
```

**Graph semantics**
- Directed acyclic graph. Cycles are a validation error.
- Multiple outgoing edges = parallel fan-out. Multiple incoming = AND-join
  (node becomes eligible when **all** upstream steps succeeded).
- Exactly one `start`. ≥ 1 `end` reachable. Unreachable nodes = validation warning.
- `position` is canvas-only; engine ignores it.

**Portability rules (enforced by validator on export/import)**
- No absolute paths anywhere (`cwd` must be relative; empty = projectRoot).
- No secrets: export scans prompts for high-entropy token patterns and warns.
- Models are aliases or explicit ids; unknown aliases fail validation with a clear message.
- Everything a run needs that is machine-specific (projectRoot, param values) is
  supplied at run time, never stored in the file.

**Template engine** — `{{steps.<nodeId>.output}}`, `{{params.<name>}}`,
`{{workflow.name}}`, `{{run.projectRoot}}`. Unknown references = validation error
at save time, not silent empty string at run time.

## 4. Execution semantics

### Run lifecycle

```
queued → running → completed
              ├→ waiting_timer     (wait node, or limit-reset wait)
              ├→ waiting_approval  (approval node)
              ├→ paused            (user pause / non-retryable step failure)
              ├→ failed            (unrecoverable, after retries)
              └→ canceled
interrupted (daemon died mid-run; set on startup scan) → auto-resume if configured
```

Step statuses: `pending | eligible | running | succeeded | failed | skipped | waiting`.

Every transition appends to `events.ndjson` and atomically rewrites `state.json`
(write tmp file → rename). A crash at any instant loses at most the in-flight step,
which re-runs on resume. This is the checkpoint guarantee.

### Step execution (agent nodes)

The engine composes the prompt: workflow header (name, step title) + resolved
templates (upstream outputs injected) + the node prompt. Then spawns the **official
claude binary** (path from config, discovered via `where`/`which` at first launch):

```
claude -p "<composed prompt>"
  --output-format json
  --model <node model, unless inherit>
  [--effort <level>] [--resume <sessionId>] [--allowedTools …]
  --permission-mode <node mode>
  [--max-budget-usd <n>] [--json-schema <schema>]
```

- **Never `--bare`** — verified on CLI v2.1.144: `--bare` disables OAuth/keychain
  auth entirely, which would break subscription execution.
- **Sanitized child environment** — verified empirically (2026-07-02): a poisoned
  `ANTHROPIC_BASE_URL` from a parent process causes 401s. The adapter strips:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `BAGGAGE`,
  `AI_AGENT`, and all `CLAUDECODE*` / `CLAUDE_CODE_*` / `CLAUDE_*` session vars,
  then injects `CLAUDE_CODE_OAUTH_TOKEN` iff the user configured one (see §5 auth).
- Spawn via `cross-spawn` (Windows `.cmd` shim safety), `cwd` = projectRoot + node.cwd,
  `windowsHide`, stdout/stderr captured with a size cap (2 MB) and a step timeout
  (default 30 min, per-node override).
- The JSON result (`result`, `session_id`, `total_cost_usd`, `usage`, `is_error`,
  `api_error_status`) is persisted verbatim to `steps/<nodeId>.json`.

**Context model:** each step is a fresh context window by default (handoff = template
injection of upstream outputs). `continueFrom: <nodeId>` instead resumes that step's
`session_id` (`--resume`), carrying full conversational context. Both appear in the UI
as an explicit toggle on the node.

**Parallelism:** engine-wide `maxConcurrent` (default 2 — rate-limit-friendly).
Eligible steps queue FIFO.

### Error taxonomy (the heart of durability)

| Class | Detection | Action |
|---|---|---|
| Rate limit | `is_error` + message matches limit patterns (see Limit Oracle) | checkpoint → `waiting_timer` with `wakeAt` = parsed reset (+ 2 min jitter) → resume step |
| Auth | `api_error_status` 401/403 | pause run, surface fix instructions (login / setup-token) |
| Budget cap | max-budget error | pause run, surface |
| Transient (5xx/overloaded/network/timeout) | status ≥ 500, spawn error, timeout | retry per node policy w/ backoff; then pause |
| Model refusal / step "failed" semantically | exit 0 but node `outputSchema` unmet | fail step (no retry), pause run |
| Fatal (bad flags, missing binary) | spawn/usage errors | fail run with diagnostic |

### Limit Oracle

Pluggable interface. Detection is **layered**, best signal first (verified against
official docs, 2026):

1. **`statusLine` `rate_limits` (recommended primary, v1.1).** Since Claude Code
   v2.1.80 the statusLine hook receives `rate_limits.five_hour.resets_at` and
   `seven_day.resets_at` as **UNIX epoch seconds** (plus `used_percentage`), derived
   from the `anthropic-ratelimit-unified-5h/7d-*` response headers — **no extra network
   call**. A runner should schedule its durable wake directly off `resets_at`, and can
   pause *proactively* before hitting the wall. Caveat: populated only for Pro/Max and
   only *after the first API response* in a session, so a freshly-blocked run falls back
   to (2). (Source: code.claude.com/docs/en/statusline.)
2. **`ErrorParseOracle` (v1, shipped fallback).** Parses the reset time from the CLI
   limit-error string. The current official format is
   `You've hit your session limit · resets 3:45pm` (also weekly/Opus variants); the
   parser tolerates `resets at 3pm`, `resets 15:30`, ISO, and epoch, and is unit-tested
   against the official format. If nothing parseable → conservative 60-min wait.
   Wording has drifted across versions and reset times have occasionally been *wrong*
   (issues #9236, #8620), so always add a safety margin.

**Do not poll** the unofficial `claude.ai/api/oauth/usage` endpoint: as of ~Mar 2026 it
returns persistent HTTP 429 under polling (issues #31637, #31021) — ccusage removed
`blocks --live` and Claude-Code-Usage-Monitor demoted it to an experimental opt-in over
exactly this. It stays a last-resort, low-frequency `UsageApiOracle` (off by default).

Note: headless `-p` has **no dedicated rate-limit exit code** yet (any non-zero is
ambiguous; the community asks for exit 75 + `--wait-on-limit`), which is precisely the
unmet gap this product fills.

### Wait scheduler

- All waits are persisted as `wakeAt` (ISO) in `state.json` — never in-memory-only.
- Injectable clock (`now()`, `setTimer()`) so unit tests use fake time.
- **Catch-up semantics:** on daemon start (or machine wake), any `wakeAt` in the past
  fires immediately. Sleep/reboot therefore delays but never kills a run. This
  "persist the due-time, re-check on every wake" model is the **reliable cross-platform
  common denominator** — verified: OS scheduler catch-up (launchd `StartCalendarInterval`,
  systemd `Persistent=true`) has real bugs (launchd coalesces missed runs into one;
  systemd catch-up regressions after suspend), so we never trust the scheduler alone.
- Machine-asleep **wake** (v1.1 opt-in `nocturne install-wake`) delegates to the native
  scheduler per OS: Windows Task Scheduler `WakeToRun` + "Allow wake timers"; macOS
  `pmset schedule wake` (root; launchd itself never wakes the Mac); Linux privileged
  systemd timer `WakeSystem=true` / `rtcwake`. **Documented limits (verified):** none can
  power on a *shut-down* machine; Windows **Modern Standby (S0)** laptops — most 2020+
  hardware — do not reliably wake on a timer (the dominant failure mode); wake-from-suspend
  needs root/elevation on macOS & Linux. So v1 ships the honest promise "daemon running +
  machine awake = waits fire; slept-through waits fire on wake," and the wake helper is a
  best-effort tier, not a guarantee.

### Approvals & notifications

Approval node → run enters `waiting_approval`; UI shows Approve / Reject with the
node's message + upstream output; CLI: `nocturne approve <runId>`. Reject = pause.
Notifications: optional `webhookUrl` in config — engine POSTs JSON on
`waiting_approval`, `failed`, `completed` (works with ntfy/Discord/Slack).

## 5. Auth model

**Verified (2026, primary sources):** a runner that spawns the official `claude -p`
binary runs on a Pro/Max **subscription (OAuth)** with **no API key**, drawing from the
flat-rate 5-hour/weekly allowance. Official auth-precedence docs make subscription
`/login` the default when no key is set; an API key is only used in `-p` "when present."
This is the load-bearing fact and it holds.

1. **Default: inherited login.** The engine spawns the official CLI, which reads the
   user's existing claude.ai OAuth session (`claude auth status` →
   `authMethod: "claude.ai", subscriptionType: "max"`). No tokens handled by us.
2. **Recommended for unattended use: `claude setup-token`** — Anthropic's documented,
   subscription-scoped (inference-only) one-year `CLAUDE_CODE_OAUTH_TOKEN`; set for the
   daemon, never written into workflow files.
3. **Spawn the binary, never lift the token.** Executing the official CLI is "ordinary
   use of Claude Code" (per code.claude.com/docs/en/legal-and-compliance). What Anthropic
   banned in Jan 2026 (formalized Feb 19) is *third parties extracting* the OAuth token
   and calling the API while impersonating Claude Code — a categorically different act we
   never do.
4. **Never `--bare`** (verified): it skips OAuth/keychain and *requires* an API key.
   Confirmed by the CLI adapter (`buildArgs` never emits `--bare`).
5. **Billing hygiene (verified caveat).** A recurring bug once billed `-p`-on-OAuth as
   metered API usage (issue #43333, fixed; #37686 caused \$1,800+ charges), and a stray
   `ANTHROPIC_API_KEY` silently switches `-p` to paid API billing — including via a
   subagent env leak (#39903). Our `sanitizeEnv` strips `ANTHROPIC_API_KEY` from the
   whole child process tree; the runner should also surface `total_cost_usd` so a user
   can confirm runs draw from the subscription, not the API.

**Time-sensitive risk:** a paused (not cancelled) June-2026 proposal would move `-p`/Agent-SDK
usage onto a separate metered credit pool; and the blessing is for "ordinary, individual
usage," with enforcement reserved for industrial-scale automation. The economics rest on a
policy Anthropic has signalled it may revise — worth stating plainly in the README.

## 6. Security

- Imported workflows open a **review dialog** before entering the library: name,
  node count, every prompt, model, tool grants, cwd values. Nothing imported runs
  without the user seeing what it may touch.
- Default `permissionMode: "dontAsk"` (deny anything not allowlisted) with an empty
  `allowedTools` — a fresh agent node can *read* the repo but not mutate it until the
  user grants tools in the inspector. `bypassPermissions` is behind a per-node
  "I understand" toggle rendered in warning color.
- Workflow files carry no secrets, no absolute paths (validator-enforced).
- Server binds `127.0.0.1` only.

## 7. Server API (daemon, port 5151)

REST (JSON):
```
GET    /api/health                        → {version, claudePath, authStatus}
GET    /api/workflows                     → library list
POST   /api/workflows                     → create/save (validated)
GET    /api/workflows/:id
PUT    /api/workflows/:id
DELETE /api/workflows/:id
POST   /api/workflows/import              → validate + return review summary
GET    /api/workflows/:id/export          → download .nocturne.json
POST   /api/runs                          → {workflowId, projectRoot, params} → start
GET    /api/runs?workflowId=…             → run list (status, cost, timings)
GET    /api/runs/:id                      → full state incl. steps
POST   /api/runs/:id/pause|resume|cancel
POST   /api/runs/:id/approve              → {nodeId, approved, note}
POST   /api/suggest                       → {hours?, max?, projectRoot?} → Retrace (§8)
```
WebSocket `/ws`: server pushes `{type: run.updated|step.updated|run.log, …}` —
drives live canvas run-mode. No client→server commands over WS (REST only).

## 8. Retrace — drafting workflows from your history

**Goal.** Lower the blank-canvas barrier: instead of designing a workflow from scratch, let
Nocturne read what you already did and propose reusable pipelines. Something that worked once —
a client fix, a refactor→test loop, a review pass — becomes a saved workflow you can run
perfectly every time, including on the days you're not focused.

**Data source.** Claude Code writes every session to `~/.claude/projects/<slug>/<id>.jsonl`,
one JSON event per line (`user` prompts, `assistant` messages with `tool_use` blocks + `model`,
`timestamp`, `cwd`, `gitBranch`). Retrace reads these **locally, read-only**. Resolution order
for the projects dir: `NOCTURNE_SESSIONS_DIR` → `CLAUDE_CONFIG_DIR/projects` → `~/.claude/projects`
(the first two exist for tests/preview).

**Pipeline** (`packages/engine/{sessions,suggest}.ts`):
1. **Scan** — `gatherRecentSessions` lists candidate transcripts by mtime within the window
   (default 24 h, clamped 1–168) before opening any file; skips the rest.
2. **Distill** — `digestTranscript` streams each file line-by-line (bounded) into a compact
   `SessionDigest`: redacted+truncated user prompts (harness/sidechain noise dropped), tool
   histogram, files touched, commands run, models used, timing. A session whose last event
   predates the window is discarded.
3. **Redact** — obvious secrets (`sk-ant-…`, `sk-…`, `AKIA…`, `gh[pousr]_…`, bearer tokens)
   are masked in every digest **before** anything is sent to the model.
4. **Draft** — `suggestWorkflows` builds one meta-prompt (prefixed with the `NOCTURNE_RETRACE_V1`
   sentinel), runs it through the same subscription-auth CLI adapter the engine uses (no tools,
   `dontAsk`), and asks for workflow *intent* as JSON.
5. **Compile & validate** — the model never sets ids/positions/edges. `compileDraft` builds a
   positioned, wired, linear graph, auto-injects step handoffs (`{{steps.<prev>.output}}`),
   strips any model-authored placeholders, and runs it through `normalizeOrThrow`. Invalid
   drafts are dropped, so every suggestion is a runnable, portable `.nocturne.json`.

**Privacy & auth.** Transcripts never leave the machine except as the redacted digest sent to
your own Claude subscription (the same call any Claude Code usage makes). No API-key metering; the
child env is sanitized identically to run steps.

**UI.** A **Retrace** button in the toolbar opens a modal that POSTs `/api/suggest` and lists
each suggestion (name, description, rationale, step count) with **Open on canvas** and **Save to
library**. Empty/error states carry a friendly note (no recent sessions, agent hit a limit, …).

## 9. MCP integration

**Goal.** Make the daemon drivable from any MCP client — Claude Desktop, Claude Code, Cursor —
without moving durable state out of the daemon. A run started from a chat must survive that chat
ending, so the MCP layer is a *control surface*, never the engine.

**Shape (`@nocturne/mcp`).** A stdio MCP server (the transport every client supports) that is a
**thin adapter**: each tool forwards to the daemon's REST API over `localhost` (`NOCTURNE_DAEMON_URL`,
default `127.0.0.1:5151`). MCP clients spawn the stdio server as a *per-session subprocess* and kill
it on exit (per the MCP spec), so it holds no state — the daemon does. That per-session lifecycle is
exactly why durable state can't live in the MCP layer.

**Tools (12).** `nocturne_status`, `list_workflows`, `get_workflow`, `save_workflow`, `run_workflow`
(returns a `runId` and returns immediately — the run continues unattended), `list_runs`, `get_run`
(poll status / per-step output / cost), `approve_step`, `pause_run` / `resume_run` / `cancel_run`,
`suggest_workflows` (Retrace, §8). Handlers return text and surface daemon / validation / timeout
failures as tool errors (`isError`) — never crashing the JSON-RPC stream. **stdout carries only the
protocol; all logging is on stderr.** Per-request timeouts (45 s; 5 min for the CLI-bound suggest) and
a response-size cap guard against a hung or misbehaving daemon.

**Auth is unchanged.** The daemon still spawns the official `claude` CLI, so runs draw from the
subscription (§5); the MCP layer changes nothing about billing.

**Packaging.**
- **Claude Code:** `claude mcp add nocturne -- node …/nocturne-mcp.mjs`, or the plugin
  (`.claude-plugin/plugin.json` + `.mcp.json`) which also bundles a `nocturne` skill.
- **Claude Desktop:** a `claude_desktop_config.json` entry today, or a `.mcpb` Desktop Extension
  (`server.type: "node"`) packed with the official `@anthropic-ai/mcpb` tool.
- **Roadmap:** publish `@nocturne/mcp` to npm (activates the plugin's `npx` path); co-host an `/mcp`
  Streamable-HTTP endpoint on the daemon for HTTP-capable clients; a Rust single-binary rewrite for
  zero-Node distribution + robust Windows subprocess-tree control.

Install steps: [integrations/README.md](integrations/README.md).

## 10. UI spec — the taste requirement

**Stack:** Vite, React 19, TypeScript, `@xyflow/react` (infinite canvas), zustand
(+ zundo for undo/redo), Tailwind v4, lucide-react icons, Inter variable
(bundled via @fontsource-variable — fully offline).

**Layout**
```
┌────────────────────────────────────────────────────────────┐
│ TopBar: name (inline edit) · Import · Export · ⌘Z/⌘⇧Z ·    │
│         zoom controls · ▶ Run (primary)                     │
├─────────┬────────────────────────────────────┬─────────────┤
│ Palette │        Infinite canvas             │ Inspector   │
│ (drag   │  dot-grid, zoom-to-cursor,         │ (selected   │
│  nodes) │  space-drag pan, minimap           │  node)      │
├─────────┴────────────────────────────────────┴─────────────┤
│ Run drawer: timeline of events, per-step output, cost      │
└────────────────────────────────────────────────────────────┘
```

**Canvas feel (Figma-grade checklist)**
- Wheel = zoom to cursor; space+drag / middle-drag = pan; pinch OK.
- Dot grid that fades with zoom; snap-to-grid 8 px; smooth 120 ms ease on fit-view.
- Node cards: 12 px radius, 1 px hairline border (`--n-border`), subtle elevation on
  hover, 2 px accent ring on selection. Model shown as a small chip (haiku = teal,
  sonnet = violet, opus = amber, inherit = neutral). Type icon top-left.
- Edges: 1.5 px bezier, animated dash flow **only** while a run is executing that edge.
- Run mode: step status ring around nodes (neutral → pulsing blue running → green /
  red / amber waiting), live cost ticker in TopBar.
- Micro-interactions ≤ 150 ms; no bounce easings; reduced-motion respected.
- Undo/redo across node/edge/inspector edits (zundo, 100-step history).
- Keyboard: Del remove · ⌘D duplicate · ⌘Z/⌘⇧Z · ⌘S save · ⌘E export · F fit · 1 reset zoom.

**Design tokens (dark default)**
```
--n-bg: #0d0e12       --n-surface: #16181d   --n-border: #262932
--n-text: #e8eaf0     --n-muted: #8b90a0
--n-accent: #7aa2ff   --n-ok: #4ade80  --n-warn: #fbbf24  --n-err: #f87171
type: Inter var; UI 13/20; node title 13 semibold; mono (JetBrains Mono) for outputs
spacing: 4-px base grid; radii: 12 (cards) / 8 (inputs) / 999 (chips)
```
Light theme = same tokens re-mapped; toggle in TopBar. No pure black/white anywhere.

**Import/export UX**
- Export: TopBar button → pretty-printed `.nocturne.json` download; also copy-to-clipboard.
- Import: button **and** drag-a-file-onto-canvas → review dialog (§6) → adds to library.
- Share = the file. README shows the "post your workflow" pattern.

## 11. Testing strategy (TDD)

Layers, all runnable via `npm test` at root:

1. **core unit (vitest):** schema accept/reject fixtures, DAG utils (topo sort, cycle
   & join detection), template resolution incl. unknown-ref errors, import/export
   round-trip = byte-identical, portability validators.
2. **engine unit (vitest):** limit-oracle parser against a fixture corpus of real
   error strings; wait scheduler with fake clock (incl. catch-up after "sleep");
   state-store atomicity (kill-between-writes simulation); env sanitization;
   flag composition per node config; **Retrace** transcript-digest (window filtering,
   secret redaction, malformed-line resilience) and draft compile/validate against a
   fake runner (invalid drafts dropped; no-session → note).
3. **engine integration (vitest):** full runs against **fake-claude** — a Node script
   installed as the configured `claudePath`. Scenario files (JSON) script its
   behavior per invocation: succeed with text, emit rate-limit error with reset time,
   hang (timeout test), return malformed JSON, honor `--resume` by echoing session
   continuity. Asserts: fan-out/join order, checkpoint resume after simulated crash
   (SIGKILL the run mid-step, restart engine, verify resume), limit wait + auto-resume,
   approval gate flow, webhook fired.
4. **server integration (vitest):** REST contract + WS event sequence over a real
   HTTP server on an ephemeral port with `NOCTURNE_HOME` in a temp dir.
   **MCP (§9):** a real MCP `Client` ↔ the Nocturne MCP server ↔ a real daemon (+ fake-claude)
   over the SDK in-memory transport — tools/list, save+list, run-to-completion, error paths,
   Retrace — plus a raw stdio handshake asserting stdout stays protocol-pure.
5. **e2e (Playwright):** drive the real UI against a real daemon + fake-claude:
   build a 3-node workflow on the canvas, set models, save, export, re-import,
   run, watch nodes go green, simulate limit → see waiting state → fake reset →
   completed. Screenshot artifacts on failure.
6. **live smoke (opt-in, `NOCTURNE_LIVE=1`):** 2-step haiku workflow through the real
   CLI. Never runs in CI.
7. **independent audit (`node scripts/audit-e2e.mjs`):** exercises the advertised claims
   through the REAL entry points — boots the daemon via its bin, runs fan-out/params/handoffs,
   SIGKILLs the daemon mid-step and verifies auto-resume after restart, waits out a real-clock
   limit reset, cancels a hanging child (tree-kill), drives Retrace, and completes a run through
   the bundled stdio MCP server. Exits non-zero on any failure.

## 12. Milestones

- **M1 (this build):** everything above marked v1 — core, engine, server, canvas UI,
  import/export, limit-aware waits, approvals, Retrace (§8), the MCP server (§9),
  tests green end to end, live-run verified.
- **M1.1:** Windows wake helper (`install-wake`), `UsageApiOracle`, light theme audit,
  publish `nocturne` + `@nocturne/mcp` to npm, a co-hosted `/mcp` HTTP endpoint,
  README + demo GIF, community-workflows folder.
- **M2:** conditional nodes (LLM-judged with explicit rubric), per-run cost budgets,
  workflow gallery site, macOS/Linux wake helpers.

## 13. Open items

- **Subscription-auth headless run — RESOLVED (verified, sourced).** `claude -p`
  (non-`--bare`) runs on Pro/Max OAuth with no API key and draws from the flat-rate
  allowance; spawning the official binary is permitted "ordinary use," distinct from the
  banned token-extraction pattern. Folded into §5. The one local check the user runs on
  their own machine: `claude -p "say OK" --model haiku` in a plain terminal (it 401s only
  from *inside* a Claude session's process tree, due to host-managed auth).
- **Limit detection — RESOLVED (verified).** Prefer the official statusLine
  `rate_limits.resets_at` epoch (v2.1.80+); fall back to parsing the current official
  error string `… · resets 3:45pm` (now unit-tested); do **not** poll the unofficial
  usage endpoint (429-throttled since Mar 2026). Folded into §4.
- **Durable wake — RESOLVED (verified).** Catch-up-on-wake is the reliable cross-platform
  base; native-scheduler wake is a best-effort v1.1 tier with documented limits (Windows
  Modern-Standby S0 is the dominant failure mode; can't power on a shut-down machine).
  Folded into §4.
- Remaining unknowns (flagged, not blocking): exact headless usage-limit JSON `subtype`,
  and Apple-Silicon `pmset` scheduled-wake reliability — capture real samples during the
  M1.1 wake-helper work; the oracle is defensive by design.
