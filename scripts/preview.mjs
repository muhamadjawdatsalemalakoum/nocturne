// Dev-only launcher: boots the Nocturne daemon against a scratch home. When
// NOCTURNE_CLAUDE_PATH is set (e2e/preview), it writes the daemon config itself
// BEFORE the daemon reads it — so there is no dependency on external setup order.
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Portable scratch home so this committed dev launcher isn't tied to one machine.
const home = process.env.NOCTURNE_HOME || path.join(os.tmpdir(), "nocturne-preview-home");
process.env.NOCTURNE_HOME = home;
mkdirSync(home, { recursive: true });

const scenarioPath = path.join(home, "scenario.json");
process.env.FAKE_CLAUDE_SCENARIO = scenarioPath;

// If a fake claude path is provided, own the config + scenario deterministically.
if (process.env.NOCTURNE_CLAUDE_PATH) {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(
      {
        claudePath: process.env.NOCTURNE_CLAUDE_PATH,
        maxConcurrent: 2,
        defaultLimitWaitMinutes: 60,
        autoResumeOnStart: false,
      },
      null,
      2,
    ),
  );
  // Always reset: a prior suite's test may rewrite the scenario mid-run (the
  // streaming test does), and a stale scenario poisons the next boot.
  writeFileSync(scenarioPath, JSON.stringify({ default: { ok: "STEP-DONE", cost: 0.002 } }));
}

await import(pathToFileURL(path.join(root, "packages", "server", "src", "cli.ts")).href);
