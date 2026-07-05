import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_HOME, E2E_PROJECT, E2E_SESSIONS, REPO_ROOT } from "./paths";

const OUT = path.join(REPO_ROOT, "docs", "images");
const sampleFile = path.join(REPO_ROOT, "e2e", "fixtures", "sample.nocturne.json");

// Workflows the (fake) Retrace agent "drafts" from the seeded sessions below.
const RETRACE_DRAFTS = {
  workflows: [
    {
      name: "Client deliverable QA",
      description: "Reproduce the report, fix it, prove it green, then pause for sign-off before shipping.",
      rationale: "You did this by hand for a client twice this week — automate it so it's right every time.",
      sourceSessions: ["sess-client"],
      steps: [
        { kind: "agent", title: "Reproduce & diagnose", prompt: "Reproduce the reported issue and summarize the root cause.", model: "sonnet", tools: ["Read", "Grep", "Bash"] },
        { kind: "agent", title: "Fix", prompt: "Implement the fix for the diagnosed issue.", model: "sonnet", tools: ["Read", "Edit", "Write"] },
        { kind: "agent", title: "Verify green", prompt: "Run the full test suite and confirm everything passes.", model: "haiku", tools: ["Read", "Bash"] },
        { kind: "approval", message: "Review the diff and test output before it ships to the client." },
        { kind: "agent", title: "Ship", prompt: "Commit the change and open a pull request.", model: "haiku", tools: ["Bash"] },
      ],
    },
    {
      name: "Overnight dependency upgrade",
      description: "Bump dependencies, wait out the usage-limit reset, then fix the fallout.",
      rationale: "Long-running upgrade work you kept restarting after hitting limits — let it wait and resume.",
      sourceSessions: ["sess-deps"],
      steps: [
        { kind: "agent", title: "Upgrade & build", prompt: "Upgrade dependencies to their latest compatible versions and run the build.", model: "sonnet", tools: ["Read", "Edit", "Bash"] },
        { kind: "wait" },
        { kind: "agent", title: "Fix breakages", prompt: "Fix any type errors and test failures the upgrade introduced.", model: "sonnet", tools: ["Read", "Edit", "Bash"] },
      ],
    },
    {
      name: "PR review pass",
      description: "Read the diff, review for bugs and edge cases, and write a tight summary.",
      rationale: "A repeatable review routine from your recent sessions on the Cabs repo.",
      sourceSessions: ["sess-review"],
      steps: [
        { kind: "agent", title: "Read the diff", prompt: "Read the current branch diff against main and list what changed.", model: "haiku", tools: ["Read", "Bash", "Grep"] },
        { kind: "agent", title: "Review", prompt: "Review the diff for bugs, edge cases, and missing tests.", model: "opus", tools: ["Read", "Grep"] },
        { kind: "agent", title: "Summarize", prompt: "Write a concise review summary with the top findings.", model: "haiku", tools: ["Read"] },
      ],
    },
  ],
};

/** Seed a few realistic recent transcripts into the fake projects dir Retrace scans. */
async function seedSessions(): Promise<void> {
  const now = Date.now();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const session = (
    slug: string,
    id: string,
    cwd: string,
    minsAgo: number,
    prompts: string[],
    tools: Array<{ name: string; file_path?: string; command?: string }>,
  ) => ({
    slug,
    id,
    lines: [
      { type: "user", timestamp: iso(minsAgo), sessionId: id, cwd, gitBranch: "main", message: { role: "user", content: prompts[0] } },
      { type: "assistant", timestamp: iso(minsAgo - 1), sessionId: id, cwd, message: { model: "claude-sonnet-4", content: tools.map((t) => ({ type: "tool_use", name: t.name, input: t.file_path ? { file_path: t.file_path } : t.command ? { command: t.command } : {} })) } },
      ...(prompts[1] ? [{ type: "user", timestamp: iso(minsAgo - 2), sessionId: id, cwd, message: { role: "user", content: prompts[1] } }] : []),
    ],
  });
  const sessions = [
    session("D--Coding-Projects-Acme-Client", "sess-client", "D:/Coding Projects/Acme Client", 45, ["The client says checkout throws on empty cart — reproduce and fix it", "now make sure the tests pass before we ship"], [{ name: "Read", file_path: "src/checkout.ts" }, { name: "Edit", file_path: "src/checkout.ts" }, { name: "Bash", command: "npm test" }]),
    session("D--Coding-Projects-Acme-Client", "sess-deps", "D:/Coding Projects/Acme Client", 180, ["upgrade all the dependencies and fix whatever breaks"], [{ name: "Edit", file_path: "package.json" }, { name: "Bash", command: "npm run build" }]),
    session("D--Coding-Projects-Cabs-Taxi-Pool", "sess-review", "D:/Coding Projects/Cabs Taxi Pool", 320, ["review the open PR on the pricing branch for bugs"], [{ name: "Bash", command: "git diff main" }, { name: "Read", file_path: "src/pricing.ts" }]),
    session("D--Coding-Projects-Lenis-Blog", "sess-blog", "D:/Coding Projects/Lenis Blog", 500, ["draft a launch post about the new editor"], [{ name: "Write", file_path: "posts/launch.md" }]),
  ];
  for (const s of sessions) {
    const dir = path.join(E2E_SESSIONS, s.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${s.id}.jsonl`), s.lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
}

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
  await page.locator(".panel.right .panel-head .panel-toggle").click();
}

test.beforeAll(async () => {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(E2E_HOME, { recursive: true });
  await seedSessions();
  // one scenario for the whole session: brief per-line delay so a "running" state is
  // catchable, plus tool activity for the live feed. Agent steps finish; wait/approval
  // nodes still suspend their runs on their own. The Retrace rule matches the sentinel
  // the suggester puts at the top of its meta-prompt and returns drafted workflows.
  await fs.writeFile(
    path.join(E2E_HOME, "scenario.json"),
    JSON.stringify({
      rules: [
        { match: { contains: "NOCTURNE_RETRACE_V1" }, responses: [{ ok: JSON.stringify(RETRACE_DRAFTS), cost: 0.021 }] },
      ],
      default: { ok: "Refactored the auth module; updated 3 tests, all green.", delayMs: 150, cost: 0.002, tools: ["Read src/auth.ts", "Edit src/auth.ts", "Bash npm test"] },
    }),
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

  // 07 — the hero: a run paused on a usage-limit-reset wait, ready to resume.
  // Composition matters most here (it's the page-one image): palette scrolled
  // to its top, canvas panned so no node leaks half-hidden behind the run drawer.
  await page.goto("/");
  await loadTemplate(page, "rate-limit-safe");
  await startRun(page);
  await expect(page.getByTestId("run-status")).toHaveText(/waiting/, { timeout: 40_000 });
  await page.evaluate(() => {
    document.querySelectorAll(".panel *").forEach((el) => {
      if (el.scrollTop) el.scrollTop = 0;
    });
  });
  // one gentle zoom-out so the whole chain sits clear of both panels
  await page.mouse.move(580, 420);
  await page.mouse.wheel(0, 240);
  await page.mouse.move(640, 420);
  await page.mouse.down();
  await page.mouse.move(560, 420, { steps: 5 });
  await page.mouse.up();
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
  await page.locator(".panel.left .panel-head .panel-toggle").click();
  await page.locator(".panel.right .panel-head .panel-toggle").click();
  await page.waitForTimeout(300);
  await shot(page, "10-minimized.png");

  // 11 — Retrace: workflows drafted from your recent Claude Code sessions
  await page.goto("/");
  await page.getByTestId("retrace-btn").click();
  await expect(page.getByTestId("retrace-modal")).toBeVisible();
  await expect(page.getByTestId("suggestion-0")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await shot(page, "11-retrace.png");
  await page.keyboard.press("Escape");

  // 15 — if/else: save a branchy workflow, open it FROM the library, inspect the predicate
  const branchy = {
    nocturne: 1, id: "demo-release-gate", name: "Release gate", description: "Test, then ship or fix based on the verdict.",
    params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 170 } },
      { id: "test", type: "agent", position: { x: 210, y: 140 }, data: { title: "Run the tests", prompt: "Run the full test suite and report PASS or FAIL with the failures.", model: "haiku", cwd: "", allowedTools: ["Read", "Bash"], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null } },
      { id: "gate", type: "condition", position: { x: 500, y: 150 }, data: { title: "All green?", left: "{{steps.test.output}}", op: "contains", value: "PASS" } },
      { id: "ship", type: "agent", position: { x: 780, y: 40 }, data: { title: "Ship it", prompt: "Commit and open a pull request.", model: "haiku", cwd: "", allowedTools: ["Bash"], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null } },
      { id: "fix", type: "agent", position: { x: 780, y: 260 }, data: { title: "Fix the failures", prompt: "Fix the reported failures, then re-run the tests.", model: "sonnet", cwd: "", allowedTools: ["Read", "Edit", "Bash"], permissionMode: "dontAsk", continueFrom: null, retry: { max: 1, backoffSec: 60 }, outputSchema: null, repeat: 2 } },
      { id: "end", type: "end", position: { x: 1060, y: 170 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "test" },
      { id: "e2", source: "test", target: "gate" },
      { id: "e3", source: "gate", target: "ship", branch: "true" },
      { id: "e4", source: "gate", target: "fix", branch: "false" },
      { id: "e5", source: "ship", target: "end" },
      { id: "e6", source: "fix", target: "end" },
    ],
  };
  await page.request.post("/api/workflows", { data: branchy });
  await page.goto("/");
  await page.getByTestId("saved-demo-release-gate").locator(".saved-open").click();
  await page.waitForTimeout(500);
  await page.locator(".node.condition").click();
  await page.waitForTimeout(300);
  await shot(page, "15-condition.png");

  // 16 — run-inputs editor (params UX) on the workflow settings panel
  await page.goto("/");
  await page.locator(".rf, .react-flow").first().click({ position: { x: 300, y: 400 } }).catch(() => {});
  await page.getByTestId("add-param").click();
  await page.getByTestId("add-param").click();
  const rows = page.locator(".param-row");
  await rows.nth(0).locator(".pr-name").fill("ticket");
  await rows.nth(0).locator(".pr-sub").first().fill("The issue to fix, e.g. NOC-42");
  await rows.nth(1).locator(".pr-name").fill("branch");
  await rows.nth(1).locator(".pr-sub").nth(1).fill("main");
  await page.waitForTimeout(250);
  await shot(page, "16-run-inputs.png");
});
