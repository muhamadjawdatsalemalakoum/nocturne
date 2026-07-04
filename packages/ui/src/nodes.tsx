import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useStore } from "./store";
import { Moon, type Phase } from "./moon";
import { IconApproval, IconBranch, IconStart, IconEnd } from "./icons";
import type { StepStatus } from "./types";

function useStatus(id: string): StepStatus | undefined {
  return useStore((s) => s.run?.steps[id]?.status);
}
function useLiveLine(id: string): string | undefined {
  return useStore((s) => {
    const a = s.activity[id];
    return a && a.length ? a[a.length - 1]!.text : undefined;
  });
}

const PHASE: Record<string, Phase> = {
  running: "waxing",
  waiting: "wait",
  succeeded: "full",
  failed: "fail",
};
function phaseFor(status?: StepStatus): Phase {
  return (status && PHASE[status]) ?? "new";
}

/** readout class + label for the recessed LCD strip, by status. */
function readoutFor(status: StepStatus): { cls: string; label: string } {
  switch (status) {
    case "running":
      return { cls: "lit", label: "running" };
    case "waiting":
      return { cls: "wait", label: "waiting · resumes soon" };
    case "succeeded":
      return { cls: "done", label: "complete" };
    case "failed":
      return { cls: "fail", label: "failed" };
    default:
      return { cls: "", label: status };
  }
}

export function AgentNode({ id, data, selected }: NodeProps) {
  const status = useStatus(id);
  const liveLine = useLiveLine(id);
  const d = data as { title?: string; prompt?: string; model?: string };
  const model = d.model ?? "inherit";
  const showLive = status === "running" && liveLine;
  const ro = status ? readoutFor(status) : null;
  return (
    <div className={`node agent ${selected ? "selected" : ""}`} data-status={status} data-testid={`node-${id}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        <span className={`glyph ${status === "waiting" ? "breathe" : ""}`}>
          <Moon phase={phaseFor(status)} size={18} />
        </span>
        <span className="title">{d.title || "Agent step"}</span>
      </div>
      <div className="sub">
        <span className="chip">{model}</span> subagent
      </div>
      {showLive ? (
        <div className="node-live" data-testid={`node-live-${id}`}>
          <span className="pip" />
          <span className="txt">{liveLine}</span>
        </div>
      ) : ro ? (
        <div className={`readout ${ro.cls}`}>{ro.label}</div>
      ) : (
        <div className="prompt-preview">{d.prompt || <span style={{ color: "var(--faint)" }}>No prompt yet — describe what this agent should do.</span>}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function WaitNode({ id, data, selected }: NodeProps) {
  const status = useStatus(id);
  const d = data as { mode?: string; minutes?: number; time?: string };
  const label =
    d.mode === "duration" ? `Wait ${d.minutes ?? 0} min` : d.mode === "until" ? `Wait until ${d.time ?? "--:--"}` : "Wait for limit reset";
  return (
    <div className={`node wait ${selected ? "selected" : ""}`} data-status={status} data-testid={`node-${id}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        <span className={`glyph ${status === "waiting" ? "breathe" : ""}`} style={{ color: "var(--waiting)" }}>
          <Moon phase="wait" size={18} />
        </span>
        <span className="title">{label}</span>
      </div>
      <div className="readout wait">
        {d.mode === "limitReset" ? "holds until your usage window resets" : "timed hold · survives restarts"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function ApprovalNode({ id, data, selected }: NodeProps) {
  const status = useStatus(id);
  const d = data as { message?: string };
  return (
    <div className={`node approval ${selected ? "selected" : ""}`} data-status={status} data-testid={`node-${id}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        <span className="glyph" style={{ color: "var(--accent)" }}>
          <IconApproval className="" />
        </span>
        <span className="title">Approval gate</span>
      </div>
      <div className="prompt-preview">{d.message || "Approve to continue."}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const OP_LABEL: Record<string, string> = {
  contains: "contains",
  not_contains: "doesn't contain",
  equals: "=",
  not_equals: "≠",
  matches: "matches",
  not_empty: "is not empty",
  gt: ">",
  lt: "<",
};

export function ConditionNode({ id, data, selected }: NodeProps) {
  const status = useStatus(id);
  const d = data as { title?: string; left?: string; op?: string; value?: string };
  const left = (d.left || "…").replace(/\{\{steps\.([^.}]+)\.output\}\}/, "$1's output").replace(/\{\{params\.([^}]+)\}\}/, "$1");
  const summary = d.op === "not_empty" ? `${left} ${OP_LABEL[d.op ?? ""] ?? d.op}` : `${left} ${OP_LABEL[d.op ?? ""] ?? d.op} “${d.value ?? ""}”`;
  const verdict = status === "succeeded" ? (useStore.getState().run?.steps[id]?.output ?? "") : "";
  return (
    <div className={`node condition ${selected ? "selected" : ""}`} data-status={status} data-testid={`node-${id}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        <span className="glyph" style={{ color: "var(--accent)" }}>
          <IconBranch className="" />
        </span>
        <span className="title">{d.title || "If"}</span>
      </div>
      <div className="prompt-preview cond-expr">{summary}</div>
      {verdict && <div className={`readout ${verdict === "true" ? "done" : "wait"}`}>took the {verdict === "true" ? "✓ true" : "✕ false"} branch</div>}
      <div className="branch-tags">
        <span className="bt true">✓ true</span>
        <span className="bt false">✕ false</span>
      </div>
      <Handle id="true" type="source" position={Position.Right} style={{ top: "38%" }} />
      <Handle id="false" type="source" position={Position.Right} style={{ top: "72%" }} />
    </div>
  );
}

export function StartNode({ id }: NodeProps) {
  const status = useStatus(id);
  return (
    <div className="node terminal start" data-status={status} data-testid={`node-${id}`} title="Start">
      <span className="glyph">
        <IconStart className="" />
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function EndNode({ id }: NodeProps) {
  const status = useStatus(id);
  return (
    <div className="node terminal end" data-status={status} data-testid={`node-${id}`} title="End">
      <Handle type="target" position={Position.Left} />
      <span className="glyph">
        <IconEnd className="" />
      </span>
    </div>
  );
}

export const nodeTypes = {
  agent: AgentNode,
  wait: WaitNode,
  approval: ApprovalNode,
  condition: ConditionNode,
  start: StartNode,
  end: EndNode,
};
