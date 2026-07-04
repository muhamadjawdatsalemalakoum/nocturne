// Bundle the Nocturne MCP server into a single self-contained CommonJS file —
// no tsx, no node_modules, no npm publish required. The output is committed into
// the Claude Code plugin (so installing from the repo just works) and staged into
// the .mcpb build dir for Claude Desktop packing.
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "mcp", "src", "cli.ts");
const pluginOut = path.join(root, "integrations", "claude-plugin", "server", "index.cjs");
const mcpbOut = path.join(root, "integrations", "mcpb", "server", "index.cjs");

mkdirSync(path.dirname(pluginOut), { recursive: true });
mkdirSync(path.dirname(mcpbOut), { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile: pluginOut,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: false,
  minify: false,
  logLevel: "silent",
});
if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}
copyFileSync(pluginOut, mcpbOut);
console.log("bundled →", path.relative(root, pluginOut));
console.log("staged  →", path.relative(root, mcpbOut));
