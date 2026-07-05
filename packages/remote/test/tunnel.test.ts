import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket as NodeWebSocket, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  TunnelClient,
  TunnelServer,
  splitFrame,
  Reassembler,
  coalesceForRelay,
  encodePairingPayload,
  decodePairingPayload,
  payloadFromFragment,
  consoleUrl,
  randomSecret,
  toB64Url,
  type Frame,
  type RtcSide,
} from "../src/index.js";

/**
 * A minimal in-memory NIP-01 relay: REQ subscribes with a #x filter,
 * EVENT broadcasts to every matching subscription (including the sender's
 * own — real relays echo, our bus must drop its own pubkey).
 */
function startMockRelay(): Promise<{ url: string; close: () => void; published: () => number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    let published = 0;
    const subs = new Map<WsSocket, Map<string, { kinds?: number[]; "#x"?: string[] }>>();
    wss.on("connection", (ws) => {
      subs.set(ws, new Map());
      ws.on("close", () => subs.delete(ws));
      ws.on("message", (raw) => {
        let msg: unknown[];
        try {
          msg = JSON.parse(String(raw)) as unknown[];
        } catch {
          return;
        }
        if (msg[0] === "REQ") {
          subs.get(ws)?.set(msg[1] as string, (msg[2] ?? {}) as { kinds?: number[]; "#x"?: string[] });
          ws.send(JSON.stringify(["EOSE", msg[1]]));
        }
        if (msg[0] === "EVENT") {
          const ev = msg[1] as { id: string; kind: number; tags: string[][] };
          published += 1;
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));
          const x = ev.tags.find((t) => t[0] === "x")?.[1];
          for (const [sock, m] of subs) {
            if (sock.readyState !== sock.OPEN) continue;
            for (const [subId, filter] of m) {
              const kindOk = !filter.kinds || filter.kinds.includes(ev.kind);
              const tagOk = !filter["#x"] || (x !== undefined && filter["#x"].includes(x));
              if (kindOk && tagOk) sock.send(JSON.stringify(["EVENT", subId, ev]));
            }
          }
        }
      });
    });
    wss.on("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close(), published: () => published });
    });
  });
}

/** A loopback "WebRTC" pair: two RtcSides wired directly, opening after one full offer/answer/candidate exchange. */
function fakeRtcPair(): { client: () => RtcSide; daemon: () => RtcSide } {
  const mk = () => {
    const side: {
      peer: typeof side | null;
      open: boolean;
      cbs: { signal?: (m: { sub: string; sdp?: string }) => void; open?: () => void; close?: () => void; message?: (t: string) => void };
      api: RtcSide;
    } = {
      peer: null,
      open: false,
      cbs: {},
      api: {
        signal(msg) {
          // answering side: respond to an offer with an answer, then a candidate
          if (msg.sub === "offer") {
            setTimeout(() => {
              side.cbs.signal?.({ sub: "answer", sdp: "v=0 answer" });
              side.cbs.signal?.({ sub: "cand" });
            }, 5);
          }
          // initiating side: an answer means the channel can open
          if (msg.sub === "answer") {
            setTimeout(() => {
              side.open = true;
              side.peer!.open = true;
              side.cbs.open?.();
              side.peer!.cbs.open?.();
            }, 5);
          }
        },
        onSignal(cb) {
          side.cbs.signal = cb;
        },
        onOpen(cb) {
          side.cbs.open = cb;
        },
        onClose(cb) {
          side.cbs.close = cb;
        },
        onMessage(cb) {
          side.cbs.message = cb;
        },
        send(text) {
          if (!side.open || !side.peer) throw new Error("not open");
          setTimeout(() => side.peer!.cbs.message?.(text), 0);
        },
        close() {
          if (side.open) {
            side.open = false;
            if (side.peer) side.peer.open = false;
            side.cbs.close?.();
            side.peer?.cbs.close?.();
          }
        },
      },
    };
    return side;
  };
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  // initiator kicks off by "creating" the offer as soon as it's constructed
  let clientTaken = false;
  return {
    client: () => {
      if (!clientTaken) {
        clientTaken = true;
        setTimeout(() => a.cbs.signal?.({ sub: "offer", sdp: "v=0 offer" }), 5);
      }
      return a.api;
    },
    daemon: () => b.api,
  };
}

const wait = (ms: number) => new Promise((s) => setTimeout(s, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await wait(25);
  }
}

describe("pairing payload", () => {
  it("round-trips and validates", () => {
    const secret = randomSecret();
    const blob = encodePairingPayload({ v: 1, s: toB64Url(secret), r: ["wss://relay.example"], n: "TEST-PC" });
    const p = decodePairingPayload(blob);
    expect(p.n).toBe("TEST-PC");
    expect(p.r).toEqual(["wss://relay.example"]);
  });

  it("rejects bad secrets, versions, and non-wss relays", () => {
    const good = { v: 1 as const, s: toB64Url(randomSecret()), r: ["wss://x.y"], n: "a" };
    expect(() => decodePairingPayload(encodePairingPayload({ ...good, s: toB64Url(new Uint8Array(8)) }))).toThrow(/32 bytes/);
    expect(() => decodePairingPayload(encodePairingPayload({ ...good, r: [] }))).toThrow(/no relays/);
    expect(() => decodePairingPayload(encodePairingPayload({ ...good, r: ["ws://insecure"] }))).toThrow(/wss/);
  });

  it("travels in a URL fragment, never a query string", () => {
    const p = { v: 1 as const, s: toB64Url(randomSecret()), r: ["wss://x.y"], n: "PC" };
    const url = consoleUrl("https://example.github.io/nocturne/app", p);
    expect(url).toContain("/#pair=");
    expect(new URL(url).search).toBe("");
    const back = payloadFromFragment(new URL(url).hash);
    expect(back?.n).toBe("PC");
    expect(payloadFromFragment("#nothing")).toBeNull();
  });
});

describe("frame splitting", () => {
  it("splits oversize frames and reassembles them", () => {
    const big: Frame = { t: "res", id: "a.1", status: 200, body: { blob: "x".repeat(100_000) } };
    const parts = splitFrame(big, 32_000);
    expect(parts.length).toBeGreaterThan(1);
    const r = new Reassembler();
    let out: Frame | null = null;
    // deliberately feed out of order — relays give no ordering guarantee
    for (const part of [...parts].reverse()) out = r.feed(part) ?? out;
    expect(out).not.toBeNull();
    expect((out as { body: { blob: string } }).body.blob.length).toBe(100_000);
  });

  it("passes small frames through untouched", () => {
    const small: Frame = { t: "ping", sid: "s" };
    expect(splitFrame(small, 32_000)).toEqual([small]);
    expect(new Reassembler().feed(small)).toEqual(small);
  });
});

describe("relay coalescing", () => {
  it("keeps only the latest step.activity per step, passes everything else", () => {
    const items = [
      { q: 1, e: { type: "step.activity", runId: "r", nodeId: "a", text: "old" } },
      { q: 2, e: { type: "run.status", runId: "r", status: "running" } },
      { q: 3, e: { type: "step.activity", runId: "r", nodeId: "a", text: "new" } },
      { q: 4, e: { type: "step.activity", runId: "r", nodeId: "b", text: "only" } },
    ];
    const out = coalesceForRelay(items);
    expect(out.map((i) => i.q)).toEqual([2, 3, 4]);
  });
});

describe("tunnel end-to-end over a mock relay", () => {
  let relay: Awaited<ReturnType<typeof startMockRelay>>;
  beforeAll(async () => {
    relay = await startMockRelay();
  });
  afterAll(() => relay.close());

  it("hello→welcome, request/response, event push, big-response chunking", async () => {
    const secret = randomSecret();
    const calls: Array<{ method: string; path: string }> = [];
    const server = await TunnelServer.start({
      secret,
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      name: "TEST-DAEMON",
      version: "9.9.9",
      dispatch: async (req) => {
        calls.push({ method: req.method, path: req.path });
        if (req.path === "/api/big") return { status: 200, body: { blob: "y".repeat(150_000) } };
        if (req.path === "/api/echo") return { status: 200, body: req.body };
        return { status: 200, body: { ok: true } };
      },
    });

    const events: unknown[] = [];
    let status: { tier: string; daemonName?: string } = { tier: "connecting" };
    const client = await TunnelClient.connect({
      secret,
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      onEvent: (e) => events.push(e),
      onStatus: (s) => (status = s),
    });

    await until(() => client.tier === "relay");
    expect(status.daemonName).toBe("TEST-DAEMON");

    const health = await client.request("GET", "/api/health");
    expect(health.status).toBe(200);
    expect((health.body as { ok: boolean }).ok).toBe(true);

    const echo = await client.request("POST", "/api/echo", { params: { name: "x" } });
    expect((echo.body as { params: { name: string } }).params.name).toBe("x");

    // a response far beyond a single relay event — must chunk transparently
    const big = await client.request("GET", "/api/big", undefined, 20_000);
    expect((big.body as { blob: string }).blob.length).toBe(150_000);

    // daemon pushes events; the relay batcher coalesces
    server.onEvent({ type: "run.created", runId: "r1", at: 1 });
    server.onEvent({ type: "step.activity", runId: "r1", nodeId: "n", kind: "text", text: "old", at: 2 });
    server.onEvent({ type: "step.activity", runId: "r1", nodeId: "n", kind: "text", text: "new", at: 3 });
    await until(() => events.length >= 2);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("run.created");
    const activities = events.filter((e) => (e as { type: string }).type === "step.activity");
    expect(activities.length).toBe(1); // coalesced
    expect((activities[0] as { text: string }).text).toBe("new");

    expect(calls.some((c) => c.path === "/api/health")).toBe(true);

    client.close();
    server.close();
  });

  it("a client with the wrong secret gets nothing — not even an error", async () => {
    const server = await TunnelServer.start({
      secret: randomSecret(),
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      name: "SECRET-DAEMON",
      version: "1",
      dispatch: async () => ({ status: 200, body: { leaked: true } }),
    });

    const client = await TunnelClient.connect({
      secret: randomSecret(), // wrong
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
    });

    await wait(1500);
    expect(client.tier).toBe("connecting"); // never welcomed
    await expect(client.request("GET", "/api/health", undefined, 1200)).rejects.toThrow(/timed out/);
    client.close();
    server.close();
  });

  it("upgrades to a DataChannel and routes requests over it", async () => {
    const secret = randomSecret();
    const pair = fakeRtcPair();
    let dispatched = 0;
    const server = await TunnelServer.start({
      secret,
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      name: "P2P-DAEMON",
      version: "1",
      dispatch: async () => {
        dispatched += 1;
        return { status: 200, body: { n: dispatched } };
      },
      makeRtc: pair.daemon,
    });

    const statuses: string[] = [];
    const client = await TunnelClient.connect({
      secret,
      relays: [relay.url],
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      makeRtc: pair.client,
      onStatus: (s) => statuses.push(s.tier),
    });

    await until(() => client.tier === "p2p", 10_000);
    expect(statuses).toContain("relay"); // was on relay first, then upgraded

    const before = relay.published();
    const res = await client.request("GET", "/api/anything");
    expect(res.status).toBe(200);
    // the request rode the DataChannel, not the relay
    expect(relay.published()).toBe(before);

    client.close();
    server.close();
  });
});
