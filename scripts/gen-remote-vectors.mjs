// Generates cross-platform test vectors for the Nocturne Anywhere wire crypto.
// The Kotlin client must reproduce these bytes exactly — one source of truth,
// three platforms (TS daemon, TS console, Kotlin app).
// Usage: node scripts/gen-remote-vectors.mjs > mobile/android/app/src/test/resources/anywhere-vectors.json
import { webcrypto } from "node:crypto";

const te = new TextEncoder();
const subtle = webcrypto.subtle;

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const toB64 = (u8) => Buffer.from(u8).toString("base64");
const toB64Url = (u8) => Buffer.from(u8).toString("base64url");

// fixed, unremarkable secret — vectors only, never shipped
const secret = new Uint8Array(32);
for (let i = 0; i < 32; i++) secret[i] = (i * 7 + 3) & 0xff;

// topic = SHA256(secret || "nocturne/topic/v1") → hex → first 32 chars
const topicMaterial = new Uint8Array([...secret, ...te.encode("nocturne/topic/v1")]);
const topic = toHex(new Uint8Array(await subtle.digest("SHA-256", topicMaterial))).slice(0, 32);

// HKDF-SHA256(ikm=secret, salt=empty, info) → 32-byte AES-256-GCM keys
async function hkdfRaw(info) {
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}
const c2dKey = await hkdfRaw("nocturne/tunnel/v1/c2d");
const d2cKey = await hkdfRaw("nocturne/tunnel/v1/d2c");

// seal with a FIXED iv (vectors only): wire = base64(iv12 || ct+tag)
async function sealFixed(rawKey, ivByte, frameObj) {
  const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(ivByte);
  const pt = te.encode(JSON.stringify(frameObj));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return toB64(new Uint8Array([...iv, ...ct]));
}

const reqEnvelope = { ts: 1751700000000, f: { t: "req", id: "ab12cd34.1", method: "GET", path: "/api/health" } };
const resEnvelope = { ts: 1751700000456, f: { t: "res", id: "ab12cd34.1", status: 200, body: { ok: true, version: "0.1.0" } } };
const evEnvelope = {
  ts: 1751700001000,
  f: { t: "ev", items: [{ q: 7, e: { type: "run.status", runId: "r1", status: "running", at: 1751700000900 } }] },
};

const vectors = {
  comment: "Nocturne Anywhere wire-crypto vectors. Kotlin/TS must agree on every byte.",
  secretB64Url: toB64Url(secret),
  topicHex: topic,
  hkdf: {
    info_c2d: "nocturne/tunnel/v1/c2d",
    info_d2c: "nocturne/tunnel/v1/d2c",
    c2dKeyHex: toHex(c2dKey),
    d2cKeyHex: toHex(d2cKey),
  },
  sealed: [
    { dir: "c2d", ivByte: 1, plaintextJson: JSON.stringify(reqEnvelope), wireB64: await sealFixed(c2dKey, 1, reqEnvelope) },
    { dir: "d2c", ivByte: 2, plaintextJson: JSON.stringify(resEnvelope), wireB64: await sealFixed(d2cKey, 2, resEnvelope) },
    { dir: "d2c", ivByte: 3, plaintextJson: JSON.stringify(evEnvelope), wireB64: await sealFixed(d2cKey, 3, evEnvelope) },
  ],
  nostr: {
    kind: 24199,
    topicTag: "x",
    note: "events: kind 24199, tags [[\"x\", topicHex]], content = wireB64; signed with an ephemeral per-session schnorr key (BIP-340), REQ filter {kinds:[24199], #x:[topicHex], since: now-60}",
  },
  pairingPayloadExample: toB64Url(
    te.encode(JSON.stringify({ v: 1, s: toB64Url(secret), r: ["wss://relay.damus.io", "wss://nos.lol"], n: "VECTOR-PC" })),
  ),
};

console.log(JSON.stringify(vectors, null, 2));
