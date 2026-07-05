import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveKeys, deriveTopic, open, fromB64Url, decodePairingPayload } from "../src/index.js";

/**
 * The shared cross-platform vectors: the Kotlin app's unit tests consume the
 * same file (mobile/android/app/src/test/resources/anywhere-vectors.json), so
 * this test is the contract that TS and Kotlin agree on every wire byte.
 */
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../mobile/android/app/src/test/resources/anywhere-vectors.json", import.meta.url)),
    "utf8",
  ),
) as {
  secretB64Url: string;
  topicHex: string;
  hkdf: { c2dKeyHex: string; d2cKeyHex: string };
  sealed: Array<{ dir: "c2d" | "d2c"; plaintextJson: string; wireB64: string }>;
  pairingPayloadExample: string;
};

describe("cross-platform wire vectors", () => {
  const secret = fromB64Url(vectors.secretB64Url);

  it("derives the vector topic", async () => {
    expect(await deriveTopic(secret)).toBe(vectors.topicHex);
  });

  it("opens every sealed vector frame byte-for-byte", async () => {
    const daemon = await deriveKeys(secret, "daemon");
    const client = await deriveKeys(secret, "client");
    for (const s of vectors.sealed) {
      const keys = s.dir === "c2d" ? daemon : client; // opener is the receiving side
      const opened = await open(keys, s.wireB64);
      expect(JSON.stringify(opened)).toBe(s.plaintextJson);
    }
  });

  it("decodes the example pairing payload", () => {
    const p = decodePairingPayload(vectors.pairingPayloadExample);
    expect(p.n).toBe("VECTOR-PC");
    expect(p.s).toBe(vectors.secretB64Url);
  });
});
