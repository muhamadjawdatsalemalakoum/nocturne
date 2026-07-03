import { defineConfig, devices } from "@playwright/test";
import { BASE, PORT, E2E_HOME, REPO_ROOT, FAKE_CLAUDE } from "./paths";

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: BASE,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx tsx scripts/preview.mjs serve --port ${PORT}`,
    cwd: REPO_ROOT,
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { NOCTURNE_HOME: E2E_HOME, NOCTURNE_CLAUDE_PATH: FAKE_CLAUDE },
  },
});
