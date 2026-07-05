/**
 * The rendezvous bus: a thin multi-relay Nostr client.
 *
 * Nocturne uses public Nostr relays the way NIP-46 remote signers do — as a
 * dumb, redundant, zero-account message bus. Frames ride *ephemeral* events
 * (kind 24199, inside the 20000–29999 range relays are expected not to
 * store), tagged with the rendezvous topic derived from the pairing secret.
 * Content is AES-GCM ciphertext; the per-session keypair signing the events
 * is ephemeral and means nothing. Relays see traffic shape, never content.
 *
 * Publishes go to every connected relay at once (first accept wins on the
 * other side, duplicates are dropped by event id), so the loss of any single
 * relay is invisible. Reconnection is per-relay with backoff.
 */

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";

export const EPHEMERAL_KIND = 24199;

type WSCtor = new (url: string) => WebSocket;

export interface NostrBusOptions {
  relays: string[];
  topic: string;
  /** WebSocket implementation (browser: leave default; Node: pass `ws`). */
  webSocket?: WSCtor;
  onEvent: (ev: Event) => void;
  /** called whenever the number of live relay sockets changes */
  onRelayStatus?: (live: number, total: number) => void;
}

interface RelayConn {
  url: string;
  ws: WebSocket | null;
  open: boolean;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class NostrBus {
  private conns: RelayConn[] = [];
  private closed = false;
  private seenIds = new Set<string>();
  private seenOrder: string[] = [];
  private sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.sk);
  private subId = Math.random().toString(36).slice(2, 10);

  constructor(private opts: NostrBusOptions) {
    for (const url of opts.relays) {
      const conn: RelayConn = { url, ws: null, open: false, attempts: 0, timer: null };
      this.conns.push(conn);
      this.connect(conn);
    }
  }

  private get WS(): WSCtor {
    return this.opts.webSocket ?? (globalThis.WebSocket as unknown as WSCtor);
  }

  private notifyStatus(): void {
    this.opts.onRelayStatus?.(this.liveCount, this.conns.length);
  }

  get liveCount(): number {
    return this.conns.filter((c) => c.open).length;
  }

  private connect(conn: RelayConn): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new this.WS(conn.url);
    } catch {
      this.scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    ws.onopen = () => {
      conn.open = true;
      conn.attempts = 0;
      // subscribe from 60s back so a frame published moments before we
      // connected is still delivered (dedupe by id makes this safe)
      const since = Math.floor(Date.now() / 1000) - 60;
      ws.send(JSON.stringify(["REQ", this.subId, { kinds: [EPHEMERAL_KIND], "#x": [this.opts.topic], since }]));
      this.notifyStatus();
    };
    ws.onmessage = (m: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(typeof m.data === "string" ? m.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[0] !== "EVENT" || data[1] !== this.subId) return;
      const ev = data[2] as Event;
      if (ev.pubkey === this.pubkey) return; // our own publish echoed back
      if (this.seenIds.has(ev.id)) return;
      this.seenIds.add(ev.id);
      this.seenOrder.push(ev.id);
      while (this.seenOrder.length > 4096) {
        const evicted = this.seenOrder.shift();
        if (evicted !== undefined) this.seenIds.delete(evicted);
      }
      if (!verifyEvent(ev)) return;
      this.opts.onEvent(ev);
    };
    ws.onclose = () => {
      conn.open = false;
      conn.ws = null;
      this.notifyStatus();
      this.scheduleReconnect(conn);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  private scheduleReconnect(conn: RelayConn): void {
    if (this.closed || conn.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(conn.attempts, 5));
    conn.attempts += 1;
    conn.timer = setTimeout(() => {
      conn.timer = null;
      this.connect(conn);
    }, delay);
  }

  /** Publish sealed content to every live relay. Resolves with the accept count. */
  publish(content: string): number {
    const ev = finalizeEvent(
      {
        kind: EPHEMERAL_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["x", this.opts.topic]],
        content,
      },
      this.sk,
    );
    let sent = 0;
    for (const conn of this.conns) {
      if (!conn.open || !conn.ws) continue;
      try {
        conn.ws.send(JSON.stringify(["EVENT", ev]));
        sent += 1;
      } catch {
        /* relay lost mid-send; reconnect loop handles it */
      }
    }
    return sent;
  }

  close(): void {
    this.closed = true;
    for (const conn of this.conns) {
      if (conn.timer) clearTimeout(conn.timer);
      try {
        conn.ws?.close();
      } catch {
        /* fine */
      }
    }
  }
}
