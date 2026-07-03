#!/usr/bin/env node
// Launcher for the Nocturne daemon. The entrypoint is TypeScript, so we run it
// through the bundled tsx loader rather than pointing `bin` at a raw .ts file
// (which Node cannot execute directly).
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
  console.error("Nocturne needs 'tsx' to run from source. Install it (npm i tsx) or use: npm run serve");
  process.exit(1);
}
const tsxCli = path.join(tsxPkg, "dist", "cli.mjs");
const child = spawn(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
