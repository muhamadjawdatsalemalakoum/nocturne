package space.nocturne.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.random.Random

/**
 * "part" frame reassembly (packages/remote/src/tunnel.ts splitFrame/Reassembler):
 * the daemon splits frames larger than the relay cap; slices may arrive in any order.
 */
class ReassemblerTest {
    private fun split(json: String, maxChars: Int, pid: String): List<JSONObject> {
        val n = (json.length + maxChars - 1) / maxChars
        return (0 until n).map { i ->
            val end = minOf((i + 1) * maxChars, json.length)
            JSONObject().put("t", "part").put("pid", pid).put("i", i).put("n", n)
                .put("s", json.substring(i * maxChars, end))
        }
    }

    @Test
    fun reassemblesOutOfOrderParts() {
        val blob = StringBuilder().apply { repeat(500) { append("lorem-ipsum-dolor-") } }.toString()
        val frame = JSONObject().put("t", "res").put("id", "ab12cd34.9").put("status", 200)
            .put("body", JSONObject().put("blob", blob))
        val json = frame.toString()
        val parts = split(json, 100, "p1")
        check(parts.size > 10) { "test frame should split into many parts" }

        val reasm = Reassembler()
        val shuffled = parts.shuffled(Random(7))
        var completed: JSONObject? = null
        for ((idx, part) in shuffled.withIndex()) {
            val out = reasm.feed(part)
            if (idx < shuffled.size - 1) {
                assertNull("must stay pending until the last slice", out)
            } else {
                completed = out
            }
        }
        assertNotNull(completed)
        assertEquals("res", completed!!.optString("t"))
        assertEquals("ab12cd34.9", completed.optString("id"))
        assertEquals(200, completed.optInt("status"))
        assertEquals(blob, completed.getJSONObject("body").getString("blob"))
    }

    @Test
    fun duplicateSlicesDoNotCompleteEarly() {
        val frame = JSONObject().put("t", "ev").put("items", "x".repeat(300))
        val parts = split(frame.toString(), 50, "p2")
        val reasm = Reassembler()
        assertNull(reasm.feed(parts[0]))
        assertNull(reasm.feed(parts[0])) // duplicate of the same slice
        var out: JSONObject? = null
        for (i in 1 until parts.size) out = reasm.feed(parts[i])
        assertNotNull(out)
        assertEquals("ev", out!!.optString("t"))
    }

    @Test
    fun passesUnsplitFramesThrough() {
        val pong = JSONObject().put("t", "pong").put("sid", "abcd1234")
        val out = Reassembler().feed(pong)
        assertNotNull(out)
        assertEquals("pong", out!!.optString("t"))
    }
}
