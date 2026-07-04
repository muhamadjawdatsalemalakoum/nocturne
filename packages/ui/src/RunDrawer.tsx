import { useState } from "react";
import { useStore } from "./store";
import { api } from "./api";
import { IconClose, IconMinus, IconPlus } from "./icons";
import { Moon, type Phase } from "./moon";
import type { RunState, StepStatus } from "./types";

const STATUS_LABEL: Record<string, string> = {
  waiting_timer: "waiting · timer",
  waiting_approval: "waiting · approval",
};

const STEP_PHASE: Record<string, Phase> = {
  running: "waxing",
  waiting: "wait",
  succeeded: "full",
  failed: "fail",
};
const stepPhase = (s: StepStatus): Phase => STEP_PHASE[s] ?? "new";

export function RunDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const run = useStore((s) => s.run);
  const nodes = useStore((s) => s.nodes);
  const activity = useStore((s) => s.activity);
  const setRun = useStore((s) => s.setRun);
  const setToast = useStore((s) => s.setToast);
  const [collapsed, setCollapsed] = useState(false);

  const order = nodes.map((n) => n.id).filter((id) => run?.steps[id]);

  async function act(fn: () => Promise<RunState | null>, label: string) {
    try {
      const s = await fn();
      if (s) setRun(s);
      setToast(label);
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  return (
    <aside className={`panel run ${open ? "open" : ""} ${collapsed ? "collapsed" : ""}`} data-testid="run-drawer">
      <div className="panel-head">
        <span className="p-title">Run</span>
        {run && (
          <span className={`rstatus ${run.status}`} data-testid="run-status">
            {STATUS_LABEL[run.status] ?? run.status}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {run && <span className="cost-pill">${(run.totalCostUsd ?? 0).toFixed(3)}</span>}
        <button className="panel-toggle" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Minimize"}>
          {collapsed ? <IconPlus /> : <IconMinus />}
        </button>
        <button className="panel-toggle" onClick={onClose} title="Close">
          <IconClose />
        </button>
      </div>
      <div className="panel-body">
        {!run && <div style={{ color: "var(--faint)", padding: "18px 4px", textAlign: "center" }}>No active run.</div>}

        {run && (run.status === "waiting_timer" || run.status === "paused" || run.status === "running") && (
          <div className="approve-bar" style={{ marginBottom: 12 }}>
            {run.status === "running" && (
              <button className="btn" onClick={() => act(() => api.pauseRun(run.runId), "Paused")}>Pause</button>
            )}
            {(run.status === "paused" || run.status === "waiting_timer") && (
              <button className="btn primary" onClick={() => act(() => api.resumeRun(run.runId), "Resuming")}>Resume now</button>
            )}
            <button className="btn danger" onClick={() => act(() => api.cancelRun(run.runId), "Canceled")}>Cancel</button>
          </div>
        )}

        {run &&
          order.map((id) => {
            const step = run.steps[id]!;
            const node = nodes.find((n) => n.id === id)!;
            const title = (node.data as { title?: string }).title || labelFor(node.type as string);
            const isGate = node.type === "approval" && run.waitingApprovalNodeId === id && step.status === "waiting";
            const acts = activity[id] ?? [];
            const live = step.status === "running" && acts.length > 0;
            return (
              <div className="step-row" data-st={step.status} key={id} data-testid={`step-${id}`}>
                <div className="sr-head">
                  <span className="sr-glyph"><Moon phase={stepPhase(step.status)} size={13} /></span>
                  <span className="st-name">{title}</span>
                  <span className={`st-badge ${step.status}`} data-testid={`step-status-${id}`}>{step.status}</span>
                </div>
                {live && (
                  <div className="live" data-testid={`live-${id}`}>
                    {acts.slice(-10).map((a, i) => (
                      <div className={`live-line ${a.kind}`} key={i}>{a.text}</div>
                    ))}
                    <span className="live-cursor" />
                  </div>
                )}
                {!live && step.output && <div className="out">{step.output}</div>}
                {step.error && <div className="out" style={{ color: "var(--failed)" }}>{step.error}</div>}
                {isGate && (
                  <div className="approve-bar">
                    <button className="btn primary" data-testid={`approve-${id}`} onClick={() => act(() => api.approve(run.runId, id, true), "Approved")}>Approve</button>
                    <button className="btn danger" onClick={() => act(() => api.approve(run.runId, id, false), "Rejected")}>Reject</button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </aside>
  );
}

function labelFor(kind: string): string {
  return kind === "wait" ? "Wait" : kind === "approval" ? "Approval" : kind === "start" ? "Start" : kind === "end" ? "End" : "Step";
}
