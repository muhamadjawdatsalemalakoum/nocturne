# Nocturne — Claude Code plugin

Registers the `nocturne` MCP server (see [`.mcp.json`](./.mcp.json)) plus a `nocturne`
[skill](./skills/nocturne/SKILL.md) that teaches Claude when and how to drive Nocturne workflows.

## Heads-up: the MCP server must be resolvable

`.mcp.json` launches the server with `npx -y @nocturne/mcp`, which only works **once `@nocturne/mcp`
is published to npm.** Until then, pick one:

- **Publish it yourself** (from a clone): `npm publish -w @nocturne/mcp` — then the plugin works as-is.
- **Skip the plugin and add the server directly** (works today from a clone):
  ```bash
  claude mcp add nocturne -- node /abs/path/to/nocturne/packages/mcp/bin/nocturne-mcp.mjs
  ```
  Copy [`skills/nocturne/SKILL.md`](./skills/nocturne/SKILL.md) into `~/.claude/skills/nocturne/`
  if you want the guidance skill too.

Either way the Nocturne daemon must be running (`nocturne serve`).
