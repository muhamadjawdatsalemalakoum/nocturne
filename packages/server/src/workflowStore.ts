import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeOrThrow, type Workflow } from "@nocturne/core";
import { nocturneHome } from "@nocturne/engine";

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  updatedAt: number;
}

/** Persists the workflow library under ~/.nocturne/workflows/<id>.json. */
export class WorkflowStore {
  private dir: string;

  constructor(home = nocturneHome()) {
    this.dir = path.join(home, "workflows");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Reject ids that could escape the workflows directory (path traversal). */
  private safeId(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === ".." || id.includes("..")) {
      throw new Error(`Invalid workflow id: ${id}`);
    }
    return id;
  }

  private file(id: string): string {
    return path.join(this.dir, `${this.safeId(id)}.json`);
  }

  async list(): Promise<WorkflowSummary[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: WorkflowSummary[] = [];
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      try {
        const raw = await fs.readFile(path.join(this.dir, n), "utf8");
        const wf = JSON.parse(raw) as Workflow;
        const stat = await fs.stat(path.join(this.dir, n));
        out.push({
          id: wf.id,
          name: wf.name,
          description: wf.description ?? "",
          nodeCount: wf.nodes?.length ?? 0,
          updatedAt: stat.mtimeMs,
        });
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Workflow | null> {
    try {
      const raw = await fs.readFile(this.file(id), "utf8");
      return JSON.parse(raw) as Workflow;
    } catch {
      return null;
    }
  }

  /** Validates then persists. Throws on invalid workflow. */
  async save(input: unknown): Promise<Workflow> {
    const wf = normalizeOrThrow(input);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(wf.id), JSON.stringify(wf, null, 2), "utf8");
    return wf;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.rm(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}
