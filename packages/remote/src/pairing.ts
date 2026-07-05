/**
 * The pairing payload — the entire trust bootstrap of Nocturne Anywhere.
 *
 * It travels inside the QR code as a base64url blob, and from there inside a
 * URL *fragment* (`…/app/#pair=…`), which browsers never send to any server.
 * Whoever holds the payload holds the connection: it carries the 32-byte
 * secret every key derives from, so it must never touch a query string, a
 * log line, or a clipboard the user didn't ask for.
 */

import { fromB64Url, toB64Url } from "./crypto.js";

/** Default rendezvous relays: independent, established, no-account public Nostr relays. */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://nostr.mom",
];

export interface PairingPayload {
  v: 1;
  /** base64url 32-byte pairing secret */
  s: string;
  /** rendezvous relay URLs */
  r: string[];
  /** human name of the daemon machine ("KEON-DESKTOP") */
  n: string;
}

export function encodePairingPayload(p: PairingPayload): string {
  return toB64Url(new TextEncoder().encode(JSON.stringify(p)));
}

export function decodePairingPayload(blob: string): PairingPayload {
  const parsed = JSON.parse(new TextDecoder().decode(fromB64Url(blob))) as PairingPayload;
  if (parsed.v !== 1) throw new Error(`unsupported pairing payload version: ${String(parsed.v)}`);
  const secret = fromB64Url(parsed.s);
  if (secret.length !== 32) throw new Error("pairing secret must be 32 bytes");
  if (!Array.isArray(parsed.r) || parsed.r.length === 0) throw new Error("pairing payload has no relays");
  for (const url of parsed.r) {
    if (!/^wss:\/\//.test(url)) throw new Error(`relay must be wss:// — got ${url}`);
  }
  return { v: 1, s: parsed.s, r: parsed.r, n: typeof parsed.n === "string" ? parsed.n : "nocturne" };
}

export function pairingSecret(p: PairingPayload): Uint8Array {
  return fromB64Url(p.s);
}

/** The URL a phone opens (console hosted on GitHub Pages; secret stays in the fragment). */
export function consoleUrl(base: string, p: PairingPayload): string {
  return `${base.replace(/\/+$/, "")}/#pair=${encodePairingPayload(p)}`;
}

/** Extract a pairing payload from a URL fragment, if present. */
export function payloadFromFragment(hash: string): PairingPayload | null {
  const m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodePairingPayload(m[1]);
  } catch {
    return null;
  }
}
