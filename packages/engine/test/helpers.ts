import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path to a launcher for the fake-claude fixture that the OS can execute directly.
 * cross-spawn runs the .cmd on Windows; a chmod+x shell shim on POSIX.
 */
export async function fakeClaudePath(): Promise<string> {
  if (process.platform === "win32") {
    return path.join(here, "fixtures", "fake-claude.cmd");
  }
  const sh = path.join(here, "fixtures", "fake-claude");
  const body = `#!/bin/sh\nexec node "${path.join(here, "fixtures", "fake-claude.mjs")}" "$@"\n`;
  await fs.writeFile(sh, body, "utf8");
  await fs.chmod(sh, 0o755);
  return sh;
}

/** Create a scenario file in a temp dir and return its path (state file lives beside it). */
export async function writeScenario(dir: string, scenario: unknown): Promise<string> {
  const p = path.join(dir, `scenario-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(p, JSON.stringify(scenario), "utf8");
  return p;
}

/** Fresh temp NOCTURNE_HOME for a test; returns the dir and a cleanup fn. */
export async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nocturne-test-"));
  return {
    home,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}
