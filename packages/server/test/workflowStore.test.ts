import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newWorkflow } from "@nocturne/core";
import { WorkflowStore } from "../src/workflowStore.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function tmpHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "noc-wfs-"));
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

describe("WorkflowStore", () => {
  it("save / get / list / delete round-trip", async () => {
    const store = new WorkflowStore(await tmpHome());
    await store.init();
    const wf = newWorkflow("Hello");
    await store.save(wf);
    expect((await store.get(wf.id))?.name).toBe("Hello");
    expect((await store.list()).map((x) => x.id)).toContain(wf.id);
    expect(await store.delete(wf.id)).toBe(true);
    expect(await store.get(wf.id)).toBeNull();
    expect(await store.delete(wf.id)).toBe(false);
  });

  it("rejects path-traversal ids on save/get/delete", async () => {
    const store = new WorkflowStore(await tmpHome());
    await store.init();
    const evil = newWorkflow("x");
    (evil as { id: string }).id = "../../evil";
    await expect(store.save(evil)).rejects.toThrow(/Invalid workflow id/);
    expect(await store.get("../../etc/passwd")).toBeNull(); // safeId throws inside get's try → null
    expect(await store.delete("../../x")).toBe(false);
  });

  it("save rejects an invalid workflow", async () => {
    const store = new WorkflowStore(await tmpHome());
    await store.init();
    await expect(store.save({ nocturne: 1, id: "x", name: "x", nodes: [], edges: [] })).rejects.toThrow();
  });

  it("list skips unreadable files and sorts newest-first", async () => {
    const home = await tmpHome();
    const store = new WorkflowStore(home);
    await store.init();
    await store.save(newWorkflow("A"));
    await new Promise((r) => setTimeout(r, 8));
    await store.save(newWorkflow("B"));
    await fs.writeFile(path.join(home, "workflows", "junk.json"), "{ not json");
    const list = await store.list();
    const names = list.map((x) => x.name);
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names).not.toContain(undefined);
    expect(names.indexOf("B")).toBeLessThan(names.indexOf("A")); // newest first
  });
});
