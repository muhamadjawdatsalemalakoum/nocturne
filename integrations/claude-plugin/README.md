# Nocturne — Claude Code plugin

Works in **Claude Code everywhere** — the CLI, the desktop app (Mac/Windows), and the IDE
extensions; they all share the same plugin system. The plugin registers the `nocturne` MCP server
(a **self-contained bundled build** at [`server/index.cjs`](./server/index.cjs) — no npm install,
no build step) plus a `nocturne` [skill](./skills/nocturne/SKILL.md) that teaches Claude when and
how to drive workflows.

## Install (from the repo, no publish needed)

```
/plugin marketplace add muhamadjawdatsalemalakoum/nocturne
/plugin install nocturne@nocturne
```

Or without the plugin, add the server directly from a clone:

```bash
claude mcp add nocturne -- node /abs/path/to/nocturne/integrations/claude-plugin/server/index.cjs
```

Either way, the Nocturne daemon must be running: `nocturne serve` (or `npm run serve` in the repo).

## Rebuilding the bundled server

`server/index.cjs` is generated from `packages/mcp` by `npm run build:mcp` (esbuild, single file,
committed so installs work straight from GitHub). Rebuild it whenever `packages/mcp` changes.
