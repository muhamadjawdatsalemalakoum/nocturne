/**
 * Nocturne Anywhere — the phone/browser end of the internet tunnel.
 *
 * When the page carries a pairing payload (in the URL *fragment*, so it never
 * reaches any server, or remembered in localStorage from a previous scan),
 * the entire API layer reroutes through an E2E-encrypted tunnel: sealed
 * frames over public relays, upgraded to a direct WebRTC DataChannel the
 * moment the networks allow. The rest of the app cannot tell the difference —
 * `remoteFetch` speaks in real `Response` objects and `remoteEvents` feeds
 * the same RunEvent stream `connectEvents` would.
 */

import {
  TunnelClient,
  payloadFromFragment,
  decodePairingPayload,
  encodePairingPayload,
  pairingSecret,
  type PairingPayload,
  type RtcSide,
} from "@nocturne/remote";
import type { RunEvent } from "./types";

const PAIR_KEY = "nocturne.remotePair";

export interface RemoteStatus {
  tier: "connecting" | "relay" | "p2p";
  relaysLive: number;
  daemonName?: string;
}

let payload: PairingPayload | null = null;
let client: TunnelClient | null = null;
let lastStatus: RemoteStatus = { tier: "connecting", relaysLive: 0 };
const eventCbs = new Set<(ev: RunEvent) => void>();
const statusCbs = new Set<(s: RemoteStatus) => void>();

/** The WebRTC initiator side: browser-native RTCPeerConnection, DataChannel first. */
function makeBrowserRtc(): RtcSide {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }],
  });
  const dc = pc.createDataChannel("nocturne-tunnel");
  const cbs: {
    signal?: (msg: { sub: string; sdp?: string; type?: string; cand?: string; mid?: string }) => void;
    open?: () => void;
    close?: () => void;
    message?: (text: string) => void;
  } = {};

  pc.onicecandidate = (e) => {
    if (e.candidate?.candidate) {
      cbs.signal?.({ sub: "cand", cand: e.candidate.candidate, mid: e.candidate.sdpMid ?? "0" });
    }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) cbs.close?.();
  };
  dc.onopen = () => cbs.open?.();
  dc.onclose = () => cbs.close?.();
  dc.onmessage = (e) => {
    if (typeof e.data === "string") cbs.message?.(e.data);
  };
  // kick off the offer as soon as the tunnel wires onSignal
  void (async () => {
    // wait a tick for onSignal registration
    await new Promise((s) => setTimeout(s, 0));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      cbs.signal?.({ sub: "offer", sdp: offer.sdp ?? "", type: "offer" });
    } catch {
      cbs.close?.();
    }
  })();

  return {
    signal(msg) {
      void (async () => {
        try {
          if (msg.sub === "answer" && msg.sdp) {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          } else if (msg.sub === "cand" && msg.cand) {
            await pc.addIceCandidate({ candidate: msg.cand, sdpMid: msg.mid ?? "0" });
          }
        } catch {
          /* stale/malformed signal — the relay tier is unaffected */
        }
      })();
    },
    onSignal(cb) {
      cbs.signal = cb;
    },
    onOpen(cb) {
      cbs.open = cb;
    },
    onClose(cb) {
      cbs.close = cb;
    },
    onMessage(cb) {
      cbs.message = cb;
    },
    send(text) {
      dc.send(text);
    },
    close() {
      try {
        dc.close();
      } catch { /* fine */ }
      try {
        pc.close();
      } catch { /* fine */ }
    },
  };
}

/**
 * Adopt a pairing payload from the URL fragment (then scrub it from the
 * address bar) or from a previous visit. Returns true when remote mode is on.
 */
export function initRemote(): boolean {
  if (payload) return true;
  try {
    const fresh = payloadFromFragment(location.hash);
    if (fresh) {
      payload = fresh;
      localStorage.setItem(PAIR_KEY, encodePairingPayload(fresh));
      const url = new URL(location.href);
      url.hash = "";
      history.replaceState(null, "", url.toString());
    } else {
      const saved = localStorage.getItem(PAIR_KEY);
      if (saved) payload = decodePairingPayload(saved);
    }
  } catch {
    payload = null;
  }
  if (!payload) return false;
  void start(payload);
  return true;
}

async function start(p: PairingPayload): Promise<void> {
  client = await TunnelClient.connect({
    secret: pairingSecret(p),
    relays: p.r,
    role: "console",
    device: navigator.userAgent.includes("Mobile") ? "phone" : "browser",
    makeRtc: makeBrowserRtc,
    onEvent: (ev) => {
      for (const cb of eventCbs) cb(ev as RunEvent);
    },
    onStatus: (s) => {
      lastStatus = s;
      for (const cb of statusCbs) cb(s);
    },
  });
}

export function remoteActive(): boolean {
  return payload !== null;
}

export function remoteDaemonName(): string {
  return lastStatus.daemonName ?? payload?.n ?? "nocturne";
}

export function remoteStatus(): RemoteStatus {
  return lastStatus;
}

export function onRemoteStatus(cb: (s: RemoteStatus) => void): () => void {
  statusCbs.add(cb);
  cb(lastStatus);
  return () => statusCbs.delete(cb);
}

/** Forget the pairing entirely (the QR must be re-scanned to reconnect). */
export function forgetRemote(): void {
  try {
    localStorage.removeItem(PAIR_KEY);
  } catch { /* fine */ }
  client?.close();
  client = null;
  payload = null;
  location.reload();
}

/** Long-running endpoints get long deadlines; everything else fails fast. */
function timeoutFor(path: string): number {
  if (path.startsWith("/api/suggest")) return 900_000; // Retrace reads a day of sessions
  if (path.startsWith("/api/workflows/import")) return 60_000;
  return 30_000;
}

/** A drop-in fetch: same Response contract, tunneled transport. */
export async function remoteFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!client) throw new Error("Anywhere tunnel not connected yet — try again in a moment");
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
  const method = (init.method ?? "GET").toUpperCase();
  let body: unknown;
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  const res = await client.request(method, path, body, timeoutFor(path));
  return new Response(res.body !== undefined ? JSON.stringify(res.body) : null, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

/** A drop-in connectEvents: same RunEvent stream, tunneled transport. */
export function remoteEvents(onEvent: (ev: RunEvent) => void): () => void {
  eventCbs.add(onEvent);
  return () => eventCbs.delete(onEvent);
}
