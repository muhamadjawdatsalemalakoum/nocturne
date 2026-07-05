package space.nocturne.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Shared wire-crypto vectors (anywhere-vectors.json) — the same file the TypeScript
 * side (packages/remote) is pinned to. If any byte of the Kotlin port drifts from
 * packages/remote/src/crypto.ts, these fail and the APK never builds.
 */
class VectorsTest {
    private fun vectors(): JSONObject {
        val stream = javaClass.classLoader.getResourceAsStream("anywhere-vectors.json")
            ?: throw IllegalStateException("anywhere-vectors.json missing from test resources")
        return JSONObject(String(stream.readBytes(), Charsets.UTF_8))
    }

    @Test
    fun topicDerivationMatches() {
        val v = vectors()
        val secret = AnywhereCrypto.fromB64Url(v.getString("secretB64Url"))
        assertEquals(32, secret.size)
        assertEquals(v.getString("topicHex"), AnywhereCrypto.deriveTopic(secret))
    }

    @Test
    fun hkdfKeysMatchBothDirections() {
        val v = vectors()
        val secret = AnywhereCrypto.fromB64Url(v.getString("secretB64Url"))
        val hkdf = v.getJSONObject("hkdf")
        assertEquals(hkdf.getString("info_c2d"), AnywhereCrypto.TUNNEL_INFO_C2D)
        assertEquals(hkdf.getString("info_d2c"), AnywhereCrypto.TUNNEL_INFO_D2C)
        assertEquals(
            hkdf.getString("c2dKeyHex"),
            AnywhereCrypto.toHex(AnywhereCrypto.hkdfSha256(secret, AnywhereCrypto.TUNNEL_INFO_C2D)),
        )
        assertEquals(
            hkdf.getString("d2cKeyHex"),
            AnywhereCrypto.toHex(AnywhereCrypto.hkdfSha256(secret, AnywhereCrypto.TUNNEL_INFO_D2C)),
        )
    }

    @Test
    fun sealedFramesOpenAndReseal() {
        val v = vectors()
        val hkdf = v.getJSONObject("hkdf")
        val keys = mapOf(
            "c2d" to AnywhereCrypto.fromHex(hkdf.getString("c2dKeyHex")),
            "d2c" to AnywhereCrypto.fromHex(hkdf.getString("d2cKeyHex")),
        )
        val sealed = v.getJSONArray("sealed")
        for (i in 0 until sealed.length()) {
            val entry = sealed.getJSONObject(i)
            val key = keys.getValue(entry.getString("dir"))
            val wire = entry.getString("wireB64")
            val plaintext = entry.getString("plaintextJson")
            // open: exact plaintext bytes back out
            assertEquals(plaintext, AnywhereCrypto.open(key, wire))
            // seal with the vector's fixed iv: exact wire bytes back out
            val iv = ByteArray(12) { entry.getInt("ivByte").toByte() }
            assertEquals(wire, AnywhereCrypto.seal(key, plaintext, iv))
        }
    }

    @Test
    fun pairingPayloadExampleDecodes() {
        val v = vectors()
        val payload = decodePairingPayload(v.getString("pairingPayloadExample"))
        assertEquals("VECTOR-PC", payload.name)
        assertEquals(v.getString("secretB64Url"), payload.s)
        assertEquals(2, payload.relays.size)
        assertEquals("wss://relay.damus.io", payload.relays[0])
        assertEquals("wss://nos.lol", payload.relays[1])
    }

    @Test
    fun pairingBlobExtraction() {
        val v = vectors()
        val blob = v.getString("pairingPayloadExample")
        // console URL with fragment
        assertEquals(blob, pairingBlobFrom("https://nocturne.example/app/#pair=$blob"))
        // raw blob
        assertEquals(blob, pairingBlobFrom(blob))
        // LAN pairing URL is not an Anywhere blob
        assertNull(pairingBlobFrom("http://192.168.1.20:5151?token=abc123"))
    }
}
