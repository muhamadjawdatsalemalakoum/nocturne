#!/usr/bin/env node
// Launcher for the Nocturne MCP stdio server. The entrypoint is TypeScript, so we
// run it through the bundled tsx loader. stdio is inherited so the JSON-RPC pipe
// (stdin/stdout) and logs (stderr) pass straight through to the MCP client.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../src/cli.ts");

const require = createRequire(import.meta.url);
let tsxPkg;
try {
  tsxPkg = path.dirname(require.resolve("tsx/package.json"));
} catch {
  console.error("nocturne-mcp needs 'tsx' to run from source (npm i tsx).");
  process.exit(1);
}
const tsxCli = path.join(tsxPkg, "dist", "cli.mjs");
const child = spawn(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
