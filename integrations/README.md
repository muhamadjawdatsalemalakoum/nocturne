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

## Claude Code

**Quickest — add the server directly:**

```bash
# from a clone of this repo (runs the TypeScript server via tsx):
claude mcp add nocturne -- node /abs/path/to/nocturne/packages/mcp/bin/nocturne-mcp.mjs

# …or once @nocturne/mcp is published to npm:
claude mcp add nocturne -- npx -y @nocturne/mcp
```

**Or install the plugin** (bundles the MCP server config + a `nocturne` skill that teaches Claude
when/how to use the tools) from [`integrations/claude-plugin/`](./claude-plugin/). The plugin runs
`@nocturne/mcp` from npm, so it activates **once that package is published** — until then use the
`claude mcp add` command above for local dev. See
[`claude-plugin/README.md`](./claude-plugin/README.md) for details; the skill lives in
[`skills/nocturne/SKILL.md`](./claude-plugin/skills/nocturne/SKILL.md).

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

**One-click bundle (`.mcpb`):** [`integrations/mcpb/manifest.json`](./mcpb/manifest.json) is the
Desktop Extension manifest (`server.type: "node"`) — full build steps in
[`mcpb/README.md`](./mcpb/README.md). To build the installable bundle, stage the `@nocturne/mcp`
package (with its dependencies) under `server/` next to the manifest and run the official packer:

```bash
npm install -g @anthropic-ai/mcpb   # or: npx @anthropic-ai/mcpb
mcpb pack                            # validates the manifest and produces nocturne.mcpb
```

Then double-click `nocturne.mcpb` to install it into Claude Desktop. (A self-contained, published
bundle is on the roadmap; until then the config snippet above is the zero-build path.)

## Any MCP client

The server speaks standard MCP over **stdio**, so anything that can launch a stdio MCP server works:
run `node .../packages/mcp/bin/nocturne-mcp.mjs` (or `npx -y @nocturne/mcp`). Set
`NOCTURNE_DAEMON_URL` if the daemon isn't at `http://127.0.0.1:5151`.

## Auth & privacy

The daemon spawns the official `claude` CLI, so runs draw from your **Claude subscription**, not
metered API billing — and the MCP layer changes nothing about that. Retrace reads your local
session transcripts on disk and redacts secrets before anything is sent to the model; nothing leaves
your machine except the same subscription calls any Claude Code usage makes.
