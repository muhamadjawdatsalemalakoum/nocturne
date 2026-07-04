# Nocturne — Claude Desktop extension (`.mcpb`)

One-click extension for the **Claude Desktop** app. The bundle wraps the self-contained MCP server
(single file, no runtime deps beyond Node) described by [`manifest.json`](./manifest.json).

## Build & install

```bash
npm run build:mcp                 # bundles packages/mcp → server/index.cjs (esbuild)
npx @anthropic-ai/mcpb pack       # validates the manifest → produces the .mcpb
```

Double-click the produced `.mcpb` to install it into Claude Desktop. (`server/` and `*.mcpb` are
build output, git-ignored.)

## No-build alternative

Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "nocturne": { "command": "node", "args": ["/abs/path/to/nocturne/integrations/claude-plugin/server/index.cjs"] } } }
```

Either way, the Nocturne daemon must be running (`nocturne serve`).
