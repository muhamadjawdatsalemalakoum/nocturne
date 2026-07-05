package space.nocturne.app

import fr.acinq.secp256k1.Secp256k1
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NIP-01 event identity: the id preimage must serialize exactly like JSON.stringify
 * (see packages/remote/src/nostr.ts / nostr-tools), and the schnorr signature over
 * the id bytes must verify under the x-only pubkey.
 */
class NostrEventTest {
    @Test
    fun schnorrSignedEventVerifies() {
        // BIP-340 test key: seckey 0x...03 has this well-known x-only pubkey
        val priv = AnywhereCrypto.fromHex("0000000000000000000000000000000000000000000000000000000000000003")
        assertTrue(Secp256k1.secKeyVerify(priv))
        val pub = AnywhereCrypto.toHex(Secp256k1.pubKeyCompress(Secp256k1.pubkeyCreate(priv)).copyOfRange(1, 33))
        assertEquals("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9", pub)

        val createdAt = 1751700000L
        val topic = "9c25619faba9781d03536c49d06c0284"
        val content = "AQ+/rest/of/base64==" // base64 with '/' and '+': must survive unescaped
        val serialized = Nip01.serialize(pub, createdAt, 24199, listOf(listOf("x", topic)), content)
        assertEquals(
            "[0,\"$pub\",1751700000,24199,[[\"x\",\"$topic\"]],\"AQ+/rest/of/base64==\"]",
            serialized,
        )

        val id = Nip01.eventId(pub, createdAt, 24199, listOf(listOf("x", topic)), content)
        assertEquals(
            AnywhereCrypto.toHex(AnywhereCrypto.sha256(serialized.toByteArray(Charsets.UTF_8))),
            id,
        )

        val sig = Secp256k1.signSchnorr(AnywhereCrypto.fromHex(id), priv, null)
        assertEquals(64, sig.size)
        assertTrue(Secp256k1.verifySchnorr(sig, AnywhereCrypto.fromHex(id), AnywhereCrypto.fromHex(pub)))
        // tampered id must not verify
        val tampered = AnywhereCrypto.fromHex(id)
        tampered[0] = (tampered[0].toInt() xor 1).toByte()
        assertTrue(!Secp256k1.verifySchnorr(sig, tampered, AnywhereCrypto.fromHex(pub)))
    }

    @Test
    fun escapingMatchesJsonStringify() {
        // '/' passes through; quote/backslash/control chars escape exactly like JSON.stringify
        assertEquals("\"a\\\"b\\\\c\\nd/e\"", Nip01.quote("a\"b\\c\nd/e"))
        assertEquals("\"\\u0001\"", Nip01.quote("\u0001"))
        assertEquals("\"\\t\\r\\b\\f\"", Nip01.quote("\t\r\b\u000C"))
        assertEquals("\"plain-base64+/=\"", Nip01.quote("plain-base64+/="))
    }
}
