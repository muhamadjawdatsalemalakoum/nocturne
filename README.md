# Nocturne

**Design multi-agent Claude Code workflows on a canvas. Run them while you sleep — durably, locally, on the subscription you already pay for.**

🌐 **[nocturne website & walkthrough →](https://muhamadjawdatsalemalakoum.github.io/nocturne/)**

Nocturne is a local-first workflow runner for [Claude Code](https://code.claude.com). You lay out a
multi-step agent pipeline on an infinite canvas — pick the model per step, drop in timed waits and
approval gates — then hit **Run**. Each step executes as its own Claude Code subagent, in its own
context, and hands its output to the next. If a run hits your usage limit at 2am, it **checkpoints,
waits for the window to reset, and resumes exactly where it stopped.**

![A Nocturne run paused on a usage-limit-reset wait, ready to resume](docs/images/07-waiting-reset.png)

## Why it exists

Anthropic split durability and control across two surfaces that don't overlap:

| | Anthropic cloud (Routines / web) | Anthropic local (CLI / Desktop) | **Nocturne** |
|---|---|---|---|
| Survives session close / sleep | ✅ | ❌ | ✅ |
| Runs in *your* environment (local files, MCP servers, toolchain) | ❌ fresh clone | ✅ | ✅ |
| Your permission rules, watchable | ❌ autonomous | ✅ | ✅ |
| Flat-rate subscription economics | capped + metered | ✅ | ✅ |
| Durable multi-step orchestration with waits + resume | partial | ❌ | ✅ |
| Visual design surface | ❌ | ❌ | ✅ |

Native Claude Code workflows are autonomous **within a session** but die on exit, can't durably wait,
and can't pause for input and resume. Nocturne is the durability layer on top: **durable where the
native runtime is fragile, local where the cloud isn't, flat-rate where every other orchestrator meters
tokens** — with a canvas that has taste.

The hero feature and the economics are the same feature: unattended subscription execution is only
possible with an engine that checkpoints, waits out the reset, and resumes. That's the whole point.

## A full run, start to finish

**1. Start from a blank canvas and a library of one-click templates.**

![The empty canvas with the template picker](docs/images/01-canvas.png)

**2. One click builds a whole pipeline — then tune each step with options, not typing.** Model is a
segmented control; prompts have one-tap starters; tools are preset bundles plus toggle chips;
permissions are a plain-language dropdown, with the rarely-needed knobs behind *Advanced*.

![The options-first inspector](docs/images/03-inspector.png)

**3. Hit Run (it uses your existing `claude` login) and watch every agent work, live** — files read
and edited, commands run, cost ticking up, streamed onto the node and into the run panel.

![A live streaming run](docs/images/05-running.png)

**4. If it hits your usage limit, it holds on a limit-reset wait and resumes on its own** — the hero
feature. Come back to a completed pipeline, every step green with its output and total cost.

![A completed run](docs/images/06-completed.png)

Other journeys — **human approval gates** ([08](docs/images/08-approval.png)), the **import review
dialog** that shows what a shared workflow can do before it runs
([09](docs/images/09-import-review.png)), and the **Figma-style minimizable panels**
([10](docs/images/10-minimized.png)) — are on the [website](https://muhamadjawdatsalemalakoum.github.io/nocturne/).

## Quick start

```bash
npm install
npm run build:ui          # build the canvas
npm run serve             # start the daemon → http://localhost:5151
```

Open http://localhost:5151, design a workflow, and press **Run**. The daemon runs through your existing
`claude` login. For unattended runs that survive closing your terminal, set up a long-lived token:

```bash
claude setup-token        # then put it in ~/.nocturne/config.json as "oauthToken"
```

## The workflow format (`*.nocturne.json`)

The exported file **is** the canvas document **is** the library entry — one portable format everywhere.
Export it, commit it, post it on Reddit; anyone can import and run it. Files carry no absolute paths and
no secrets (the validator enforces both), so they move between machines cleanly.

Node types: `start` · `agent` (per-step model, tools, cwd, permission mode, retry, session continuation) ·
`wait` (`duration` / `until HH:MM` / `limitReset`) · `approval` · `end`. Fan-out = multiple outgoing
edges; AND-join = multiple incoming edges. Prompts hand off with `{{steps.<id>.output}}` and take run
inputs via `{{params.name}}`.

See [SPEC.md](SPEC.md) for the full format, execution semantics, and architecture.

## Architecture

```
packages/core     Pure TS: schema (zod), validation, DAG utils, template engine, import/export.
packages/engine   The daemon core: run executor, crash-safe checkpoint store, wait scheduler,
                  limit oracle, the claude CLI adapter (env sanitization + spawn), REST + WS.
packages/server   Express + ws daemon; serves the UI and the API.
packages/ui       Vite + React + React Flow infinite canvas.
e2e/              Playwright: drives the real UI against the daemon + a scripted fake claude.
```

Key design points:
- **Subscription auth.** The engine spawns the *official* `claude` binary (never extracts tokens), so it
  runs on your plan. It sanitizes the child environment to remove vars that break subscription auth.
- **Durable by construction.** Every state transition is an atomic checkpoint plus an append-only event
  log. A crash re-runs at most the in-flight step. Waits persist as absolute wake times, so a
  slept-through timer fires on the next wake (catch-up), never lost.
- **Limit-aware.** When a step hits the usage limit, the run suspends into `waiting_timer` with the
  parsed reset time and auto-resumes — the rate limit doesn't count as a failed attempt.
- **Realtime preview.** Steps run in streaming mode (`--output-format stream-json`); the engine parses
  each assistant text delta and tool call and pushes it over the WebSocket, so the canvas and run drawer
  show what every agent is doing live, as it happens.
- **Concurrency-safe.** All state mutations serialize through a per-run lock and persist as per-step
  read-modify-write merges, so pausing/approving/canceling a run never races the executing steps.

## Development

```bash
npm test                                   # full unit + integration suite (vitest)
npm run typecheck                          # core/engine/server
npm --workspace @nocturne/ui run typecheck # UI
npx playwright test --config e2e/playwright.config.ts   # end-to-end
npm --workspace @nocturne/ui run dev       # UI dev server (proxies /api to the daemon)
```

The engine and server are tested against a scripted **fake claude** fixture that emulates
`claude -p --output-format json` — so rate-limit → wait → resume, crash recovery, approvals, and
fan-out/join are all verified deterministically without touching a real subscription.

## Status

v1: canvas, engine, durable limit-aware waits, approvals, import/export, full test suite green.
Roadmap: OS-level wake helpers for machine-asleep waits, conditional nodes, a shared workflow gallery.

## License

[MIT](LICENSE). Not affiliated with Anthropic; "Claude" and "Claude Code" are trademarks of Anthropic.
