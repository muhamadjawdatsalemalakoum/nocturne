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
  saveConfig,
  nocturneHome,
} from "@nocturne/engine";
import os from "node:os";
import { DEFAULT_RELAYS, consoleUrl, randomSecret, toB64Url, type PairingPayload } from "@nocturne/remote";
import { WorkflowStore } from "./workflowStore.js";
import { Broadcaster, startServer } from "./server.js";
import { RemoteBridge } from "./remote.js";

/** Where the phone console lives: a static page on the project site (secret rides the URL fragment). */
const CONSOLE_URL = process.env["NOCTURNE_CONSOLE_URL"] ?? "https://muhamadjawdatsalemalakoum.github.io/nocturne/app";

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

  // --lan (or config.lan): expose on the network for phone/tablet pairing.
  // A pairing token is minted once and persisted; LAN clients must present it.
  const lan = process.argv.includes("--lan") || config.lan === true;
  if (lan && !config.pairingToken) {
    config.pairingToken = crypto.randomUUID().replace(/-/g, "");
    config.lan = true;
    await saveConfig(config, home).catch(() => {});
  }

  // --remote (or config.remote): Nocturne Anywhere. Mints a persistent 32-byte
  // pairing secret; the daemon dials out to public relays and serves an
  // E2E-encrypted tunnel — no open ports, no accounts, no hosted servers.
  const remote = process.argv.includes("--remote") || config.remote === true;
  if (remote && !config.remoteSecret) {
    config.remoteSecret = toB64Url(randomSecret());
    config.remote = true;
    await saveConfig(config, home).catch(() => {});
  }
  const remoteRelays = config.remoteRelays ?? DEFAULT_RELAYS;
  const remotePayload: PairingPayload | null =
    remote && config.remoteSecret ? { v: 1, s: config.remoteSecret, r: remoteRelays, n: os.hostname() } : null;

  const runStore = new RunStore(home);
  await runStore.init();
  const workflowStore = new WorkflowStore(home);
  await workflowStore.init();
  const broadcaster = new Broadcaster();

  let bridge: RemoteBridge | null = null; // started after the server is up; events flow to it too
  const engine = new Engine({
    store: runStore,
    config,
    runner: new CliClaudeRunner(config.claudePath, { oauthToken: config.oauthToken }),
    onEvent: (ev) => {
      broadcaster.broadcast(ev);
      bridge?.onEvent(ev);
    },
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
    {
      engine, workflowStore, runStore, broadcaster, suggester, version: VERSION, staticDir,
      ...(lan && config.pairingToken ? { pairingToken: config.pairingToken, advertisePort: port } : {}),
      ...(remotePayload ? { remotePair: { url: consoleUrl(CONSOLE_URL, remotePayload), name: remotePayload.n } } : {}),
    },
    port,
    lan ? "0.0.0.0" : "127.0.0.1",
  );

  // Nocturne Anywhere: dial out to the rendezvous relays and serve the tunnel.
  // Best-effort by design — a relay outage must never stop the daemon.
  if (remotePayload && config.remoteSecret) {
    try {
      bridge = await RemoteBridge.start({
        secret: config.remoteSecret,
        port: server.port,
        relays: remoteRelays,
        name: remotePayload.n,
        version: VERSION,
      });
    } catch (e) {
      console.error("  (Anywhere bridge failed to start:", e instanceof Error ? e.message : e, ")");
    }
  }

  console.log(`\n  Nocturne daemon running`);
  console.log(`  → http://localhost:${server.port}`);
  if (lan) console.log(`  LAN pairing on — open the canvas and tap "Pair device" for the QR`);
  if (bridge) console.log(`  Anywhere on — pair from anywhere via the QR in "Pair device" (E2E-encrypted P2P)`);
  console.log(`  state: ${home}`);
  if (!staticDir) console.log(`  (UI not built yet — run: npm run build:ui)`);
  console.log("");

  // graceful shutdown: close the server (and WS) cleanly on Ctrl-C / systemd / container stop
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${sig} — shutting down…`);
    bridge?.close();
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
