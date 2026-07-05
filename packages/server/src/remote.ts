/**
 * Nocturne Anywhere — the daemon end of the internet tunnel.
 *
 * The bridge dials OUT to public rendezvous relays (no open ports, no
 * port-forwarding, nothing listening on the internet) and serves the same
 * REST API the canvas uses, by replaying each sealed tunnel request against
 * the daemon's own loopback listener. Loopback is the trust boundary the
 * server already enforces, so the tunnel inherits exactly the local API —
 * no second permission model to keep in sync.
 *
 * If node-datachannel is installed (it ships as an optional dependency),
 * each paired device is offered a direct WebRTC upgrade: the phone and the
 * daemon hole-punch a DataChannel and leave the relays behind. If the
 * module is missing or the NATs won't cooperate, the relay tier simply
 * keeps working — slower, still end-to-end encrypted, still zero-infra.
 */

import os from "node:os";
import { WebSocket as NodeWebSocket } from "ws";
import {
  TunnelServer,
  DEFAULT_RELAYS,
  fromB64Url,
  type RtcSide,
} from "@nocturne/remote";
import type { RunEvent } from "@nocturne/engine";

export interface RemoteBridgeOptions {
  /** base64url 32-byte pairing secret (config.remoteSecret) */
  secret: string;
  /** loopback port of the local REST listener */
  port: number;
  relays?: string[];
  name?: string;
  version: string;
  /** ICE servers for the P2P upgrade (STUN by default; users may add their own TURN) */
  iceServers?: string[];
  onStatus?: (s: { relaysLive: number; sessions: number; p2pSessions: number }) => void;
}

type NodeDataChannelModule = typeof import("node-datachannel");

/** Adapt a node-datachannel responder PeerConnection to the tunnel's RtcSide seam. */
function makeResponderRtc(ndc: NodeDataChannelModule, iceServers: string[]): RtcSide {
  const pc = new ndc.PeerConnection("nocturne-daemon", { iceServers });
  let dc: import("node-datachannel").DataChannel | null = null;
  let onSignalCb: ((msg: { sub: string; sdp?: string; type?: string; cand?: string; mid?: string }) => void) | null = null;
  let onOpenCb: (() => void) | null = null;
  let onCloseCb: (() => void) | null = null;
  let onMessageCb: ((text: string) => void) | null = null;
  let closed = false;

  pc.onLocalDescription((sdp: string, type: string) => {
    onSignalCb?.({ sub: type === "offer" ? "offer" : "answer", sdp, type });
  });
  pc.onLocalCandidate((cand: string, mid: string) => {
    onSignalCb?.({ sub: "cand", cand, mid });
  });
  pc.onDataChannel((channel: import("node-datachannel").DataChannel) => {
    dc = channel;
    channel.onMessage((msg: string | ArrayBuffer | Buffer) =>
      onMessageCb?.(typeof msg === "string" ? msg : Buffer.from(msg as ArrayBuffer).toString("utf8")),
    );
    channel.onClosed(() => onCloseCb?.());
    // the channel arrives already open from the initiator's perspective
    onOpenCb?.();
  });
  pc.onStateChange((state: string) => {
    if ((state === "closed" || state === "failed" || state === "disconnected") && !closed) onCloseCb?.();
  });

  return {
    signal(msg) {
      if (closed) return;
      try {
        if (msg.sub === "offer" || msg.sub === "answer") {
          pc.setRemoteDescription(msg.sdp ?? "", (msg.type ?? msg.sub) as import("node-datachannel").DescriptionType);
        } else if (msg.sub === "cand" && msg.cand) {
          pc.addRemoteCandidate(msg.cand, msg.mid ?? "0");
        }
      } catch {
        /* malformed signal — ignore; the relay tier is unaffected */
      }
    },
    onSignal(cb) {
      onSignalCb = cb;
    },
    onOpen(cb) {
      onOpenCb = cb;
    },
    onClose(cb) {
      onCloseCb = cb;
    },
    onMessage(cb) {
      onMessageCb = cb;
    },
    send(text) {
      if (!dc) throw new Error("datachannel not open");
      dc.sendMessage(text);
    },
    close() {
      closed = true;
      try {
        dc?.close();
      } catch {
        /* fine */
      }
      try {
        pc.close();
      } catch {
        /* fine */
      }
    },
  };
}

export class RemoteBridge {
  private server: TunnelServer | null = null;
  private constructor() {}

  static async start(opts: RemoteBridgeOptions): Promise<RemoteBridge> {
    const bridge = new RemoteBridge();
    const secret = fromB64Url(opts.secret);
    if (secret.length !== 32) throw new Error("remoteSecret must be 32 base64url bytes");

    // P2P is an upgrade, not a requirement: a missing native module must
    // never take the relay tier (or the daemon) down with it.
    let ndc: NodeDataChannelModule | null = null;
    try {
      ndc = await import("node-datachannel");
    } catch {
      ndc = null;
    }
    const iceServers = opts.iceServers ?? ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

    bridge.server = await TunnelServer.start({
      secret,
      relays: opts.relays ?? DEFAULT_RELAYS,
      webSocket: NodeWebSocket as unknown as new (url: string) => WebSocket,
      name: opts.name ?? os.hostname(),
      version: opts.version,
      dispatch: async (req) => {
        // replay against our own loopback listener — the existing trust boundary
        const url = `http://127.0.0.1:${opts.port}${req.path}`;
        try {
          const res = await fetch(url, {
            method: req.method,
            ...(req.body !== undefined
              ? { headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) }
              : {}),
          });
          const text = await res.text();
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            body = { error: "non-JSON response" };
          }
          return { status: res.status, ...(body !== undefined ? { body } : {}) };
        } catch (e) {
          return { status: 502, body: { error: e instanceof Error ? e.message : String(e) } };
        }
      },
      ...(ndc ? { makeRtc: () => makeResponderRtc(ndc, iceServers) } : {}),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    });
    return bridge;
  }

  get p2pAvailable(): boolean {
    return this.server !== null;
  }

  onEvent(ev: RunEvent): void {
    this.server?.onEvent(ev);
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}
