import type { Workflow, WorkflowEdge, WorkflowNode } from "./schema.js";

export interface DagView {
  nodeById: Map<string, WorkflowNode>;
  /** node id -> ids of direct successors */
  successors: Map<string, string[]>;
  /** node id -> ids of direct predecessors */
  predecessors: Map<string, string[]>;
}

export function buildDag(wf: Pick<Workflow, "nodes" | "edges">): DagView {
  const nodeById = new Map<string, WorkflowNode>();
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();

  for (const n of wf.nodes) {
    nodeById.set(n.id, n);
    successors.set(n.id, []);
    predecessors.set(n.id, []);
  }
  for (const e of wf.edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    successors.get(e.source)!.push(e.target);
    predecessors.get(e.target)!.push(e.source);
  }
  return { nodeById, successors, predecessors };
}

/** Returns the ids of any nodes that participate in a cycle. Empty = acyclic. */
export function findCycle(wf: Pick<Workflow, "nodes" | "edges">): string[] {
  const { successors, nodeById } = buildDag(wf);
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeById.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of successors.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        // found a back-edge; slice the cycle out of the current stack
        const start = stack.indexOf(next);
        return stack.slice(start);
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of nodeById.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return [];
}

/**
 * Kahn topological order. Throws if the graph has a cycle
 * (callers should validate first). Order among ready nodes is stable by insertion.
 */
export function topoSort(wf: Pick<Workflow, "nodes" | "edges">): string[] {
  const { successors, predecessors, nodeById } = buildDag(wf);
  const indegree = new Map<string, number>();
  for (const id of nodeById.keys()) indegree.set(id, (predecessors.get(id) ?? []).length);

  const queue: string[] = [];
  for (const n of wf.nodes) if ((indegree.get(n.id) ?? 0) === 0) queue.push(n.id);

  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of successors.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== wf.nodes.length) {
    throw new Error("topoSort called on a cyclic graph");
  }
  return order;
}

/** Node ids not reachable from any `start` node. */
export function unreachableNodes(wf: Pick<Workflow, "nodes" | "edges">): string[] {
  const { successors, nodeById } = buildDag(wf);
  const seen = new Set<string>();
  const starts = [...nodeById.values()].filter((n) => n.type === "start").map((n) => n.id);
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of successors.get(id) ?? []) stack.push(next);
  }
  return [...nodeById.keys()].filter((id) => !seen.has(id));
}
