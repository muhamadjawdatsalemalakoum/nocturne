import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ReactFlow, Controls, useReactFlow, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { exportWorkflow, importWorkflow, newWorkflow, type Workflow } from "@nocturne/core";
import { useStore, undo, redo } from "./store";
import { api, connectEvents, type ImportSummary } from "./api";
import { nodeTypes } from "./nodes";
import { MoonMark, Moon } from "./moon";
import { Inspector } from "./Inspector";
import { RunDrawer } from "./RunDrawer";
import { TEMPLATES, type Template } from "./templates";
import type { NodeKind } from "./types";
import {
  IconAgent, IconWait, IconApproval, IconRun, IconExport, IconImport, IconSave, IconUndo, IconRedo, IconEnd,
  IconMinus, IconPlus, IconWrench, IconSearch, IconShield, IconBeaker,
} from "./icons";

const ADD_ITEMS: Array<{ kind: NodeKind; label: string; sub: string; Icon: (p: { className?: string }) => JSX.Element }> = [
  { kind: "agent", label: "Agent", sub: "runs a prompt", Icon: IconAgent },
  { kind: "wait", label: "Wait", sub: "timer · reset", Icon: IconWait },
  { kind: "approval", label: "Approval", sub: "pause for you", Icon: IconApproval },
  { kind: "end", label: "End", sub: "finish a branch", Icon: IconEnd },
];

const TPL_ICON: Record<Template["icon"], JSX.Element> = {
  moon: <Moon phase="waxing" size={17} />,
  wrench: <IconWrench />,
  search: <IconSearch />,
  shield: <IconShield />,
  beaker: <IconBeaker />,
};

export function App() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const selectedId = useStore((s) => s.selectedId);
  const meta = useStore((s) => s.meta);
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const {
    loadWorkflow, onNodesChange, onEdgesChange, onConnect, addNode, select, deleteSelected, duplicateSelected,
    setMeta, setRun, applyEvent, setToast, currentWorkflow,
  } = useStore.getState();

  const rf = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runModal, setRunModal] = useState(false);
  const [review, setReview] = useState<{ summary: ImportSummary; workflow: Workflow } | null>(null);
  const [projectRoot, setProjectRoot] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [collapse, setCollapse] = useState({ add: false, props: false });
  const toggle = (k: "add" | "props") => setCollapse((c) => ({ ...c, [k]: !c[k] }));

  useEffect(() => {
    // connect synchronously so cleanup always tears the socket down, even if the
    // initial fetch is still pending (StrictMode double-mount / fast unmount).
    let cancelled = false;
    const disconnect = connectEvents((ev) => applyEvent(ev));
    (async () => {
      try {
        const wf = await api.newWorkflow("My workflow");
        if (!cancelled) loadWorkflow(wf);
      } catch {
        if (!cancelled) loadWorkflow(newWorkflow("My workflow"));
      }
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [loadWorkflow, applyEvent]);

  useEffect(() => {
    if (!run || ["completed", "failed", "canceled"].includes(run.status)) return;
    const t = setInterval(async () => {
      try {
        setRun(await api.getRun(run.runId));
      } catch { /* ignore */ }
    }, 1500);
    return () => clearInterval(t);
  }, [run, setRun]);

  const doExport = useCallback(() => {
    try {
      const text = exportWorkflow(currentWorkflow());
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(meta.name || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.nocturne.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setToast("Exported");
    } catch (e) {
      setToast(`Export blocked: ${(e as Error).message}`);
    }
  }, [currentWorkflow, meta.name, setToast]);

  const doSave = useCallback(async () => {
    try {
      await api.saveWorkflow(currentWorkflow());
      setToast("Saved to library");
    } catch (e) {
      setToast(`Save failed: ${(e as Error).message}`);
    }
  }, [currentWorkflow, setToast]);

  const onImportFile = useCallback(
    async (file: File) => {
      try {
        const outcome = importWorkflow(await file.text());
        setReview({ summary: outcome.summary, workflow: outcome.workflow });
      } catch (e) {
        setToast(`Import failed: ${(e as Error).message}`);
      }
    },
    [setToast],
  );

  const insertTemplate = useCallback(
    (t: Template) => {
      loadWorkflow(t.build());
      setToast(`Loaded “${t.name}”`);
      setTimeout(() => rf.fitView({ duration: 300, padding: 0.2 }), 60);
    },
    [loadWorkflow, setToast, rf],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void doSave(); }
      else if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); doExport(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
      else if (!typing && (e.key === "Delete" || e.key === "Backspace")) deleteSelected();
      else if (!typing && e.key.toLowerCase() === "f") rf.fitView({ duration: 200, padding: 0.2 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave, doExport, duplicateSelected, deleteSelected, rf]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/nocturne-node") as NodeKind;
      if (kind) { addNode(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })); return; }
      const file = e.dataTransfer.files?.[0];
      if (file) void onImportFile(file);
    },
    [rf, addNode, onImportFile],
  );

  const displayNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);
  const displayEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const src = run?.steps[e.source]?.status;
        const cls = src === "running" ? "noc-active" : src === "waiting" ? "noc-wait" : src === "succeeded" ? "noc-done" : undefined;
        return { ...e, type: "smoothstep", className: cls };
      }),
    [edges, run],
  );

  const running = run && !["completed", "failed", "canceled"].includes(run.status);
  const isEmpty = nodes.every((n) => n.type === "start" || n.type === "end");

  async function launchRun() {
    try {
      await api.saveWorkflow(currentWorkflow());
      const state = await api.startRun({ workflow: currentWorkflow(), projectRoot, params: paramValues });
      setRun(state);
      setRunModal(false);
      setDrawerOpen(true);
      setToast("Run started");
    } catch (e) {
      setToast(`Could not start: ${(e as Error).message}`);
    }
  }

  const addAt = (kind: NodeKind) => addNode(kind, rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));

  return (
    <div className="app">
      <div className="canvas-wrap" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} data-testid="canvas">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => select(n.id)}
          onPaneClick={() => select(null)}
          fitView
          minZoom={0.2}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        {isEmpty && (
          <div className="empty">
            <div className="card">
              <div className="big">A blank night.</div>
              <div style={{ marginTop: 6, fontSize: 13 }}>Pick a template on the left, or drag in a step.</div>
            </div>
          </div>
        )}
      </div>

      {/* floating toolbar */}
      <header className="toolbar">
        <div className="brand">
          <MoonMark size={20} />
          <span className="wordmark">Nocturne</span>
        </div>
        <input className="wf-name" data-testid="wf-name" value={meta.name} onChange={(e) => setMeta({ name: e.target.value })} spellCheck={false} />
        <div className="spacer" />
        {run && <span className="cost-pill" data-testid="top-cost">${(run.totalCostUsd ?? 0).toFixed(3)}</span>}
        <button className="btn ghost icon" title="Undo" onClick={() => undo()}><IconUndo /></button>
        <button className="btn ghost icon" title="Redo" onClick={() => redo()}><IconRedo /></button>
        <button className="btn" data-testid="import-btn" onClick={() => fileRef.current?.click()}><IconImport /> Import</button>
        <button className="btn" data-testid="export-btn" onClick={doExport}><IconExport /> Export</button>
        <button className="btn" data-testid="save-btn" onClick={doSave}><IconSave /> Save</button>
        <button className="btn" data-testid="toggle-drawer" onClick={() => setDrawerOpen((o) => !o)}>Runs</button>
        <button className="btn primary" data-testid="run-btn" onClick={() => setRunModal(true)}><IconRun /> Run</button>
        <input ref={fileRef} type="file" accept=".json,.nocturne.json,application/json" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ""; }} />
      </header>

      {/* left: add + templates */}
      <aside className={`panel left ${collapse.add ? "collapsed" : ""}`} data-testid="palette">
        <div className="panel-head">
          <span className="p-title">Build</span>
          <button className="panel-toggle" onClick={() => toggle("add")} title={collapse.add ? "Expand" : "Minimize"}>
            {collapse.add ? <IconPlus /> : <IconMinus />}
          </button>
        </div>
        <div className="panel-body">
          <div className="section-label">Add step</div>
          <div className="add-grid">
            {ADD_ITEMS.map(({ kind, label, sub, Icon }) => (
              <div key={kind} className="add-item" data-testid={`pal-${kind}`} draggable
                onDragStart={(e) => e.dataTransfer.setData("application/nocturne-node", kind)}
                onClick={() => addAt(kind)}>
                <span className="ico"><Icon /></span>
                <div><div className="lbl">{label}</div><div className="sub">{sub}</div></div>
              </div>
            ))}
          </div>
          <div className="section-label">Start from a template</div>
          {TEMPLATES.map((t) => (
            <button key={t.id} className="tpl" data-testid={`tpl-${t.id}`} onClick={() => insertTemplate(t)}>
              <span className="tico">{TPL_ICON[t.icon]}</span>
              <div><div className="tname">{t.name}</div><div className="tdesc">{t.description}</div></div>
            </button>
          ))}
        </div>
      </aside>

      {/* right: properties */}
      <aside className={`panel right ${collapse.props ? "collapsed" : ""}`}>
        <div className="panel-head">
          <span className="p-title">{selectedId ? "Properties" : "Workflow"}</span>
          <button className="panel-toggle" onClick={() => toggle("props")} title={collapse.props ? "Expand" : "Minimize"}>
            {collapse.props ? <IconPlus /> : <IconMinus />}
          </button>
        </div>
        <div className="panel-body">
          <Inspector />
        </div>
      </aside>

      {/* run panel */}
      <RunDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {runModal && (
        <div className="overlay" onClick={() => setRunModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="run-modal">
            <h2>Run workflow</h2>
            <div className="sub">Runs locally through your Claude subscription. It keeps running if you close this tab.</div>
            <div className="field">
              <label>Project directory</label>
              <input className="input" data-testid="run-projectroot" type="text" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)} placeholder="C:\path\to\your\project" />
              <div className="hint">The absolute path to the repo the agents work in.</div>
            </div>
            {meta.params.map((p) => (
              <div className="field" key={p.name}>
                <label>{p.name}</label>
                <input className="input" type="text" value={paramValues[p.name] ?? ""} onChange={(e) => setParamValues((v) => ({ ...v, [p.name]: e.target.value }))} />
              </div>
            ))}
            <div className="actions">
              <button className="btn ghost" onClick={() => setRunModal(false)}>Cancel</button>
              <button className="btn primary" data-testid="run-confirm" disabled={!projectRoot} onClick={launchRun}><IconRun /> Start run</button>
            </div>
          </div>
        </div>
      )}

      {review && (
        <div className="overlay" onClick={() => setReview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="import-modal">
            <h2>Import “{review.summary.name}”</h2>
            <div className="sub">{review.summary.nodeCount} nodes · {review.summary.agentSteps.length} agent steps · review what it can do before importing.</div>
            {review.summary.agentSteps.map((s) => (
              <div className="review-step" key={s.id}>
                <div className="rs-top">
                  <strong style={{ fontSize: 12.5 }}>{s.title}</strong>
                  <span className="chip" style={{ marginLeft: "auto" }}>{s.model}</span>
                </div>
                <div className="tools">{s.permissionMode}{s.allowedTools.length ? ` · ${s.allowedTools.join(" ")}` : " · no tools"}{s.cwd ? ` · cwd:${s.cwd}` : ""}</div>
              </div>
            ))}
            <div className="actions">
              <button className="btn ghost" onClick={() => setReview(null)}>Cancel</button>
              <button className="btn primary" data-testid="import-confirm"
                onClick={async () => {
                  loadWorkflow(review.workflow);
                  try { await api.saveWorkflow(review.workflow); } catch { /* keep on canvas */ }
                  setReview(null);
                  setToast("Imported");
                }}>Import to canvas</button>
            </div>
          </div>
        </div>
      )}

      {running && !drawerOpen && (
        <button className="toast" style={{ cursor: "pointer" }} onClick={() => setDrawerOpen(true)}>
          Run in progress — {run!.status.replace("_", " ")} · open ▸
        </button>
      )}
      {toast && <div className="toast" data-testid="toast">{toast}</div>}
    </div>
  );
}
