import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RunEvent, RunState } from "./types.js";

/** Root under which all runs, workflows and config live. Honors NOCTURNE_HOME. */
export function nocturneHome(): string {
  return process.env["NOCTURNE_HOME"] || path.join(os.homedir(), ".nocturne");
}

/** Atomic file write: write a temp sibling then rename over the target. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const rand = Math.floor(performance.now()).toString(36) + Math.random().toString(36).slice(2, 8);
  const tmp = `${file}.${process.pid}.${rand}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch {
    // Some platforms/AV reject rename-over-existing. Back the target up first so there
    // is never a window with no valid file (a crash mid-swap leaves the .bak to recover).
    const bak = `${file}.bak`;
    await fs.rename(file, bak).catch(() => {}); // target may legitimately not exist yet
    try {
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(bak, { force: true }).catch(() => {});
    }
  }
}

/** Read a JSON file, falling back to its `.bak` (left by an interrupted atomicWrite). */
async function readJsonWithBackup<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    try {
      return JSON.parse(await fs.readFile(`${file}.bak`, "utf8")) as T;
    } catch {
      return null;
    }
  }
}

export class RunStore {
  readonly runsDir: string;

  constructor(private home = nocturneHome()) {
    this.runsDir = path.join(this.home, "runs");
  }

  private dir(runId: string): string {
    return path.join(this.runsDir, runId);
  }
  private stateFile(runId: string): string {
    return path.join(this.dir(runId), "state.json");
  }
  private eventsFile(runId: string): string {
    return path.join(this.dir(runId), "events.ndjson");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  async create(state: RunState): Promise<void> {
    await fs.mkdir(this.dir(state.runId), { recursive: true });
    await this.save(state);
    await this.appendEvent({ type: "run.created", runId: state.runId, at: state.createdAt });
  }

  async save(state: RunState): Promise<void> {
    state.updatedAt = Date.now();
    await atomicWrite(this.stateFile(state.runId), JSON.stringify(state, null, 2));
  }

  async load(runId: string): Promise<RunState | null> {
    return readJsonWithBackup<RunState>(this.stateFile(runId));
  }

  async list(): Promise<RunState[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.runsDir);
    } catch {
      return [];
    }
    const out: RunState[] = [];
    for (const id of entries) {
      const s = await this.load(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async appendEvent(ev: RunEvent): Promise<void> {
    await fs.mkdir(this.dir(ev.runId), { recursive: true });
    await fs.appendFile(this.eventsFile(ev.runId), JSON.stringify(ev) + "\n", "utf8");
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await fs.readFile(this.eventsFile(runId), "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunEvent);
    } catch {
      return [];
    }
  }
}
