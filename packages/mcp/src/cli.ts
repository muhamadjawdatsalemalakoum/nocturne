#!/usr/bin/env node
import { startStdio, MCP_VERSION } from "./server.js";

const cmd = process.argv[2];
if (cmd === "--version" || cmd === "-v") {
  console.log(MCP_VERSION);
} else {
  startStdio().catch((e: unknown) => {
    console.error("[nocturne-mcp] fatal:", e);
    process.exit(1);
  });
}
