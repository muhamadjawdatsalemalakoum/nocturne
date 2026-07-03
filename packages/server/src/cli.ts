#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Engine,
  RunStore,
  CliClaudeRunner,
  WorkflowSuggester,
  loadConfig,
  nocturneHome,
} from "@nocturne/engine";
import { WorkflowStore } from "./workflowStore.js";
import { Broadcaster, startServer } from "./server.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd !== "serve") {
    console.error(`Unknown command "${cmd}". Usage: nocturne serve [--port N]`);
    process.exit(1);
  }

  const home = nocturneHome();
  const config = await loadConfig(home);
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5151;

  const runStore = new RunStore(home);
  await runStore.init();
  const workflowStore = new WorkflowStore(home);
  await workflowStore.init();
  const broadcaster = new Broadcaster();

  const engine = new Engine({
    store: runStore,
    config,
    runner: new CliClaudeRunner(config.claudePath, { oauthToken: config.oauthToken }),
    onEvent: (ev) => broadcaster.broadcast(ev),
  });

  // Retrace: reads the user's local Claude Code transcripts and drafts workflows
  // from them, through the same subscription-auth CLI adapter the engine uses.
  const suggester = new WorkflowSuggester({
    runner: new CliClaudeRunner(config.claudePath, { oauthToken: config.oauthToken }),
  });

  // resume anything left suspended/interrupted by a previous daemon (best-effort:
  // recovery must never prevent the server from coming up)
  try {
    await engine.recoverInterrupted();
  } catch (e) {
    console.error("  (recovery skipped:", e instanceof Error ? e.message : e, ")");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDist = path.resolve(here, "../../ui/dist");
  const staticDir = existsSync(path.join(uiDist, "index.html")) ? uiDist : undefined;

  const server = await startServer(
    { engine, workflowStore, runStore, broadcaster, suggester, version: VERSION, staticDir },
    port,
  );

  console.log(`\n  Nocturne daemon running`);
  console.log(`  → http://localhost:${server.port}`);
  console.log(`  state: ${home}`);
  if (!staticDir) console.log(`  (UI not built yet — run: npm run build:ui)`);
  console.log("");

  // graceful shutdown: close the server (and WS) cleanly on Ctrl-C / systemd / container stop
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${sig} — shutting down…`);
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// a long-lived daemon must survive a stray rejection/throw, not die and take every run with it
process.on("unhandledRejection", (reason) => console.error("[nocturne] unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[nocturne] uncaught exception:", err));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
