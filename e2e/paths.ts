import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_HOME = path.join(os.tmpdir(), "nocturne-e2e-home");
export const E2E_PROJECT = path.join(os.tmpdir(), "nocturne-e2e-project");
/** Fake Claude Code "projects" dir Retrace scans (NOCTURNE_SESSIONS_DIR). */
export const E2E_SESSIONS = path.join(os.tmpdir(), "nocturne-e2e-sessions");
export const PORT = 5199;
export const BASE = `http://127.0.0.1:${PORT}`;
export const FAKE_CLAUDE =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "packages", "engine", "test", "fixtures", "fake-claude.cmd")
    : path.join(REPO_ROOT, "packages", "engine", "test", "fixtures", "fake-claude");
