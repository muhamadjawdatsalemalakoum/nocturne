import path from "node:path";
import { existsSync } from "node:fs";
import {
  buildDag,
  renderTemplate,
  TemplateError,
  type Workflow,
  type TemplateContext,
} from "@nocturne/core";
import type {
  ClaudeActivity,
  ClaudeRunner,
  EngineConfig,
  RunEvent,
  RunState,
  RunStatus,
  StepRecord,
  StepStatus,
} from "./types.js";
import { RunStore } from "./store.js";
import { ErrorParseOracle, type LimitOracle } from "./oracle.js";
import { systemClock, type Clock } from "./clock.js";
import { CliClaudeRunner } from "./claude.js";

export interface EngineDeps {
  store: RunStore;
  runner?: ClaudeRunner;
  oracle?: LimitOracle;
  clock?: Clock;
  config: EngineConfig;
  /** live event sink (e.g. WebSocket broadcaster). */
  onEvent?: (ev: RunEvent) => void;
  /** override webhook poster (tests). */
  postWebhook?: (url: string, body: unknown) => Promise<void>;
}

/** Max consecutive rate-limit hits on one step before we give up (bounds a mis-parsed reset). */
const MAX_LIMIT_HITS = 20;

export class Engine {
  private store: RunStore;
  private runner: ClaudeRunner;
  private oracle: LimitOracle;
  private clock: Clock;
  private config: EngineConfig;
  private onEvent?: (ev: RunEvent) => void;
  private postWebhook: (url: string, body: unknown) => Promise<void>;
  /** per-run scheduled wake handles + serialization guards. */
  private timers = new Map<string, unknown>();
  private driving = new Map<string, Promise<void>>();
  /** per-run mutex: all state read-modify-write critical sections chain through this. */
  private runLocks = new Map<string, Promise<unknown>>();
  /** per-run abort controllers for in-flight agent children (cancel/pause kills them). */
  private aborts = new Map<string, AbortController>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.oracle = deps.oracle ?? new ErrorParseOracle(deps.config.defaultLimitWaitMinutes);
    this.runner =
      deps.runner ?? new CliClaudeRunner(deps.config.claudePath, { oauthToken: deps.config.oauthToken });
    this.onEvent = deps.onEvent;
    this.postWebhook =
      deps.postWebhook ??
      (async (url, body) => {
        try {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch {
          /* best-effort */
        }
      });
  }

  // ---------------------------------------------------------------- public API

  private newRunState(workflow: Workflow, projectRoot: string, params: Record<string, string>): RunState {
    const now = this.clock.now();
    const steps: Record<string, StepRecord> = {};
    for (const n of workflow.nodes) {
      steps[n.id] = { nodeId: n.id, type: n.type, status: "pending", attempts: 0 };
    }
    return {
      runId: cryptoId(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflow,
      projectRoot,
      params: withParamDefaults(workflow, params),
      status: "queued",
      steps,
      totalCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Create a run and drive it to its first suspension/completion (used by tests). */
  async startRun(workflow: Workflow, projectRoot: string, params: Record<string, string>): Promise<RunState> {
    const state = this.newRunState(workflow, projectRoot, params);
    await this.store.create(state);
    await this.driveSerialized(state.runId);
    return (await this.store.load(state.runId))!;
  }

  /** Create a run and drive it in the background; returns the initial (queued) state immediately. */
  async beginRun(workflow: Workflow, projectRoot: string, params: Record<string, string>): Promise<RunState> {
    const state = this.newRunState(workflow, projectRoot, params);
    await this.store.create(state);
    void this.driveSerialized(state.runId);
    return state;
  }

  /** Await any in-flight drive for a run (test/shutdown helper). */
  async idle(runId: string): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const p = this.driving.get(runId);
      if (!p) return;
      await p;
    }
  }

  async resume(runId: string): Promise<RunState | null> {
    const proceed = await this.withRunLock(runId, async () => {
      const state = await this.store.load(runId);
      if (!state || isTerminal(state.status)) return false;
      const now = this.clock.now();
      if (state.status === "paused") {
        // clear the stop so the driver will proceed past its paused/canceled guard.
        // Resume is also the retry gesture: failed steps (including rejected
        // approvals) re-arm as pending so the run can move again instead of
        // instantly re-settling into paused.
        for (const s of Object.values(state.steps)) {
          if (s.status === "failed") {
            s.status = "pending";
            delete s.error;
            delete s.endedAt;
          }
        }
        state.status = "queued";
        delete state.error;
        await this.store.save(state);
      } else if (state.status === "waiting_timer") {
        // "resume now" skips the remaining wait by firing pending timers immediately
        for (const s of Object.values(state.steps)) {
          if (s.status === "waiting" && typeof s.wakeAt === "number") s.wakeAt = now;
        }
        await this.store.save(state);
      }
      return true;
    });
    if (proceed) await this.driveSerialized(runId);
    return this.store.load(runId);
  }

  async approve(runId: string, nodeId: string, approved: boolean, note = ""): Promise<RunState | null> {
    const changed = await this.withRunLock(runId, async () => {
      const state = await this.store.load(runId);
      if (!state) return false;
      const step = state.steps[nodeId];
      if (!step || step.status !== "waiting") return false;
      if (approved) {
        this.setStep(state, step, "succeeded", note || "approved");
        step.output = note || "approved";
        step.endedAt = this.clock.now();
        if (state.waitingApprovalNodeId === nodeId) delete state.waitingApprovalNodeId;
      } else {
        this.setStep(state, step, "failed", "rejected");
        step.error = note || "rejected by user";
        state.error = `Approval rejected at ${nodeId}`;
        if (state.waitingApprovalNodeId === nodeId) delete state.waitingApprovalNodeId;
      }
      await this.store.save(state);
      return true;
    });
    if (changed) await this.driveSerialized(runId);
    return this.store.load(runId);
  }

  async pause(runId: string): Promise<RunState | null> {
    const state = await this.withRunLock(runId, async () => {
      const s = await this.store.load(runId);
      if (!s || isTerminal(s.status)) return s ?? null;
      this.clearTimer(runId);
      await this.setRunStatus(s, "paused");
      await this.store.save(s);
      return s;
    });
    // kill any in-flight agent children — pausing must stop the spend now; the
    // interrupted step re-arms as pending and re-runs on resume.
    this.abortAgents(runId);
    return state;
  }

  async cancel(runId: string): Promise<RunState | null> {
    const state = await this.withRunLock(runId, async () => {
      const s = await this.store.load(runId);
      if (!s) return null;
      this.clearTimer(runId);
      await this.setRunStatus(s, "canceled");
      await this.store.save(s);
      return s;
    });
    this.abortAgents(runId);
    return state;
  }

  /** Abort (tree-kill) any agent children currently executing for this run. */
  private abortAgents(runId: string): void {
    const ac = this.aborts.get(runId);
    if (ac) {
      this.aborts.delete(runId);
      ac.abort();
    }
  }

  /**
   * On daemon start: mark stuck `running` runs interrupted, then (optionally) resume
   * everything resumable. Best-effort housekeeping — one unwritable run must never
   * abort daemon boot, so every persist is guarded per-run.
   */
  async recoverInterrupted(): Promise<void> {
    const runs = await this.store.list().catch(() => [] as RunState[]);
    for (const r of runs) {
      if (r.status === "running") {
        // reset any mid-flight steps so they re-run cleanly
        for (const s of Object.values(r.steps)) {
          if (s.status === "running") s.status = "pending";
        }
        r.status = "interrupted";
        await this.store.save(r).catch(() => {});
      }
    }
    if (!this.config.autoResumeOnStart) return;
    for (const r of runs) {
      if (r.status === "interrupted" || r.status === "waiting_timer" || r.status === "waiting_approval") {
        // catch-up: a past wakeAt fires immediately inside drive
        void this.driveSerialized(r.runId);
      }
    }
  }

  // ---------------------------------------------------------------- driving

  /** Serialize drive() per run so a scheduler wake and a manual resume can't interleave. */
  private driveSerialized(runId: string): Promise<void> {
    const prev = this.driving.get(runId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.drive(runId));
    this.driving.set(
      runId,
      next.finally(() => {
        if (this.driving.get(runId) === next) this.driving.delete(runId);
      }),
    );
    return next;
  }

  /** Per-run mutex: serialize a short critical section against all other state writes. */
  private withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.runLocks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.runLocks.set(runId, next.then(() => {}, () => {}));
    return next;
  }

  /** Persist a single step by merging it into freshly-loaded state (no whole-doc clobber). */
  private async persistStep(runId: string, step: StepRecord): Promise<void> {
    await this.withRunLock(runId, async () => {
      const fresh = await this.store.load(runId);
      if (!fresh) return;
      fresh.steps[step.nodeId] = { ...step };
      fresh.totalCostUsd = Object.values(fresh.steps).reduce((a, s) => a + (s.costUsd ?? 0), 0);
      await this.store.save(fresh);
    });
  }

  private async drive(runId: string): Promise<void> {
    try {
      await this.driveInner(runId);
    } catch (e) {
      // An unexpected engine/IO error must never crash the daemon: pause the run
      // (best-effort) so it can be inspected and resumed, and swallow the throw.
      const s = await this.store.load(runId).catch(() => null);
      if (s && !isTerminal(s.status) && s.status !== "paused") {
        // reset any step left mid-flight so a resume re-dispatches it (never let a
        // stuck 'running' step make settle() falsely mark the run completed)
        for (const step of Object.values(s.steps)) {
          if (step.status === "running") step.status = "pending";
        }
        s.status = "paused";
        s.error = `Engine error: ${e instanceof Error ? e.message : String(e)}`;
        await this.store.save(s).catch(() => {});
        this.onEvent?.({ type: "run.status", runId, status: "paused", at: this.clock.now(), detail: s.error });
      }
    }
  }

  private async driveInner(runId: string): Promise<void> {
    for (;;) {
      const tick = await this.withRunLock(runId, () => this.driveTick(runId));
      if (tick.kind === "done") break;
      if (tick.kind === "again") continue;
      // run the agent batch OUTSIDE the lock; each agent persists its own step via
      // persistStep (lock-merge), so a concurrent approve/pause/cancel is never clobbered.
      // The batch shares one AbortController so cancel/pause can kill the children.
      const ac = new AbortController();
      this.aborts.set(runId, ac);
      try {
        await Promise.all(tick.batch.map((s) => this.runAgent(tick.snapshot, s, ac.signal)));
      } finally {
        if (this.aborts.get(runId) === ac) this.aborts.delete(runId);
      }
      // reload happens at the next tick, picking up results + any control-op changes
    }
  }

  /**
   * One locked scheduling step. Reads fresh state, wakes elapsed timers, advances
   * instantaneous nodes, and either settles the run, asks to loop again, or hands
   * back a batch of agent steps to execute outside the lock.
   */
  private async driveTick(
    runId: string,
  ): Promise<{ kind: "done" } | { kind: "again" } | { kind: "agents"; batch: StepRecord[]; snapshot: RunState }> {
    const state = await this.store.load(runId);
    if (!state || isTerminal(state.status) || state.status === "paused" || state.status === "canceled") {
      return { kind: "done" };
    }
    const { predecessors } = buildDag(state.workflow);
    if (state.status !== "running") await this.setRunStatus(state, "running");

    const now = this.clock.now();

    // 1) wake steps whose timers have elapsed (catch-up covers slept-through waits)
    for (const s of Object.values(state.steps)) {
      if (s.status === "waiting" && typeof s.wakeAt === "number" && s.wakeAt <= now) {
        const node = nodeOf(state.workflow, s.nodeId);
        if (node?.type === "wait") {
          this.setStep(state, s, "succeeded");
          s.output = "";
          s.endedAt = now;
          delete s.wakeAt;
        } else {
          this.setStep(state, s, "pending"); // agent limit/retry backoff: re-arm
          delete s.wakeAt;
        }
      }
    }

    // 2) ready = pending nodes whose predecessors all succeeded
    const ready = Object.values(state.steps).filter(
      (s) =>
        s.status === "pending" &&
        (predecessors.get(s.nodeId) ?? []).every((p) => state.steps[p]?.status === "succeeded" || state.steps[p]?.status === "skipped"),
    );

    if (ready.length === 0) {
      await this.settle(state);
      return { kind: "done" };
    }

    // 3) instantaneous nodes first (start/end/wait/approval)
    const agents: StepRecord[] = [];
    let progressed = false;
    for (const s of ready) {
      const node = nodeOf(state.workflow, s.nodeId)!;
      if (node.type === "start" || node.type === "end") {
        this.setStep(state, s, "succeeded");
        s.output = "";
        progressed = true;
      } else if (node.type === "wait") {
        const wakeAt = computeWakeAt(node.data, now, this.clock, this.config.defaultLimitWaitMinutes);
        if (wakeAt <= now) {
          this.setStep(state, s, "succeeded");
          s.output = "";
        } else {
          s.wakeAt = wakeAt;
          this.setStep(state, s, "waiting", `until ${new Date(wakeAt).toISOString()}`);
        }
        progressed = true;
      } else if (node.type === "approval") {
        this.setStep(state, s, "waiting", (node.data as { message: string }).message);
        state.waitingApprovalNodeId = s.nodeId;
        progressed = true;
      } else {
        agents.push(s);
      }
    }

    if (progressed) {
      await this.store.save(state);
      return { kind: "again" };
    }

    // 4) dispatch a bounded agent batch: mark running + save, then run them lock-free
    const batch = agents.slice(0, Math.max(1, this.config.maxConcurrent));
    for (const s of batch) {
      s.startedAt ??= now;
      this.setStep(state, s, "running");
    }
    await this.store.save(state);
    return { kind: "agents", batch, snapshot: state };
  }

  /** Decide the suspended/terminal status when nothing is immediately runnable. */
  private async settle(state: RunState): Promise<void> {
    const steps = Object.values(state.steps);
    const failed = steps.find((s) => s.status === "failed");
    const waiting = steps.filter((s) => s.status === "waiting");
    const timerWaits = waiting.filter((s) => typeof s.wakeAt === "number");
    const approvalWaits = waiting.filter((s) => nodeOf(state.workflow, s.nodeId)?.type === "approval");

    state.wakeAt = timerWaits.length ? Math.min(...timerWaits.map((s) => s.wakeAt!)) : undefined;

    if (failed) {
      state.error ??= `Step ${failed.nodeId} failed: ${failed.error ?? "unknown"}`;
      await this.setRunStatus(state, "paused", state.error);
    } else if (waiting.length === 0) {
      await this.setRunStatus(state, "completed");
    } else if (approvalWaits.length) {
      state.waitingApprovalNodeId = approvalWaits[0]!.nodeId;
      await this.setRunStatus(state, "waiting_approval");
      if (state.wakeAt) this.scheduleWake(state.runId, state.wakeAt);
    } else if (timerWaits.length) {
      await this.setRunStatus(state, "waiting_timer", `wake at ${new Date(state.wakeAt!).toISOString()}`);
      this.scheduleWake(state.runId, state.wakeAt!);
    } else {
      await this.setRunStatus(state, "paused");
    }
    await this.store.save(state);
  }

  private async runAgent(state: RunState, step: StepRecord, signal?: AbortSignal): Promise<void> {
    const node = nodeOf(state.workflow, step.nodeId)!;
    if (node.type !== "agent") return;
    const d = node.data;
    step.attempts += 1;
    try {
    // build handoff context from succeeded upstream agent outputs
    const stepsCtx: TemplateContext["steps"] = {};
    for (const s of Object.values(state.steps)) {
      if (s.status === "succeeded" && typeof s.output === "string") stepsCtx[s.nodeId] = { output: s.output };
    }
    const ctx: TemplateContext = {
      params: state.params,
      steps: stepsCtx,
      workflow: { id: state.workflow.id, name: state.workflow.name, description: state.workflow.description },
      run: { projectRoot: state.projectRoot },
    };

    let prompt: string;
    try {
      prompt = renderTemplate(d.prompt, ctx);
    } catch (e) {
      if (e instanceof TemplateError) {
        this.setStep(state, step, "failed", e.message);
        step.error = e.message;
        return;
      }
      throw e;
    }

    const cwd = path.resolve(state.projectRoot, d.cwd || ".");
    if (!existsSync(cwd)) {
      step.error = `Working directory does not exist: ${cwd}`;
      step.endedAt = this.clock.now();
      this.setStep(state, step, "failed", step.error);
      return;
    }
    const resumeSessionId = d.continueFrom ? state.steps[d.continueFrom]?.sessionId : undefined;
    const timeoutMs = (d.timeoutSec ?? 1800) * 1000;

    // live streaming preview: broadcast each activity, keep a running text buffer,
    // and flush partial output to disk on a throttle so a reconnect sees progress.
    let live = "";
    let lastFlush = this.clock.now();
    const onActivity = (a: ClaudeActivity) => {
      const text = a.kind === "tool" ? `\u{1F527} ${a.text}` : a.text;
      this.emitLive({ type: "step.activity", runId: state.runId, nodeId: step.nodeId, kind: a.kind, text, at: this.clock.now() });
      if (a.kind === "text") live += (live ? "\n" : "") + a.text;
      const now = this.clock.now();
      if (now - lastFlush > 800) {
        lastFlush = now;
        step.output = live;
        void this.persistStep(state.runId, step).catch(() => {});
      }
    };

    const result = await this.runner.run({
      prompt,
      model: d.model,
      effort: d.effort,
      cwd,
      allowedTools: d.allowedTools,
      permissionMode: d.permissionMode,
      maxBudgetUsd: d.maxBudgetUsd,
      resumeSessionId,
      outputSchema: d.outputSchema ?? undefined,
      timeoutMs,
      onActivity,
      signal,
    });

    step.costUsd = (step.costUsd ?? 0) + result.costUsd;
    if (result.sessionId) step.sessionId = result.sessionId;

    // user-initiated abort (cancel/pause): not a failure, not an attempt — the
    // step re-arms as pending and re-runs on resume.
    if (result.aborted) {
      step.attempts -= 1;
      delete step.wakeAt;
      this.setStep(state, step, "pending", "interrupted by cancel/pause");
      return;
    }

    if (!result.isError) {
      step.output = result.text;
      step.endedAt = this.clock.now();
      step.limitHits = 0;
      this.setStep(state, step, "succeeded");
      this.emit({
        type: "step.output",
        runId: state.runId,
        nodeId: step.nodeId,
        output: result.text,
        costUsd: result.costUsd,
        at: this.clock.now(),
      });
      return;
    }

    // error handling
    if (this.oracle.isLimitError(result)) {
      // a rate limit is not a real attempt — but bound consecutive hits so a
      // mis-parsed reset time (e.g. wrong-timezone early wake) can't loop forever.
      step.limitHits = (step.limitHits ?? 0) + 1;
      if (step.limitHits > MAX_LIMIT_HITS) {
        step.error = `Rate-limited ${step.limitHits}× in a row without progress; giving up. Check your usage window and resume manually.`;
        step.endedAt = this.clock.now();
        this.setStep(state, step, "failed", step.error);
        return;
      }
      const wakeAt = this.oracle.resetAt(result, this.clock.now());
      step.wakeAt = wakeAt;
      step.attempts -= 1;
      this.setStep(state, step, "waiting", `rate limited; resuming at ${new Date(wakeAt).toISOString()}`);
      return;
    }
    const auth = result.apiErrorStatus === 401 || result.apiErrorStatus === 403;
    const budget = /budget/i.test(result.text) || /max.?budget/i.test(String(result.stderr ?? ""));
    // A spawn failure (bad claude path, ENOENT) is a config error, never a transient retry.
    const transient =
      !auth &&
      !budget &&
      !result.spawnError &&
      ((result.apiErrorStatus ?? 0) >= 500 || result.timedOut);

    if (transient && step.attempts <= d.retry.max) {
      const wakeAt = this.clock.now() + d.retry.backoffSec * 1000;
      step.wakeAt = wakeAt;
      this.setStep(state, step, "waiting", `transient error; retry ${step.attempts}/${d.retry.max} at ${new Date(wakeAt).toISOString()}`);
      return;
    }

    step.error = auth
      ? `Authentication failed (${result.apiErrorStatus}). Run \`claude setup-token\` and configure it for the daemon.`
      : budget
        ? "Step exceeded its budget cap."
        : result.spawnError
          ? `Could not launch claude (${String(result.stderr ?? "spawn error")}). Check the claudePath in your config.`
          : `Step failed: ${result.text || result.stderr || "unknown error"}`.slice(0, 500);
    step.endedAt = this.clock.now();
    this.setStep(state, step, "failed", step.error);
    } finally {
      await this.persistStep(state.runId, step);
    }
  }

  // ---------------------------------------------------------------- helpers

  private scheduleWake(runId: string, at: number): void {
    this.clearTimer(runId);
    const delay = Math.max(0, at - this.clock.now());
    const h = this.clock.setTimer(() => {
      this.timers.delete(runId);
      // A timer that already fired must not resurrect a run the operator stopped.
      // Only wake runs that are genuinely waiting/interrupted.
      void this.store
        .load(runId)
        .then((s) => {
          if (s && (s.status === "waiting_timer" || s.status === "waiting_approval" || s.status === "interrupted")) {
            return this.driveSerialized(runId);
          }
          return undefined;
        })
        .catch(() => {});
    }, delay);
    this.timers.set(runId, h);
  }

  private clearTimer(runId: string): void {
    const h = this.timers.get(runId);
    if (h !== undefined) {
      this.clock.clear(h);
      this.timers.delete(runId);
    }
  }

  private setStep(state: RunState, step: StepRecord, status: StepStatus, detail?: string): void {
    step.status = status;
    this.emit({ type: "step.status", runId: state.runId, nodeId: step.nodeId, status, at: this.clock.now(), detail });
  }

  private async setRunStatus(state: RunState, status: RunStatus, detail?: string): Promise<void> {
    if (state.status === status) return;
    state.status = status;
    this.emit({ type: "run.status", runId: state.runId, status, at: this.clock.now(), detail });
    if ((status === "waiting_approval" || status === "failed" || status === "completed" || status === "paused") && this.config.webhookUrl) {
      await this.postWebhook(this.config.webhookUrl, {
        event: status,
        runId: state.runId,
        workflow: state.workflowName,
        detail,
      });
    }
  }

  private emit(ev: RunEvent): void {
    // event logging is best-effort; never let it surface as an unhandled rejection
    void this.store.appendEvent(ev).catch(() => {});
    this.onEvent?.(ev);
  }

  /** Broadcast-only (not persisted): high-frequency live activity for the run preview. */
  private emitLive(ev: RunEvent): void {
    this.onEvent?.(ev);
  }
}

// ---------------------------------------------------------------- free helpers

function isTerminal(s: RunStatus): boolean {
  return s === "completed" || s === "failed" || s === "canceled";
}

function nodeOf(wf: Workflow, id: string): Workflow["nodes"][number] | undefined {
  return wf.nodes.find((n) => n.id === id);
}

function withParamDefaults(wf: Workflow, given: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of wf.params) out[p.name] = given[p.name] ?? p.default;
  for (const [k, v] of Object.entries(given)) out[k] = v;
  return out;
}

/** Compute the absolute wake timestamp for a wait node. */
export function computeWakeAt(
  data: Extract<Workflow["nodes"][number], { type: "wait" }>["data"],
  now: number,
  _clock: Clock,
  defaultLimitWaitMinutes = 60,
): number {
  if (data.mode === "duration") return now + data.minutes * 60 * 1000;
  if (data.mode === "until") {
    const [h, m] = data.time.split(":").map(Number);
    const d = new Date(now);
    // Advance by calendar day (not a fixed +24h) so the next occurrence lands on the
    // right wall-clock HH:MM even across a DST transition (a DST day is 23h/25h long).
    let cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h!, m!, 0, 0);
    if (cand.getTime() <= now) cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h!, m!, 0, 0);
    return cand.getTime();
  }
  // limitReset as a standalone node (no active limit error to parse): hold for the
  // configured default window rather than a hardcoded hour.
  return now + Math.max(1, defaultLimitWaitMinutes) * 60 * 1000;
}

function cryptoId(): string {
  return crypto.randomUUID();
}
