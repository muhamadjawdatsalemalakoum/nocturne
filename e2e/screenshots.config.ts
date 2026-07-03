import { defineConfig, devices } from "@playwright/test";
import { BASE, PORT, E2E_HOME, E2E_SESSIONS, REPO_ROOT, FAKE_CLAUDE } from "./paths";

// Dedicated config for generating marketing/README screenshots. Reuses the e2e
// daemon+fake-claude harness but at a larger, retina viewport, and only runs the
// capture script (never the normal spec suite).
export default defineConfig({
  testDir: ".",
  testMatch: "**/screenshots.capture.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: BASE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx tsx scripts/preview.mjs serve --port ${PORT}`,
    cwd: REPO_ROOT,
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { NOCTURNE_HOME: E2E_HOME, NOCTURNE_CLAUDE_PATH: FAKE_CLAUDE, NOCTURNE_SESSIONS_DIR: E2E_SESSIONS },
  },
});
