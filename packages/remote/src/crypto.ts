/**
 * The cryptographic core of Nocturne Anywhere.
 *
 * Everything that leaves the machine is sealed with AES-256-GCM under keys
 * derived (HKDF-SHA256) from the 32-byte pairing secret in the QR code. The
 * public relays that carry the ciphertext can never read a byte of it — they
 * are an untrusted courier, nothing more.
 *
 * Directional keys ("c2d" client→daemon, "d2c" daemon→client) make reflection
 * attacks structurally impossible: a frame replayed back at its author fails
 * to decrypt. Isomorphic by construction — WebCrypto only, so the exact same
 * code runs in the daemon (Node) and the phone (browser). The Kotlin client
 * mirrors these bytes exactly (see mobile/, verified by shared test vectors).
 */

const subtle = globalThis.crypto.subtle;

export const TUNNEL_INFO_C2D = "nocturne/tunnel/v1/c2d";
export const TUNNEL_INFO_D2C = "nocturne/tunnel/v1/d2c";
export const TOPIC_INFO = "nocturne/topic/v1";

const te = new TextEncoder();
const td = new TextDecoder();

export function toB64(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function toB64Url(buf: Uint8Array): string {
  return toB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64Url(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return fromB64(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
export function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The public rendezvous topic: derived from the secret, reveals nothing about it. */
export async function deriveTopic(secret: Uint8Array): Promise<string> {
  const material = new Uint8Array(secret.length + TOPIC_INFO.length);
  material.set(secret, 0);
  material.set(te.encode(TOPIC_INFO), secret.length);
  const digest = new Uint8Array(await subtle.digest("SHA-256", material));
  return toHex(digest).slice(0, 32);
}

export interface DirectionKeys {
  seal: CryptoKey; // our sending direction
  open: CryptoKey; // their sending direction
}

async function hkdfKey(secret: Uint8Array, info: string, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Derive this side's directional keys. `role` decides which key seals and which opens. */
export async function deriveKeys(secret: Uint8Array, role: "client" | "daemon"): Promise<DirectionKeys> {
  const c2dInfo = TUNNEL_INFO_C2D;
  const d2cInfo = TUNNEL_INFO_D2C;
  if (role === "client") {
    return {
      seal: await hkdfKey(secret, c2dInfo, "encrypt"),
      open: await hkdfKey(secret, d2cInfo, "decrypt"),
    };
  }
  return {
    seal: await hkdfKey(secret, d2cInfo, "encrypt"),
    open: await hkdfKey(secret, c2dInfo, "decrypt"),
  };
}

/** Seal a JSON-serializable frame → base64(iv12 ‖ ciphertext+tag). */
export async function seal(keys: DirectionKeys, frame: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify(frame));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, keys.seal, pt));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return toB64(out);
}

/** Open a sealed frame. Throws on tamper, wrong key, or wrong direction. */
export async function open(keys: DirectionKeys, sealed: string): Promise<unknown> {
  const buf = fromB64(sealed);
  if (buf.length < 12 + 16) throw new Error("sealed frame too short");
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: buf.subarray(0, 12) as BufferSource },
    keys.open,
    buf.subarray(12) as BufferSource,
  );
  return JSON.parse(td.decode(pt));
}

/**
 * Replay guard for the relay tier: remembers recently seen ciphertexts and
 * rejects stale timestamps. (The DataChannel tier doesn't need one — nothing
 * can be injected into an established channel without the keys.)
 */
export class ReplayGuard {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(
    private windowMs = 90_000,
    private cap = 4096,
  ) {}
  /** Returns true when the frame is fresh; false when it is a replay / stale. */
  check(idOrCiphertext: string, tsMs: number, now = Date.now()): boolean {
    if (Math.abs(now - tsMs) > this.windowMs) return false;
    if (this.seen.has(idOrCiphertext)) return false;
    this.seen.add(idOrCiphertext);
    this.order.push(idOrCiphertext);
    while (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }
}
