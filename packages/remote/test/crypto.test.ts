import { describe, it, expect } from "vitest";
import {
  deriveKeys,
  deriveTopic,
  seal,
  open,
  randomSecret,
  ReplayGuard,
  toB64Url,
  fromB64Url,
} from "../src/index.js";

describe("crypto", () => {
  it("seals and opens across directions", async () => {
    const secret = randomSecret();
    const client = await deriveKeys(secret, "client");
    const daemon = await deriveKeys(secret, "daemon");

    const sealed = await seal(client, { t: "req", id: "a.1", method: "GET", path: "/api/health" });
    const opened = (await open(daemon, sealed)) as { t: string; path: string };
    expect(opened.t).toBe("req");
    expect(opened.path).toBe("/api/health");

    const back = await seal(daemon, { t: "res", id: "a.1", status: 200 });
    expect(((await open(client, back)) as { status: number }).status).toBe(200);
  });

  it("rejects reflection: a frame sealed by one side cannot be opened by that same side", async () => {
    const secret = randomSecret();
    const client = await deriveKeys(secret, "client");
    const sealed = await seal(client, { hello: true });
    await expect(open(client, sealed)).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const secret = randomSecret();
    const client = await deriveKeys(secret, "client");
    const daemon = await deriveKeys(secret, "daemon");
    const sealed = await seal(client, { x: 1 });
    const buf = Buffer.from(sealed, "base64");
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
    await expect(open(daemon, buf.toString("base64"))).rejects.toThrow();
  });

  it("rejects the wrong secret", async () => {
    const a = await deriveKeys(randomSecret(), "client");
    const b = await deriveKeys(randomSecret(), "daemon");
    await expect(open(b, await seal(a, { x: 1 }))).rejects.toThrow();
  });

  it("derives a stable topic that does not reveal the secret", async () => {
    const secret = randomSecret();
    const t1 = await deriveTopic(secret);
    const t2 = await deriveTopic(secret);
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(t1).not.toContain(toB64Url(secret).slice(0, 8));
    expect(await deriveTopic(randomSecret())).not.toBe(t1);
  });

  it("b64url round-trips", () => {
    const secret = randomSecret();
    expect(fromB64Url(toB64Url(secret))).toEqual(secret);
  });

  it("replay guard: fresh once, replayed never, stale rejected", () => {
    const g = new ReplayGuard(90_000);
    const now = Date.now();
    expect(g.check("ev1", now, now)).toBe(true);
    expect(g.check("ev1", now, now)).toBe(false); // exact replay
    expect(g.check("ev2", now - 100_000, now)).toBe(false); // stale
    expect(g.check("ev3", now + 100_000, now)).toBe(false); // from the future
    expect(g.check("ev4", now - 1000, now)).toBe(true);
  });

  it("replay guard evicts oldest beyond cap", () => {
    const g = new ReplayGuard(90_000, 4);
    const now = Date.now();
    for (let i = 0; i < 6; i++) expect(g.check(`e${i}`, now, now)).toBe(true);
    // e0/e1 evicted — but that only matters for memory; fresh ids still pass
    expect(g.check("e5", now, now)).toBe(false); // still remembered
  });
});
