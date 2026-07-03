import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_PROJECT, FAKE_CLAUDE, REPO_ROOT } from "./paths";

/**
 * Only responsible for the project directory the run executes in.
 * The daemon (scripts/preview.mjs) owns its own home/config/scenario, written at
 * boot from NOCTURNE_CLAUDE_PATH — so config is guaranteed present before it reads it.
 */
export default async function globalSetup(): Promise<void> {
  await fs.mkdir(path.join(E2E_PROJECT, "src"), { recursive: true });

  if (process.platform !== "win32") {
    const mjs = path.join(REPO_ROOT, "packages", "engine", "test", "fixtures", "fake-claude.mjs");
    await fs.writeFile(FAKE_CLAUDE, `#!/bin/sh\nexec node "${mjs}" "$@"\n`);
    await fs.chmod(FAKE_CLAUDE, 0o755);
  }
}
