import express, { type Express, type Request, type Response } from "express";
import { createServer as createHttpServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { promises as fs } from "node:fs";
import {
  exportWorkflow,
  importWorkflow,
  newWorkflow,
  normalizeOrThrow,
  type Workflow,
} from "@nocturne/core";
import type { Engine, RunEvent } from "@nocturne/engine";
import { WorkflowStore } from "./workflowStore.js";
import type { RunStore } from "@nocturne/engine";

/** A liveness-tracked socket (ws' extra fields aren't in its public type). */
type LiveSocket = WebSocket & { isAlive?: boolean };
/** Drop a client once its unsent buffer exceeds this (slow/stalled consumer). */
const MAX_WS_BUFFER = 8 * 1024 * 1024;

/** Fans run events out to connected WebSocket clients. */
export class Broadcaster {
  private clients = new Set<LiveSocket>();
  add(ws: LiveSocket): void {
    ws.isAlive = true;
    this.clients.add(ws);
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => {
      this.clients.delete(ws);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });
  }
  broadcast(ev: RunEvent): void {
    const msg = JSON.stringify(ev);
    for (const ws of this.clients) {
      // skip a stalled reader rather than buffering unbounded run output in memory
      if (ws.bufferedAmount > MAX_WS_BUFFER) continue;
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
  /** Ping every client; terminate any that didn't pong since the last sweep. */
  heartbeat(): void {
    for (const ws of this.clients) {
      if (ws.isAlive === false) {
        this.clients.delete(ws);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* will be pruned next sweep */
      }
    }
  }
  get size(): number {
    return this.clients.size;
  }
}

/** An error carrying an intended HTTP status (client-side / validation failures). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Client validation errors → 400; everything unexpected → 500 (generic, logged). */
function statusFor(err: Error): number {
  if (err instanceof HttpError) return err.status;
  if (/^Invalid workflow|^Not valid JSON|^Invalid workflow id|is required|is not a directory/i.test(err.message)) return 400;
  return 500;
}

export interface ServerDeps {
  engine: Engine;
  workflowStore: WorkflowStore;
  runStore: RunStore;
  broadcaster: Broadcaster;
  version?: string;
  /** directory of the built UI to serve at / (optional). */
  staticDir?: string;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    fn(req, res).catch((e: unknown) => {
      if (res.headersSent) return;
      const err = e instanceof Error ? e : new Error(String(e));
      const status = statusFor(err);
      if (status >= 500) {
        console.error(`[nocturne] ${req.method} ${req.path} failed:`, err);
        res.status(500).json({ error: "internal server error" });
      } else {
        res.status(status).json({ error: err.message });
      }
    });
  };

export function buildApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  // Localhost-only tool. Reflect CORS only for localhost origins, and reject
  // cross-origin state-changing requests (drive-by CSRF / DNS-rebinding defense).
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (["POST", "PUT", "DELETE"].includes(req.method) && origin && !LOCAL_ORIGIN.test(origin)) {
      res.status(403).json({ error: "cross-origin request blocked" });
      return;
    }
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/api/health", wrap(async (_req, res) => {
    res.json({ ok: true, version: deps.version ?? "0.1.0" });
  }));

  // ---- workflow library ----
  app.get("/api/workflows", wrap(async (_req, res) => {
    res.json(await deps.workflowStore.list());
  }));

  app.post("/api/workflows", wrap(async (req, res) => {
    const wf = await deps.workflowStore.save(req.body);
    res.json(wf);
  }));

  app.get("/api/workflows/new", wrap(async (req, res) => {
    res.json(newWorkflow(typeof req.query["name"] === "string" ? (req.query["name"] as string) : undefined));
  }));

  app.get("/api/workflows/:id", wrap(async (req, res) => {
    const wf = await deps.workflowStore.get(req.params.id!);
    if (!wf) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(wf);
  }));

  app.put("/api/workflows/:id", wrap(async (req, res) => {
    const body = { ...(req.body as Workflow), id: req.params.id! };
    const wf = await deps.workflowStore.save(body);
    res.json(wf);
  }));

  app.delete("/api/workflows/:id", wrap(async (req, res) => {
    res.json({ deleted: await deps.workflowStore.delete(req.params.id!) });
  }));

  // ---- import / export ----
  app.post("/api/workflows/import", wrap(async (req, res) => {
    const text = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const outcome = importWorkflow(text); // throws -> 400
    res.json({ workflow: outcome.workflow, summary: outcome.summary, validation: outcome.validation });
  }));

  app.get("/api/workflows/:id/export", wrap(async (req, res) => {
    const wf = await deps.workflowStore.get(req.params.id!);
    if (!wf) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const text = exportWorkflow(wf);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${slug(wf.name)}.nocturne.json"`);
    res.send(text);
  }));

  // ---- runs ----
  app.post("/api/runs", wrap(async (req, res) => {
    const { workflowId, workflow, projectRoot, params } = req.body as {
      workflowId?: string;
      workflow?: Workflow;
      projectRoot: string;
      params?: Record<string, string>;
    };
    if (!projectRoot) throw new HttpError(400, "projectRoot is required");
    let wf = workflow;
    if (!wf && workflowId) wf = (await deps.workflowStore.get(workflowId)) ?? undefined;
    if (!wf) throw new HttpError(400, "workflow or a known workflowId is required");
    // validate an inline workflow before scheduling it — the library save path does the
    // same, so a run never enters the engine with schema invariants unenforced.
    wf = normalizeOrThrow(wf);
    const stat = await fs.stat(projectRoot).catch(() => null);
    if (!stat?.isDirectory()) throw new HttpError(400, `projectRoot is not a directory: ${projectRoot}`);
    const state = await deps.engine.beginRun(wf, projectRoot, params ?? {});
    res.json(state);
  }));

  app.get("/api/runs", wrap(async (req, res) => {
    const all = await deps.runStore.list();
    const wfId = req.query["workflowId"];
    res.json(typeof wfId === "string" ? all.filter((r) => r.workflowId === wfId) : all);
  }));

  app.get("/api/runs/:id", wrap(async (req, res) => {
    const state = await deps.runStore.load(req.params.id!);
    if (!state) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(state);
  }));

  app.get("/api/runs/:id/events", wrap(async (req, res) => {
    res.json(await deps.runStore.readEvents(req.params.id!));
  }));

  app.post("/api/runs/:id/pause", wrap(async (req, res) => {
    res.json(await deps.engine.pause(req.params.id!));
  }));
  app.post("/api/runs/:id/resume", wrap(async (req, res) => {
    res.json(await deps.engine.resume(req.params.id!));
  }));
  app.post("/api/runs/:id/cancel", wrap(async (req, res) => {
    res.json(await deps.engine.cancel(req.params.id!));
  }));

  app.post("/api/runs/:id/approve", wrap(async (req, res) => {
    const { nodeId, approved, note } = req.body as { nodeId: string; approved: boolean; note?: string };
    res.json(await deps.engine.approve(req.params.id!, nodeId, approved, note ?? ""));
  }));

  // Unknown /api paths must return a JSON 404, never the SPA HTML.
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    // SPA fallback for everything else
    app.get(/.*/, (_req, res) => res.sendFile("index.html", { root: deps.staticDir! }));
  }

  return app;
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(deps: ServerDeps, port = 5151, host = "127.0.0.1"): Promise<RunningServer> {
  const app = buildApp(deps);
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws) => deps.broadcaster.add(ws));

  // prune half-open sockets that never fire 'close' (client crash, sleep, dropped link)
  const heartbeat = setInterval(() => deps.broadcaster.heartbeat(), 30_000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}
