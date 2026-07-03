import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_HOME, E2E_PROJECT, REPO_ROOT } from "./paths";

const OUT = path.join(REPO_ROOT, "docs", "images");
const sampleFile = path.join(REPO_ROOT, "e2e", "fixtures", "sample.nocturne.json");

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name), animations: "disabled" });
}
async function loadTemplate(page: Page, id: string) {
  await page.getByTestId(`tpl-${id}`).click();
  await page.waitForTimeout(500);
}
async function startRun(page: Page) {
  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-projectroot").fill(E2E_PROJECT);
  await page.getByTestId("run-confirm").click();
  // collapse the settings panel so the floating Run panel is unobstructed
  await page.locator(".panel.right .panel-toggle").click();
}

test.beforeAll(async () => {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(E2E_HOME, { recursive: true });
  // one scenario for the whole session: brief per-line delay so a "running" state is
  // catchable, plus tool activity for the live feed. Agent steps finish; wait/approval
  // nodes still suspend their runs on their own.
  await fs.writeFile(
    path.join(E2E_HOME, "scenario.json"),
    JSON.stringify({ default: { ok: "Refactored the auth module; updated 3 tests, all green.", delayMs: 150, cost: 0.002, tools: ["Read src/auth.ts", "Edit src/auth.ts", "Bash npm test"] } }),
  );
});

test("capture all journeys", async ({ page }) => {
  test.setTimeout(180_000);

  // 01 — the empty canvas + template picker (landing)
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "01-canvas.png");

  // 02 — one click turns the blank canvas into a working pipeline
  await loadTemplate(page, "overnight-refactor");
  await expect(page.locator(".node.agent").first()).toBeVisible();
  await shot(page, "02-pipeline.png");

  // 03 — options-first inspector (model, prompt presets, tool chips, permission)
  await page.locator(".node.agent").first().click();
  await expect(page.getByTestId("inspector")).toContainText("agent node");
  await page.waitForTimeout(200);
  await shot(page, "03-inspector.png");

  // 04 — the run modal (subscription framing). Screenshot then close WITHOUT running.
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("run-modal")).toBeVisible();
  await shot(page, "04-run-modal.png");
  await page.getByTestId("run-modal").getByRole("button", { name: "Cancel" }).click();

  // 05 + 06 — one overnight run: capture "running" mid-stream, then "completed"
  await page.goto("/");
  await loadTemplate(page, "overnight-refactor");
  await startRun(page);
  await expect(page.locator('[data-testid^="node-live-"]').first()).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(300);
  await shot(page, "05-running.png");
  await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 90_000 });
  await page.waitForTimeout(400);
  await shot(page, "06-completed.png");

  // 07 — the hero: a run paused on a usage-limit-reset wait, ready to resume
  await page.goto("/");
  await loadTemplate(page, "rate-limit-safe");
  await startRun(page);
  await expect(page.getByTestId("run-status")).toHaveText(/waiting/, { timeout: 40_000 });
  await page.waitForTimeout(400);
  await shot(page, "07-waiting-reset.png");

  // 08 — a human approval gate pausing the run
  await page.goto("/");
  await loadTemplate(page, "review-approve");
  await startRun(page);
  await expect(page.getByTestId("run-status")).toHaveText(/waiting/, { timeout: 40_000 });
  await page.waitForTimeout(400);
  await shot(page, "08-approval.png");

  // 09 — the import review dialog (see exactly what a shared workflow can do)
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(sampleFile);
  await expect(page.getByTestId("import-modal")).toBeVisible();
  await shot(page, "09-import-review.png");
  await page.getByTestId("import-confirm").click();

  // 10 — Figma-style panels minimized for a full-bleed canvas
  await loadTemplate(page, "fix-tests");
  await page.locator(".panel.left .panel-toggle").click();
  await page.locator(".panel.right .panel-toggle").click();
  await page.waitForTimeout(300);
  await shot(page, "10-minimized.png");
});
