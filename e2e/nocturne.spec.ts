import { test, expect } from "@playwright/test";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { E2E_PROJECT, E2E_HOME } from "./paths";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleFile = path.join(here, "fixtures", "sample.nocturne.json");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("palette")).toBeVisible();
  // starter workflow has a start + end node
  await expect(page.locator(".node.terminal")).toHaveCount(2);
});

test("canvas editing: add, edit and delete an agent node", async ({ page }) => {
  await page.getByTestId("pal-agent").click();
  await expect(page.locator(".node.agent")).toHaveCount(1);

  await page.locator(".node.agent").click();
  await expect(page.getByTestId("inspector")).toContainText("agent node");

  await page.getByTestId("f-title").fill("Refactor module");
  await expect(page.locator(".node.agent .title")).toHaveText("Refactor module");

  await page.getByTestId("model-haiku").click();
  await expect(page.locator(".node.agent .chip")).toHaveText("haiku");

  await page.getByTestId("delete-node").click();
  await expect(page.locator(".node.agent")).toHaveCount(0);
});

test("import shows a review dialog and loads the workflow", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles(sampleFile);
  const modal = page.getByTestId("import-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("E2E Sample");
  await expect(modal).toContainText("First step");
  await expect(modal).toContainText("Second step");

  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("wf-name")).toHaveValue("E2E Sample");
  await expect(page.locator(".node.agent")).toHaveCount(2);
});

test("export produces a valid, re-importable workflow file", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-btn").click(),
  ]);
  const p = await download.path();
  const text = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(text);
  expect(parsed.nocturne).toBe(1);
  expect(parsed.nodes.some((n: { type: string }) => n.type === "start")).toBe(true);
  expect(parsed.nodes.some((n: { type: string }) => n.type === "end")).toBe(true);
  expect(download.suggestedFilename()).toMatch(/\.nocturne\.json$/);
});

test("run an imported workflow to completion and see step output", async ({ page }) => {
  // import the two-step sample
  await page.locator('input[type="file"]').setInputFiles(sampleFile);
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("wf-name")).toHaveValue("E2E Sample");

  // launch a run against the e2e project dir
  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-projectroot").fill(E2E_PROJECT);
  await page.getByTestId("run-confirm").click();

  await expect(page.getByTestId("run-drawer")).toHaveClass(/open/);

  // the run drives through fake-claude to completion
  await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 25_000 });
  await expect(page.getByTestId("step-status-a")).toHaveText("succeeded");
  await expect(page.getByTestId("step-status-b")).toHaveText("succeeded");
  await expect(page.getByTestId("step-a")).toContainText("STEP-DONE");

  // nodes reflect success on the canvas
  await expect(page.locator('.node[data-status="succeeded"]').first()).toBeVisible();
});

test("shows a realtime streaming feed while a step runs", async ({ page }) => {
  // slow, tool-using scenario so the "running" live state is observable
  await fs.writeFile(
    path.join(E2E_HOME, "scenario.json"),
    JSON.stringify({ default: { ok: "All done.", delayMs: 350, tools: ["Edit src/app.ts", "Bash npm test"] } }),
  );

  await page.locator('input[type="file"]').setInputFiles(sampleFile);
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("wf-name")).toHaveValue("E2E Sample");

  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-projectroot").fill(E2E_PROJECT);
  await page.getByTestId("run-confirm").click();

  // the live feed panel appears for the running step and shows a tool activity line
  const live = page.getByTestId("live-a");
  await expect(live).toBeVisible({ timeout: 10_000 });
  await expect(live).toContainText("Edit src/app.ts");

  // and it still runs to completion
  await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 25_000 });
});

test("waiting on the environment: project dir exists", async () => {
  // sanity: global-setup created the project dir the run needs
  const stat = await fs.stat(E2E_PROJECT);
  expect(stat.isDirectory()).toBe(true);
});
