/**
 * The Nocturne tunnel: one tiny wire protocol, three transports.
 *
 * A phone (browser console or native app) talks to the daemon in sealed JSON
 * frames — request/response for the REST API, batched pushes for run events,
 * and WebRTC signaling so the two ends can upgrade themselves from the relay
 * floor to a direct peer-to-peer DataChannel whenever the networks allow it.
 *
 *   client ──hello──▶ daemon          (relay tier: Nostr ephemeral events)
 *   client ◀─welcome── daemon
 *   client ──req───▶ daemon ──▶ local REST dispatch ──▶ ◀─res──
 *   client ◀──ev←batched RunEvents── daemon
 *   client ⇄ webrtc offer/answer/cand ⇄ daemon   → DataChannel opens
 *   …same frames, now direct, full fidelity, no relay in the path.
 *
 * Every frame is sealed (see crypto.ts) before any transport sees it. Frames
 * too large for a relay event are split into `part` frames and reassembled.
 * Events carry monotonic seqs so a client hearing both tiers at once never
 * double-applies. The relay tier coalesces high-frequency step activity to
 * stay a polite guest on public infrastructure; the DataChannel tier doesn't
 * have to and doesn't.
 */

import { deriveKeys, deriveTopic, open, seal, ReplayGuard, type DirectionKeys } from "./crypto.js";
import { NostrBus } from "./nostr.js";
import type { Event } from "nostr-tools/pure";

// ---------------------------------------------------------------------------
// frames

export interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  path: string;
  body?: unknown;
}
export interface ResFrame {
  t: "res";
  id: string;
  status: number;
  body?: unknown;
}
/** A run event with its global sequence number. */
export interface SeqEvent {
  q: number;
  e: unknown;
}
export type Frame =
  | { t: "hello"; sid: string; role: "console" | "phone"; device?: string }
  | { t: "welcome"; sid: string; name: string; version: string }
  | ReqFrame
  | ResFrame
  | { t: "ev"; items: SeqEvent[] }
  | { t: "webrtc"; sid: string; dir: "c2d" | "d2c"; sub: "offer" | "answer" | "cand" | "bye"; sdp?: string; type?: string; cand?: string; mid?: string }
  | { t: "ping"; sid: string }
  | { t: "pong"; sid: string }
  | { t: "part"; pid: string; i: number; n: number; s: string };

interface Envelope {
  ts: number;
  f: Frame;
}

// ---------------------------------------------------------------------------
// oversize frames: transparent split/reassemble

export function splitFrame(frame: Frame, maxChars: number): Frame[] {
  const json = JSON.stringify(frame);
  if (json.length <= maxChars) return [frame];
  const n = Math.ceil(json.length / maxChars);
  const pid = Math.random().toString(36).slice(2, 10);
  const parts: Frame[] = [];
  for (let i = 0; i < n; i++) {
    parts.push({ t: "part", pid, i, n, s: json.slice(i * maxChars, (i + 1) * maxChars) });
  }
  return parts;
}

export class Reassembler {
  private pending = new Map<string, { n: number; got: number; parts: string[]; at: number }>();
  /** Feed a frame; returns the completed inner frame when a split completes, the frame itself when unsplit, or null while waiting. */
  feed(frame: Frame): Frame | null {
    if (frame.t !== "part") return frame;
    let entry = this.pending.get(frame.pid);
    if (!entry) {
      entry = { n: frame.n, got: 0, parts: new Array<string>(frame.n).fill(""), at: Date.now() };
      this.pending.set(frame.pid, entry);
    }
    if (entry.parts[frame.i] === "") entry.got += 1;
    entry.parts[frame.i] = frame.s;
    if (entry.got < entry.n) {
      // GC anything half-assembled for over a minute
      for (const [pid, e] of this.pending) {
        if (Date.now() - e.at > 60_000) this.pending.delete(pid);
      }
      return null;
    }
    this.pending.delete(frame.pid);
    try {
      return JSON.parse(entry.parts.join("")) as Frame;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// the platform seam for WebRTC: each side hands the tunnel a signal pipe

/** A directional WebRTC half — platform code owns the PeerConnection, the tunnel owns the signaling. */
export interface RtcSide {
  /** deliver a remote signal (offer/answer/candidate) into the local PC */
  signal(msg: { sub: string; sdp?: string; type?: string; cand?: string; mid?: string }): void;
  /** register the callback that carries local signals to the far side */
  onSignal(cb: (msg: { sub: string; sdp?: string; type?: string; cand?: string; mid?: string }) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
  send(text: string): void;
  close(): void;
}

// relay events must stay well under public-relay size caps (128 KB at the
// stingiest); sealed b64 adds ~33%, so cap plaintext frames at 32 KB there.
const RELAY_MAX_CHARS = 32_000;
const DC_MAX_CHARS = 48_000;

// ---------------------------------------------------------------------------
// client

export interface TunnelClientOptions {
  secret: Uint8Array;
  relays: string[];
  webSocket?: new (url: string) => WebSocket;
  role?: "console" | "phone";
  device?: string;
  /** factory for the platform's WebRTC initiator side; omit to stay on relays */
  makeRtc?: () => RtcSide;
  onEvent?: (ev: unknown) => void;
  /** transport status for the UI badge */
  onStatus?: (s: { tier: "connecting" | "relay" | "p2p"; relaysLive: number; daemonName?: string }) => void;
}

export class TunnelClient {
  private keys!: DirectionKeys;
  private bus!: NostrBus;
  private guard = new ReplayGuard();
  private reasm = new Reassembler();
  private sid = Math.random().toString(36).slice(2, 10);
  private nextReq = 1;
  private pending = new Map<string, { resolve: (r: { status: number; body?: unknown }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private welcomed = false;
  private daemonName?: string;
  private rtc: RtcSide | null = null;
  private dcOpen = false;
  private closed = false;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private dcPingTimer: ReturnType<typeof setInterval> | null = null;
  private lastDcPong = 0;
  private seenSeqs = new Set<number>();
  private seenSeqOrder: number[] = [];

  private constructor(private opts: TunnelClientOptions) {}

  static async connect(opts: TunnelClientOptions): Promise<TunnelClient> {
    const c = new TunnelClient(opts);
    c.keys = await deriveKeys(opts.secret, "client");
    const topic = await deriveTopic(opts.secret);
    c.bus = new NostrBus({
      relays: opts.relays,
      topic,
      ...(opts.webSocket ? { webSocket: opts.webSocket } : {}),
      onEvent: (ev) => void c.onRelayEvent(ev),
      onRelayStatus: () => c.pushStatus(),
    });
    c.pushStatus();
    c.sayHello();
    return c;
  }

  private pushStatus(): void {
    if (this.closed) return;
    this.opts.onStatus?.({
      tier: this.dcOpen ? "p2p" : this.welcomed ? "relay" : "connecting",
      relaysLive: this.bus?.liveCount ?? 0,
      ...(this.daemonName !== undefined ? { daemonName: this.daemonName } : {}),
    });
  }

  private sayHello(): void {
    if (this.closed || this.welcomed) return;
    void this.sendRelay({ t: "hello", sid: this.sid, role: this.opts.role ?? "console", ...(this.opts.device !== undefined ? { device: this.opts.device } : {}) });
    this.helloTimer = setTimeout(() => this.sayHello(), 3000);
  }

  private async sendRelay(frame: Frame): Promise<void> {
    for (const part of splitFrame(frame, RELAY_MAX_CHARS)) {
      this.bus.publish(await seal(this.keys, { ts: Date.now(), f: part } satisfies Envelope));
    }
  }

  private async sendDc(frame: Frame): Promise<void> {
    if (!this.rtc || !this.dcOpen) throw new Error("datachannel not open");
    for (const part of splitFrame(frame, DC_MAX_CHARS)) {
      this.rtc.send(await seal(this.keys, { ts: Date.now(), f: part } satisfies Envelope));
    }
  }

  private async send(frame: Frame): Promise<void> {
    if (this.dcOpen) {
      try {
        await this.sendDc(frame);
        return;
      } catch {
        /* DC died mid-send — fall back */
      }
    }
    await this.sendRelay(frame);
  }

  private async onRelayEvent(ev: Event): Promise<void> {
    let env: Envelope;
    try {
      env = (await open(this.keys, ev.content)) as Envelope;
    } catch {
      return; // foreign or corrupted traffic on the topic — not ours
    }
    if (!this.guard.check(ev.id, env.ts)) return;
    this.handleFrame(env.f);
  }

  private async onDcText(text: string): Promise<void> {
    try {
      const env = (await open(this.keys, text)) as Envelope;
      this.handleFrame(env.f);
    } catch {
      /* tampered or foreign — drop */
    }
  }

  private handleFrame(raw: Frame): void {
    const frame = this.reasm.feed(raw);
    if (!frame) return;
    switch (frame.t) {
      case "welcome": {
        if (frame.sid !== this.sid) return; // meant for a sibling device
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.welcomed = true;
        this.daemonName = frame.name;
        this.pushStatus();
        this.maybeUpgrade();
        return;
      }
      case "res": {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ status: frame.status, ...(frame.body !== undefined ? { body: frame.body } : {}) });
        return;
      }
      case "ev": {
        for (const item of frame.items) {
          if (this.seenSeqs.has(item.q)) continue;
          this.seenSeqs.add(item.q);
          this.seenSeqOrder.push(item.q);
          while (this.seenSeqOrder.length > 1024) {
            const evicted = this.seenSeqOrder.shift();
            if (evicted !== undefined) this.seenSeqs.delete(evicted);
          }
          this.opts.onEvent?.(item.e);
        }
        return;
      }
      case "webrtc": {
        if (frame.dir !== "d2c" || frame.sid !== this.sid || !this.rtc) return;
        this.rtc.signal({ sub: frame.sub, ...(frame.sdp !== undefined ? { sdp: frame.sdp } : {}), ...(frame.type !== undefined ? { type: frame.type } : {}), ...(frame.cand !== undefined ? { cand: frame.cand } : {}), ...(frame.mid !== undefined ? { mid: frame.mid } : {}) });
        return;
      }
      case "pong": {
        if (frame.sid === this.sid) this.lastDcPong = Date.now();
        return;
      }
      default:
        return;
    }
  }

  // ---- the WebRTC upgrade dance (client initiates) ----
  private maybeUpgrade(): void {
    if (!this.opts.makeRtc || this.rtc || this.closed) return;
    const rtc = this.opts.makeRtc();
    this.rtc = rtc;
    rtc.onSignal((msg) => {
      void this.sendRelay({ t: "webrtc", sid: this.sid, dir: "c2d", sub: msg.sub as "offer" | "answer" | "cand", ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}), ...(msg.type !== undefined ? { type: msg.type } : {}), ...(msg.cand !== undefined ? { cand: msg.cand } : {}), ...(msg.mid !== undefined ? { mid: msg.mid } : {}) });
    });
    rtc.onOpen(() => {
      this.dcOpen = true;
      this.lastDcPong = Date.now();
      this.pushStatus();
      // liveness: ping over the DC; two missed pongs → drop back to relays
      this.dcPingTimer = setInterval(() => {
        if (Date.now() - this.lastDcPong > 45_000) {
          this.dropDc();
          return;
        }
        void this.sendDc({ t: "ping", sid: this.sid }).catch(() => this.dropDc());
      }, 15_000);
    });
    rtc.onClose(() => this.dropDc());
    rtc.onMessage((text) => void this.onDcText(text));
  }

  private dropDc(): void {
    if (this.dcPingTimer) {
      clearInterval(this.dcPingTimer);
      this.dcPingTimer = null;
    }
    const had = this.dcOpen || this.rtc !== null;
    this.dcOpen = false;
    try {
      this.rtc?.close();
    } catch {
      /* fine */
    }
    this.rtc = null;
    if (had && !this.closed) {
      this.pushStatus();
      // try again in a bit — networks change (that's the whole point of Anywhere)
      this.upgradeTimer = setTimeout(() => this.maybeUpgrade(), 20_000);
    }
  }

  /** Perform a request over the best available tier. */
  request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body?: unknown }> {
    const id = `${this.sid}.${this.nextReq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tunnel request timed out: ${method} ${path}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ t: "req", id, method, path, ...(body !== undefined ? { body } : {}) }).catch((e: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  get tier(): "connecting" | "relay" | "p2p" {
    return this.dcOpen ? "p2p" : this.welcomed ? "relay" : "connecting";
  }

  close(): void {
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.upgradeTimer) clearTimeout(this.upgradeTimer);
    this.dropDc();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("tunnel closed"));
    }
    this.pending.clear();
    this.bus.close();
  }
}

// ---------------------------------------------------------------------------
// server

export interface TunnelServerOptions {
  secret: Uint8Array;
  relays: string[];
  webSocket?: new (url: string) => WebSocket;
  name: string;
  version: string;
  /** execute a tunneled REST request against the local daemon */
  dispatch: (req: { method: string; path: string; body?: unknown }) => Promise<{ status: number; body?: unknown }>;
  /** factory for the platform's WebRTC responder side; omit to serve relay-only */
  makeRtc?: () => RtcSide;
  onStatus?: (s: { relaysLive: number; sessions: number; p2pSessions: number }) => void;
}

interface Session {
  sid: string;
  rtc: RtcSide | null;
  dcOpen: boolean;
  lastSeen: number;
  dcQueue: SeqEvent[];
  dcFlush: ReturnType<typeof setTimeout> | null;
}

export class TunnelServer {
  private keys!: DirectionKeys;
  private bus!: NostrBus;
  private guard = new ReplayGuard();
  private reasm = new Reassembler();
  private sessions = new Map<string, Session>();
  private seq = 1;
  private relayQueue: SeqEvent[] = [];
  private relayFlush: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private constructor(private opts: TunnelServerOptions) {}

  static async start(opts: TunnelServerOptions): Promise<TunnelServer> {
    const s = new TunnelServer(opts);
    s.keys = await deriveKeys(opts.secret, "daemon");
    const topic = await deriveTopic(opts.secret);
    s.bus = new NostrBus({
      relays: opts.relays,
      topic,
      ...(opts.webSocket ? { webSocket: opts.webSocket } : {}),
      onEvent: (ev) => void s.onRelayEvent(ev),
      onRelayStatus: () => s.pushStatus(),
    });
    return s;
  }

  private pushStatus(): void {
    if (this.closed) return;
    let p2p = 0;
    for (const [, sess] of this.sessions) if (sess.dcOpen) p2p += 1;
    this.opts.onStatus?.({ relaysLive: this.bus?.liveCount ?? 0, sessions: this.sessions.size, p2pSessions: p2p });
  }

  private async sendRelay(frame: Frame): Promise<void> {
    for (const part of splitFrame(frame, RELAY_MAX_CHARS)) {
      this.bus.publish(await seal(this.keys, { ts: Date.now(), f: part } satisfies Envelope));
    }
  }

  private async sendTo(sess: Session | undefined, frame: Frame): Promise<void> {
    if (sess?.dcOpen && sess.rtc) {
      try {
        for (const part of splitFrame(frame, DC_MAX_CHARS)) {
          sess.rtc.send(await seal(this.keys, { ts: Date.now(), f: part } satisfies Envelope));
        }
        return;
      } catch {
        /* DC died — relay still works */
      }
    }
    await this.sendRelay(frame);
  }

  private async onRelayEvent(ev: Event): Promise<void> {
    let env: Envelope;
    try {
      env = (await open(this.keys, ev.content)) as Envelope;
    } catch {
      return;
    }
    if (!this.guard.check(ev.id, env.ts)) return;
    await this.handleFrame(env.f, null);
  }

  private session(sid: string): Session {
    let sess = this.sessions.get(sid);
    if (!sess) {
      sess = { sid, rtc: null, dcOpen: false, lastSeen: Date.now(), dcQueue: [], dcFlush: null };
      this.sessions.set(sid, sess);
      // prune sessions idle > 10 min
      for (const [k, v] of this.sessions) {
        if (Date.now() - v.lastSeen > 600_000) {
          try {
            v.rtc?.close();
          } catch {
            /* fine */
          }
          if (v.dcFlush) clearTimeout(v.dcFlush);
          this.sessions.delete(k);
        }
      }
      this.pushStatus();
    }
    sess.lastSeen = Date.now();
    return sess;
  }

  private async handleFrame(raw: Frame, via: Session | null): Promise<void> {
    const frame = this.reasm.feed(raw);
    if (!frame) return;
    switch (frame.t) {
      case "hello": {
        const sess = this.session(frame.sid);
        await this.sendTo(sess, { t: "welcome", sid: frame.sid, name: this.opts.name, version: this.opts.version });
        return;
      }
      case "req": {
        const sid = frame.id.split(".")[0] ?? "";
        const sess = via ?? this.sessions.get(sid) ?? this.session(sid);
        sess.lastSeen = Date.now();
        let res: { status: number; body?: unknown };
        try {
          res = await this.opts.dispatch({ method: frame.method, path: frame.path, ...(frame.body !== undefined ? { body: frame.body } : {}) });
        } catch (e) {
          res = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
        }
        await this.sendTo(sess, { t: "res", id: frame.id, status: res.status, ...(res.body !== undefined ? { body: res.body } : {}) });
        return;
      }
      case "webrtc": {
        if (frame.dir !== "c2d") return;
        const sess = this.session(frame.sid);
        if (!this.opts.makeRtc) return; // no P2P support — relay tier keeps working
        if (!sess.rtc) {
          const rtc = this.opts.makeRtc();
          sess.rtc = rtc;
          rtc.onSignal((msg) => {
            void this.sendRelay({ t: "webrtc", sid: frame.sid, dir: "d2c", sub: msg.sub as "offer" | "answer" | "cand", ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}), ...(msg.type !== undefined ? { type: msg.type } : {}), ...(msg.cand !== undefined ? { cand: msg.cand } : {}), ...(msg.mid !== undefined ? { mid: msg.mid } : {}) });
          });
          rtc.onOpen(() => {
            sess.dcOpen = true;
            this.pushStatus();
          });
          rtc.onClose(() => {
            sess.dcOpen = false;
            try {
              sess.rtc?.close();
            } catch {
              /* fine */
            }
            sess.rtc = null;
            this.pushStatus();
          });
          rtc.onMessage((text) => {
            void (async () => {
              try {
                const env = (await open(this.keys, text)) as Envelope;
                await this.handleFrame(env.f, sess);
              } catch {
                /* tampered — drop */
              }
            })();
          });
        }
        if (frame.sub === "bye") {
          sess.dcOpen = false;
          try {
            sess.rtc.close();
          } catch {
            /* fine */
          }
          sess.rtc = null;
          return;
        }
        sess.rtc.signal({ sub: frame.sub, ...(frame.sdp !== undefined ? { sdp: frame.sdp } : {}), ...(frame.type !== undefined ? { type: frame.type } : {}), ...(frame.cand !== undefined ? { cand: frame.cand } : {}), ...(frame.mid !== undefined ? { mid: frame.mid } : {}) });
        return;
      }
      case "ping": {
        const sess = this.sessions.get(frame.sid);
        if (sess) sess.lastSeen = Date.now();
        await this.sendTo(sess, { t: "pong", sid: frame.sid });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Push a run event to every paired device.
   *
   * DataChannel sessions get everything, fast (50 ms batches). The shared
   * relay tier is a guest on public infrastructure, so it batches at 400 ms
   * and coalesces step.activity spam down to the latest line per step.
   */
  onEvent(ev: unknown): void {
    if (this.closed) return;
    const item: SeqEvent = { q: this.seq++, e: ev };

    let anyRelayListener = false;
    for (const [, sess] of this.sessions) {
      if (Date.now() - sess.lastSeen > 120_000) continue; // idle — relay batch would be waste
      if (sess.dcOpen && sess.rtc) {
        sess.dcQueue.push(item);
        if (!sess.dcFlush) {
          sess.dcFlush = setTimeout(() => {
            sess.dcFlush = null;
            const items = sess.dcQueue.splice(0);
            if (items.length) void this.sendTo(sess, { t: "ev", items });
          }, 50);
        }
      } else {
        anyRelayListener = true;
      }
    }
    if (!anyRelayListener) return;

    this.relayQueue.push(item);
    if (!this.relayFlush) {
      this.relayFlush = setTimeout(() => {
        this.relayFlush = null;
        const items = coalesceForRelay(this.relayQueue.splice(0));
        if (items.length) void this.sendRelay({ t: "ev", items });
      }, 400);
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  close(): void {
    this.closed = true;
    if (this.relayFlush) clearTimeout(this.relayFlush);
    for (const [, sess] of this.sessions) {
      if (sess.dcFlush) clearTimeout(sess.dcFlush);
      try {
        sess.rtc?.close();
      } catch {
        /* fine */
      }
    }
    this.sessions.clear();
    this.bus.close();
  }
}

/** Keep only the latest step.activity per (runId,nodeId); pass everything else through. */
export function coalesceForRelay(items: SeqEvent[]): SeqEvent[] {
  const lastActivity = new Map<string, number>(); // key → index of last activity
  items.forEach((item, i) => {
    const e = item.e as { type?: string; runId?: string; nodeId?: string };
    if (e && e.type === "step.activity" && e.runId && e.nodeId) {
      lastActivity.set(`${e.runId}/${e.nodeId}`, i);
    }
  });
  return items.filter((item, i) => {
    const e = item.e as { type?: string; runId?: string; nodeId?: string };
    if (!e || e.type !== "step.activity" || !e.runId || !e.nodeId) return true;
    return lastActivity.get(`${e.runId}/${e.nodeId}`) === i;
  });
}
