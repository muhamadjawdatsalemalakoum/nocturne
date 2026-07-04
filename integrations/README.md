# Drive Nocturne from Claude (MCP)

Nocturne ships an **MCP server** (`@nocturne/mcp`) so you can design, launch, and monitor durable
workflows **conversationally** — from Claude Code, Claude Desktop, Cursor, or any MCP client —
instead of (or alongside) the web canvas.

It's a thin adapter: the MCP server forwards tool calls to the running Nocturne **daemon** over
`localhost`, and the daemon holds all the durable state (runs, waits, checkpoints). So a run you
start from a chat keeps going after that chat ends — the whole point.

> **Prerequisite:** the daemon must be running — `nocturne serve` (or `npm run serve` in the repo).
> The MCP tools degrade gracefully and tell you to start it if it's down.

## Tools

`nocturne_status` · `list_workflows` · `get_workflow` · `save_workflow` · `run_workflow` ·
`list_runs` · `get_run` · `approve_step` · `pause_run` · `resume_run` · `cancel_run` ·
`suggest_workflows` (Retrace)

`run_workflow` takes a `projectRoot` (the repo the agents work in) and a saved `workflowId` or an
inline workflow; it returns a `runId` immediately and the run continues unattended. Poll it with
`get_run`.

---

## Claude Code — CLI, desktop app, and IDE extensions

They all share one plugin system, so this works everywhere Claude Code runs:

```
/plugin marketplace add muhamadjawdatsalemalakoum/nocturne
/plugin install nocturne@nocturne
```

That installs the MCP server (a **self-contained bundled build** committed in the plugin — no npm
publish, no build step) plus a `nocturne` skill that teaches Claude when and how to use it.

Prefer raw MCP without the plugin? From a clone:

```bash
claude mcp add nocturne -- node /abs/path/to/nocturne/integrations/claude-plugin/server/index.cjs
```

Details: [`claude-plugin/README.md`](./claude-plugin/README.md).

## Claude Desktop

**Works today — add it to your config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nocturne": {
      "command": "node",
      "args": ["/abs/path/to/nocturne/packages/mcp/bin/nocturne-mcp.mjs"]
    }
  }
}
```

**One-click bundle (`.mcpb`):** two commands build a validated, self-contained extension:

```bash
npm run build:mcp                    # bundle the server (single file, esbuild)
cd integrations/mcpb && npx @anthropic-ai/mcpb pack
```

Double-click the produced `.mcpb` to install it into Claude Desktop. Details in
[`mcpb/README.md`](./mcpb/README.md).

## Any MCP client

The server speaks standard MCP over **stdio**, so anything that can launch a stdio MCP server works:
run `node .../packages/mcp/bin/nocturne-mcp.mjs` (or `npx -y @nocturne/mcp`). Set
`NOCTURNE_DAEMON_URL` if the daemon isn't at `http://127.0.0.1:5151`.

## Auth & privacy

The daemon spawns the official `claude` CLI, so runs draw from your **Claude subscription**, not
metered API billing — and the MCP layer changes nothing about that. Retrace reads your local
session transcripts on disk and redacts secrets before anything is sent to the model; nothing leaves
your machine except the same subscription calls any Claude Code usage makes.
