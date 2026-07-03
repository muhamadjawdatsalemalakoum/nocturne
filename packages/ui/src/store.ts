import { create } from "zustand";
import { temporal } from "zundo";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import type { Workflow, RunState, RunEvent, NodeKind, Activity } from "./types";
import { toRf, toWorkflow, defaultData, freshId, type Meta } from "./wf";

const MAX_ACTIVITY = 60;

interface State {
  meta: Meta;
  nodes: Node[];
  edges: Edge[];
  selectedId: string | null;
  run: RunState | null;
  /** live streaming feed per node id (bounded) */
  activity: Record<string, Activity[]>;
  toast: string | null;

  loadWorkflow: (wf: Workflow) => void;
  currentWorkflow: () => Workflow;
  setMeta: (patch: Partial<Meta>) => void;
  addNode: (kind: NodeKind, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (c: Connection) => void;
  select: (id: string | null) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  setRun: (run: RunState | null) => void;
  applyEvent: (ev: RunEvent) => void;
  setToast: (msg: string | null) => void;
}

function debounce(fn: (...a: unknown[]) => void, ms: number): (...a: unknown[]) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: unknown[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const emptyMeta: Meta = { id: "", name: "Untitled workflow", description: "", params: [] };

// zundo v2's option generics are awkward; the cast keeps runtime behavior
// (undo history tracks only the graph, not transient run/selection state).
export const useStore = create<State>()(
  temporal(
    (set, get) => ({
      meta: emptyMeta,
      nodes: [],
      edges: [],
      selectedId: null,
      run: null,
      activity: {},
      toast: null,

      loadWorkflow: (wf) => {
        const { nodes, edges, meta } = toRf(wf);
        set({ nodes, edges, meta, selectedId: null, run: null, activity: {} });
        // a fresh document should not be undoable into the previous one
        useStore.temporal.getState().clear();
      },

      currentWorkflow: () => toWorkflow(get().meta, get().nodes, get().edges),

      setMeta: (patch) => set({ meta: { ...get().meta, ...patch } }),

      addNode: (kind, position) => {
        const id = freshId(kind);
        const node: Node = { id, type: kind, position, data: defaultData(kind) };
        set({ nodes: [...get().nodes, node], selectedId: id });
      },

      updateNodeData: (id, patch) =>
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
        }),

      onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
      onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
      onConnect: (c) => set({ edges: addEdge({ ...c, id: freshId("e") }, get().edges) }),

      select: (id) => set({ selectedId: id }),

      deleteSelected: () => {
        const id = get().selectedId;
        if (!id) return;
        const node = get().nodes.find((n) => n.id === id);
        // structural start/end nodes must stay so the graph never becomes schema-invalid
        if (node && (node.type === "start" || node.type === "end")) return;
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedId: null,
        });
      },

      duplicateSelected: () => {
        const id = get().selectedId;
        const src = get().nodes.find((n) => n.id === id);
        if (!src || src.type === "start" || src.type === "end") return;
        const nid = freshId(src.type ?? "node");
        set({
          nodes: [
            ...get().nodes,
            { ...src, id: nid, position: { x: src.position.x + 40, y: src.position.y + 40 }, data: { ...src.data }, selected: false },
          ],
          selectedId: nid,
        });
      },

      setRun: (run) => set({ run, activity: run ? get().activity : {} }),

      applyEvent: (ev) => {
        const run = get().run;
        if (!run || ("runId" in ev && ev.runId !== run.runId)) return;
        if (ev.type === "step.activity") {
          const list = get().activity[ev.nodeId] ?? [];
          const nextList = [...list, { kind: ev.kind, text: ev.text, at: ev.at }].slice(-MAX_ACTIVITY);
          set({ activity: { ...get().activity, [ev.nodeId]: nextList } });
          return;
        }
        const next: RunState = { ...run, steps: { ...run.steps } };
        if (ev.type === "run.status") next.status = ev.status;
        else if (ev.type === "step.status") {
          const s = next.steps[ev.nodeId];
          if (s) next.steps[ev.nodeId] = { ...s, status: ev.status };
          // clear stale activity when a step (re)starts
          if (ev.status === "running") set({ activity: { ...get().activity, [ev.nodeId]: [] } });
        } else if (ev.type === "step.output") {
          const s = next.steps[ev.nodeId];
          if (s) next.steps[ev.nodeId] = { ...s, output: ev.output, costUsd: ev.costUsd };
          next.totalCostUsd = (next.totalCostUsd ?? 0) + ev.costUsd;
        }
        set({ run: next });
      },

      setToast: (msg) => {
        set({ toast: msg });
        if (msg) setTimeout(() => set((s) => (s.toast === msg ? { toast: null } : {})), 2600);
      },
    }),
    {
      partialize: (s: State) => ({ nodes: s.nodes, edges: s.edges, meta: s.meta }),
      limit: 120,
      handleSet: (handleSet: (...a: unknown[]) => void) => debounce(handleSet, 250),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ),
);

export const undo = () => useStore.temporal.getState().undo();
export const redo = () => useStore.temporal.getState().redo();
