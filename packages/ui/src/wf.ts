import type { Node, Edge } from "@xyflow/react";
import type { Workflow, NodeKind } from "./types";

export interface Meta {
  id: string;
  name: string;
  description: string;
  params: Workflow["params"];
}

/** Default `data` payload for a freshly-dropped node of each kind. */
export function defaultData(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "agent":
      return {
        title: "New step",
        prompt: "",
        model: "inherit",
        cwd: "",
        allowedTools: [],
        permissionMode: "dontAsk",
        continueFrom: null,
        retry: { max: 1, backoffSec: 60 },
        outputSchema: null,
      };
    case "wait":
      return { mode: "limitReset" };
    case "approval":
      return { message: "Approve to continue." };
    default:
      return {};
  }
}

export function toRf(wf: Workflow): { nodes: Node[]; edges: Edge[]; meta: Meta } {
  const nodes: Node[] = wf.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: { ...(("data" in n && n.data) || {}) } as Record<string, unknown>,
  }));
  const edges: Edge[] = wf.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  return {
    nodes,
    edges,
    meta: { id: wf.id, name: wf.name, description: wf.description ?? "", params: wf.params ?? [] },
  };
}

export function toWorkflow(meta: Meta, nodes: Node[], edges: Edge[]): Workflow {
  return {
    nocturne: 1,
    id: meta.id,
    name: meta.name || "Untitled workflow",
    description: meta.description ?? "",
    params: meta.params ?? [],
    nodes: nodes.map((n) => {
      const kind = n.type as NodeKind;
      const base = { id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } };
      if (kind === "start" || kind === "end") return { ...base, type: kind };
      return { ...base, type: kind, data: n.data };
    }) as Workflow["nodes"],
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

let idc = 0;
export function freshId(kind: string): string {
  idc += 1;
  return `${kind}-${Date.now().toString(36)}-${idc}`;
}
