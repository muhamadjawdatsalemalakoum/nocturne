// Nocturne Anywhere — LIVE end-to-end proof.
//
// Boots the REAL daemon bin with --remote, serves the REAL built console
// (docs/app, the exact bytes GitHub Pages serves), opens it in a REAL
// Chromium, and pairs the two through REAL public Nostr relays on the
// public internet. Then drives the complete remote user journey through
// the tunnel: import a workflow, run it against fake-claude, watch live
// status, hit an approval gate from the "phone", approve it, see it ship.
//
// Run: node scripts/anywhere-e2e.mjs   (exits non-zero on any failure)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5189;
const SITE_PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), `nocturne-anywhere-${Date.now()}`);
const PROJ = path.join(HOME, "proj");
const FAKE = path.join(root, "packages", "engine", "test", "fixtures", process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");

const results = [];
const ok = (name) => { results.push([name, true]); console.log(`  PASS  ${name}`); };
const fail = (name, why) => { results.push([name, false]); console.log(`  FAIL  ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let daemon = null;
let site = null;
let browser = null;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

/** Serve the repo's docs/ directory under /nocturne — byte-identical to GitHub Pages. */
function startSite() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, `http://x`);
      let rel = url.pathname.replace(/^\/nocturne\/?/, "");
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const file = path.join(root, "docs", rel);
      if (!file.startsWith(path.join(root, "docs")) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    srv.listen(SITE_PORT, "127.0.0.1", () => resolve(srv));
  });
}

async function main() {
  mkdirSync(PROJ, { recursive: true });
  // a pre-minted secret so the run is fully scripted (the daemon would mint one itself otherwise)
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(path.join(HOME, "config.json"), JSON.stringify({
    claudePath: FAKE, maxConcurrent: 2, defaultLimitWaitMinutes: 60, autoResumeOnStart: true,
    remote: true, remoteSecret: secret,
  }));
  writeFileSync(path.join(HOME, "scenario.json"), JSON.stringify({ default: { ok: "ANYWHERE-DONE", cost: 0.001 } }));

  console.log("\n— boot the real daemon bin with --remote —");
  daemon = spawn(process.execPath, [path.join(root, "packages", "server", "bin", "nocturne.mjs"), "serve", "--port", String(PORT), "--remote"], {
    env: { ...process.env, NOCTURNE_HOME: HOME, FAKE_CLAUDE_SCENARIO: path.join(HOME, "scenario.json") },
    stdio: ["ignore", "pipe", "pipe"], cwd: root,
  });
  let bootLog = "";
  daemon.stdout.on("data", (d) => { bootLog += String(d); });
  daemon.stderr.on("data", (d) => { bootLog += String(d); });
  const t0 = Date.now();
  let healthy = false;
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { healthy = true; break; } } catch {}
    await sleep(200);
  }
  if (healthy) ok("daemon boots with --remote"); else return fail("daemon boots with --remote", bootLog.slice(-400));
  // the banner prints after the bridge dials the relays — give it a moment
  const tBanner = Date.now();
  while (!bootLog.includes("Anywhere on") && Date.now() - tBanner < 15_000) await sleep(200);
  if (bootLog.includes("Anywhere on")) ok("daemon announces Anywhere"); else fail("daemon announces Anywhere", bootLog.slice(-400));

  console.log("\n— pairing invitation via /api/pair (loopback) —");
  const pair = await (await fetch(`${BASE}/api/pair`)).json();
  if (pair.remote?.url?.includes("#pair=")) ok("pair endpoint returns Anywhere invitation"); else return fail("pair invitation", JSON.stringify(pair));
  const fragment = pair.remote.url.slice(pair.remote.url.indexOf("#"));

  console.log("\n— open the real console build through real public relays —");
  site = await startSite();
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const consoleUrl = `http://127.0.0.1:${SITE_PORT}/nocturne/app/${fragment}`;
  await page.goto(consoleUrl, { waitUntil: "domcontentloaded" });

  // the pairing payload must be scrubbed from the address bar immediately
  await sleep(500);
  if (!page.url().includes("pair=")) ok("secret scrubbed from the address bar"); else fail("secret scrubbed", page.url());

  const pill = page.getByTestId("anywhere-pill");
  try {
    await pill.waitFor({ state: "visible", timeout: 10_000 });
    ok("console enters Anywhere mode (pill visible)");
  } catch { return fail("anywhere pill", "never appeared"); }

  // welcome must arrive through the actual public internet (relay tier)
  try {
    await page.waitForFunction(
      () => /encrypted relay|direct P2P/.test(document.querySelector('[data-testid="anywhere-pill"]')?.textContent ?? ""),
      null, { timeout: 45_000 },
    );
    ok("paired through public relays (welcome received)");
  } catch { return fail("relay pairing", `pill stuck: ${await pill.textContent()}`); }

  console.log("\n— full remote journey: import → run → complete, all through the tunnel —");
  await page.locator('input[type="file"]').setInputFiles(path.join(root, "e2e", "fixtures", "sample.nocturne.json"));
  await page.getByTestId("import-confirm").click();
  const nameOk = await page.getByTestId("wf-name").inputValue();
  if (nameOk === "E2E Sample") ok("workflow imported over the tunnel"); else fail("tunnel import", nameOk);

  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-projectroot").fill(PROJ);
  await page.getByTestId("run-confirm").click();
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="run-status"]')?.textContent === "completed",
      null, { timeout: 45_000 },
    );
    ok("run started and completed via the tunnel");
  } catch { return fail("tunnel run", (await page.getByTestId("run-status").textContent().catch(() => "no status")) ?? "?"); }
  const stepA = await page.getByTestId("step-a").textContent();
  if (stepA?.includes("ANYWHERE-DONE")) ok("live step output streamed to the console"); else fail("step output", stepA ?? "empty");

  console.log("\n— approval gate, approved from the remote console —");
  const gated = {
    nocturne: 1, id: "anywhere-gate", name: "Anywhere Gate", description: "", params: [],
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
      { id: "work", type: "agent", position: { x: 0, y: 120 }, data: { title: "work", prompt: "do the thing", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 0, backoffSec: 1 }, outputSchema: null } },
      { id: "gate", type: "approval", position: { x: 0, y: 240 }, data: { message: "ship it?" } },
      { id: "ship", type: "agent", position: { x: 0, y: 360 }, data: { title: "ship", prompt: "ship it", model: "haiku", cwd: "", allowedTools: [], permissionMode: "dontAsk", continueFrom: null, retry: { max: 0, backoffSec: 1 }, outputSchema: null } },
      { id: "end", type: "end", position: { x: 0, y: 480 }, data: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "work" },
      { id: "e2", source: "work", target: "gate" },
      { id: "e3", source: "gate", target: "ship" },
      { id: "e4", source: "ship", target: "end" },
    ],
  };
  const gatedFile = path.join(HOME, "gate.nocturne.json");
  writeFileSync(gatedFile, JSON.stringify(gated));
  await page.locator('input[type="file"]').setInputFiles(gatedFile);
  await page.getByTestId("import-confirm").click();
  await page.getByTestId("run-btn").click();
  await page.getByTestId("run-projectroot").fill(PROJ);
  await page.getByTestId("run-confirm").click();
  try {
    await page.getByTestId("approve-gate").waitFor({ state: "visible", timeout: 30_000 });
    ok("approval gate reached the remote console");
  } catch { return fail("approval gate", "approve button never appeared"); }
  await page.getByTestId("approve-gate").click();
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="run-status"]')?.textContent === "completed",
      null, { timeout: 45_000 },
    );
    ok("approved from the console; run shipped");
  } catch { return fail("approve→complete", "run did not complete after approval"); }

  // record which tier carried it (both are wins; P2P expected on loopback)
  const finalPill = await pill.textContent();
  console.log(`\n  transport tier at the end: ${finalPill}`);
  if (finalPill?.includes("direct P2P")) ok("upgraded to a direct P2P DataChannel (browser ↔ node-datachannel)");
  else ok(`stayed on the encrypted relay floor (still fully functional): ${finalPill}`);
}

async function cleanup() {
  try { await browser?.close(); } catch {}
  try { site?.close(); } catch {}
  if (daemon) { try { process.kill(daemon.pid, "SIGKILL"); } catch {} }
  await sleep(300);
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}

main()
  .catch((e) => { fail("unexpected", e?.stack ?? String(e)); })
  .finally(async () => {
    await cleanup();
    const passed = results.filter(([, p]) => p).length;
    console.log(`\n  ${passed}/${results.length} checks passed`);
    process.exit(results.every(([, p]) => p) ? 0 : 1);
  });
