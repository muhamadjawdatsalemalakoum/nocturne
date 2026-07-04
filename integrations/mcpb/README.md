# Nocturne — Claude Desktop extension (`.mcpb`)

[`manifest.json`](./manifest.json) is the Desktop Extension manifest (a Node MCP server). A `.mcpb`
is a **self-contained** bundle, so building it requires *staging* the `@nocturne/mcp` package next to
the manifest first.

## Works today (no build): manual config

Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "nocturne": { "command": "node", "args": ["/abs/path/to/nocturne/packages/mcp/bin/nocturne-mcp.mjs"] } } }
```

## Building the one-click bundle

The manifest's `entry_point` is `server/bin/nocturne-mcp.mjs`, so stage the whole package under
`server/` — `bin/`, `src/`, and its runtime deps (`tsx` + the MCP SDK), since the bin resolves
`../src/cli.ts` and runs it through `tsx`:

```bash
mkdir -p server
cp -r ../../packages/mcp/bin ../../packages/mcp/src ../../packages/mcp/package.json server/
( cd server && npm install --omit=dev )
npx @anthropic-ai/mcpb pack        # validates the manifest → produces nocturne.mcpb
```

Then double-click `nocturne.mcpb` to install it into Claude Desktop.

> The staged `server/` and any `*.mcpb` are build output (git-ignored). A published, fully
> self-contained bundle is on the roadmap; the manual config above is the zero-build path.

The Nocturne daemon must be running (`nocturne serve`).
