package space.nocturne.app

// Nocturne Anywhere: the phone side of the internet-wide control channel.
//
// This file is a line-for-line port of the frozen TypeScript wire protocol:
//   packages/remote/src/crypto.ts   (HKDF / AES-GCM / topic derivation)
//   packages/remote/src/pairing.ts  (pairing payload codec)
//   packages/remote/src/nostr.ts    (relay bus, kind 24199, tag "x")
//   packages/remote/src/tunnel.ts   (frames, envelope {ts,f}, Reassembler)
// Those files are the source of truth; when in doubt, match their bytes.
// Shared vectors in src/test/resources/anywhere-vectors.json pin both sides.

import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// relay events must stay well under public-relay size caps (tunnel.ts RELAY_MAX_CHARS)
private const val RELAY_MAX_CHARS = 32_000

private val sharedRandom = SecureRandom()

/** Mirrors Math.random().toString(36).slice(2, 10) used for sids/pids/sub ids in the TS side. */
internal fun randomId(len: Int = 8): String {
    val alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    val sb = StringBuilder(len)
    repeat(len) { sb.append(alphabet[sharedRandom.nextInt(alphabet.length)]) }
    return sb.toString()
}

// ---------------------------------------------------------------------------
// crypto (packages/remote/src/crypto.ts)

object AnywhereCrypto {
    const val TUNNEL_INFO_C2D = "nocturne/tunnel/v1/c2d"
    const val TUNNEL_INFO_D2C = "nocturne/tunnel/v1/d2c"
    const val TOPIC_INFO = "nocturne/topic/v1"

    fun toB64(buf: ByteArray): String = Base64.getEncoder().encodeToString(buf)
    fun fromB64(b64: String): ByteArray = Base64.getDecoder().decode(b64)
    fun fromB64Url(b64: String): ByteArray = Base64.getUrlDecoder().decode(b64)

    fun toHex(buf: ByteArray): String {
        val sb = StringBuilder(buf.size * 2)
        for (b in buf) {
            val v = b.toInt() and 0xff
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    fun fromHex(hex: String): ByteArray {
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(hex[2 * i], 16) shl 4) or Character.digit(hex[2 * i + 1], 16)).toByte()
        }
        return out
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    /** The public rendezvous topic: hex(sha256(secret || TOPIC_INFO)) first 32 chars (crypto.ts deriveTopic). */
    fun deriveTopic(secret: ByteArray): String =
        toHex(sha256(secret + TOPIC_INFO.toByteArray(Charsets.UTF_8))).substring(0, 32)

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /**
     * HKDF-SHA256, RFC 5869, L=32.
     *
     * crypto.ts derives with WebCrypto using salt = new Uint8Array(0); per the RFC an
     * absent/empty salt means HashLen (32) zero bytes, which is also what WebCrypto
     * feeds HMAC. javax.crypto rejects empty HMAC keys, so we spell the zeros out —
     * same bytes either way (pinned by the c2d/d2c key vectors).
     */
    fun hkdfSha256(ikm: ByteArray, info: String, length: Int = 32): ByteArray {
        val prk = hmacSha256(ByteArray(32), ikm) // extract
        val out = ByteArray(length)
        var t = ByteArray(0)
        var generated = 0
        var counter = 1
        while (generated < length) { // expand: T(n) = HMAC(prk, T(n-1) || info || n)
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(t)
            mac.update(info.toByteArray(Charsets.UTF_8))
            mac.update(counter.toByte())
            t = mac.doFinal()
            val take = minOf(t.size, length - generated)
            System.arraycopy(t, 0, out, generated, take)
            generated += take
            counter += 1
        }
        return out
    }

    /** Seal plaintext -> base64(iv12 || ciphertext+tag) with AES-256-GCM (crypto.ts seal). */
    fun seal(key: ByteArray, plaintext: String, iv: ByteArray? = null): String {
        val nonce = iv ?: ByteArray(12).also { sharedRandom.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return toB64(nonce + ct)
    }

    /** Open a sealed frame. Throws on tamper, wrong key, or wrong direction (crypto.ts open). */
    fun open(key: ByteArray, sealed: String): String {
        val buf = fromB64(sealed)
        if (buf.size < 12 + 16) throw IllegalArgumentException("sealed frame too short")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, buf, 0, 12))
        return String(cipher.doFinal(buf, 12, buf.size - 12), Charsets.UTF_8)
    }
}

/** Replay guard for the relay tier (crypto.ts ReplayGuard): stale timestamps + repeated ids are rejected. */
class ReplayGuard(private val windowMs: Long = 90_000, private val cap: Int = 4096) {
    private val seen = LinkedHashSet<String>()

    @Synchronized
    fun check(id: String, tsMs: Long, now: Long = System.currentTimeMillis()): Boolean {
        if (Math.abs(now - tsMs) > windowMs) return false
        if (!seen.add(id)) return false
        while (seen.size > cap) {
            val it = seen.iterator()
            it.next()
            it.remove()
        }
        return true
    }
}

/** Insertion-ordered seen-set with an eviction cap (nostr.ts seenIds / tunnel.ts seenSeqs). */
class LruSet<T>(private val cap: Int) {
    private val set = LinkedHashSet<T>()

    /** Returns true when the value is new. */
    @Synchronized
    fun add(value: T): Boolean {
        if (!set.add(value)) return false
        while (set.size > cap) {
            val it = set.iterator()
            it.next()
            it.remove()
        }
        return true
    }
}

// ---------------------------------------------------------------------------
// pairing payload (packages/remote/src/pairing.ts)

data class PairingPayload(
    /** base64url 32-byte pairing secret */
    val s: String,
    /** rendezvous relay URLs (wss://) */
    val relays: List<String>,
    /** human name of the daemon machine */
    val name: String,
)

/** Decode + validate a base64url pairing blob (pairing.ts decodePairingPayload). Throws when invalid. */
fun decodePairingPayload(blob: String): PairingPayload {
    val json = JSONObject(String(AnywhereCrypto.fromB64Url(blob), Charsets.UTF_8))
    if (json.optInt("v") != 1) throw IllegalArgumentException("unsupported pairing payload version")
    val s = json.getString("s")
    if (AnywhereCrypto.fromB64Url(s).size != 32) throw IllegalArgumentException("pairing secret must be 32 bytes")
    val r = json.optJSONArray("r") ?: throw IllegalArgumentException("pairing payload has no relays")
    if (r.length() == 0) throw IllegalArgumentException("pairing payload has no relays")
    val relays = ArrayList<String>(r.length())
    for (i in 0 until r.length()) {
        val url = r.getString(i)
        if (!url.startsWith("wss://")) throw IllegalArgumentException("relay must be wss:// - got $url")
        relays.add(url)
    }
    return PairingPayload(s, relays, json.optString("n", "nocturne"))
}

/**
 * Pull a pairing blob out of scanned QR content: either a console URL whose fragment
 * carries `#pair=<blob>` (pairing.ts payloadFromFragment) or the raw blob itself.
 */
fun pairingBlobFrom(raw: String): String? {
    val m = Regex("[#&]pair=([A-Za-z0-9_-]+)").find(raw)
    if (m != null) return m.groupValues[1]
    val t = raw.trim()
    if (Regex("^[A-Za-z0-9_-]{40,}$").matches(t)) return t
    return null
}

// ---------------------------------------------------------------------------
// NIP-01 event id serialization

object Nip01 {
    /**
     * JSON string escaping exactly like JSON.stringify: only `"`, `\`, and control
     * chars are escaped; `/` and non-ASCII pass through untouched.
     *
     * We deliberately do NOT use org.json here: Android's JSONStringer escapes every
     * "/" as "\/" (and json.org escapes "/" after "<"), which would change the bytes
     * fed to sha256 and produce an event id no relay or peer would accept. The id
     * preimage must match nostr-tools' JSON.stringify serialization byte-for-byte
     * (see packages/remote/src/nostr.ts and NIP-01).
     */
    fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /** NIP-01 id preimage: [0,pubkey,created_at,kind,tags,content] with no whitespace. */
    fun serialize(pubkeyHex: String, createdAt: Long, kind: Int, tags: List<List<String>>, content: String): String {
        val sb = StringBuilder()
        sb.append("[0,").append(quote(pubkeyHex)).append(',').append(createdAt).append(',').append(kind).append(",[")
        for ((ti, tag) in tags.withIndex()) {
            if (ti > 0) sb.append(',')
            sb.append('[')
            for ((i, v) in tag.withIndex()) {
                if (i > 0) sb.append(',')
                sb.append(quote(v))
            }
            sb.append(']')
        }
        sb.append("],").append(quote(content)).append(']')
        return sb.toString()
    }

    fun eventId(pubkeyHex: String, createdAt: Long, kind: Int, tags: List<List<String>>, content: String): String =
        AnywhereCrypto.toHex(AnywhereCrypto.sha256(serialize(pubkeyHex, createdAt, kind, tags, content).toByteArray(Charsets.UTF_8)))
}

// ---------------------------------------------------------------------------
// nostr relay bus (packages/remote/src/nostr.ts)

class NostrClient(
    relays: List<String>,
    private val topic: String,
    private val onEvent: (id: String, content: String) -> Unit,
) {
    companion object {
        const val EPHEMERAL_KIND = 24199
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val subId = randomId()
    private val seenIds = LruSet<String>(4096)

    @Volatile
    private var closed = false

    // Ephemeral per-session BIP-340 keypair; it authenticates nothing (AES-GCM does)
    // and exists only because relays require signed events.
    private val privKey: ByteArray
    val pubkeyHex: String

    private class RelayConn(val url: String) {
        var ws: WebSocket? = null
        var open = false
        var attempts = 0
        var reconnectPending = false
    }

    private val conns = relays.map { RelayConn(it) }

    init {
        var k = ByteArray(32)
        do {
            sharedRandom.nextBytes(k)
        } while (!Secp256k1.secKeyVerify(k))
        privKey = k
        // x-only pubkey (BIP-340): the compressed key minus its parity prefix byte
        pubkeyHex = AnywhereCrypto.toHex(Secp256k1.pubKeyCompress(Secp256k1.pubkeyCreate(k)).copyOfRange(1, 33))
        for (conn in conns) connect(conn)
    }

    private fun connect(conn: RelayConn) {
        if (closed) return
        val request = try {
            Request.Builder().url(conn.url).build() // OkHttp maps wss:// to https:// internally
        } catch (e: Exception) {
            scheduleReconnect(conn)
            return
        }
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (closed) {
                    webSocket.close(1000, null)
                    return
                }
                synchronized(conn) {
                    conn.open = true
                    conn.attempts = 0
                }
                // subscribe from 60s back so frames published moments before we
                // connected are still delivered (id dedupe makes this safe)
                val since = System.currentTimeMillis() / 1000L - 60
                val filter = JSONObject()
                    .put("kinds", JSONArray().put(EPHEMERAL_KIND))
                    .put("#x", JSONArray().put(topic))
                    .put("since", since)
                webSocket.send(JSONArray().put("REQ").put(subId).put(filter).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                dropped(conn, webSocket)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                dropped(conn, webSocket)
            }
        }
        synchronized(conn) { conn.ws = http.newWebSocket(request, listener) }
    }

    private fun dropped(conn: RelayConn, ws: WebSocket) {
        synchronized(conn) {
            if (conn.ws === ws) {
                conn.ws = null
                conn.open = false
            }
        }
        scheduleReconnect(conn)
    }

    /** Per-socket exponential backoff, 1s..30s (nostr.ts scheduleReconnect). */
    private fun scheduleReconnect(conn: RelayConn) {
        if (closed) return
        synchronized(conn) {
            if (conn.reconnectPending) return
            conn.reconnectPending = true
        }
        val delayMs = minOf(30_000L, 1000L * (1L shl minOf(conn.attempts, 5)))
        conn.attempts += 1
        scope.launch {
            delay(delayMs)
            synchronized(conn) { conn.reconnectPending = false }
            connect(conn)
        }
    }

    private fun handleMessage(text: String) {
        val arr = try {
            JSONArray(text)
        } catch (e: Exception) {
            return
        }
        if (arr.length() < 3 || arr.optString(0) != "EVENT" || arr.optString(1) != subId) return
        val ev = arr.optJSONObject(2) ?: return
        if (ev.optString("pubkey") == pubkeyHex) return // our own publish echoed back
        val id = ev.optString("id")
        if (id.isEmpty() || !seenIds.add(id)) return // same event via another relay
        onEvent(id, ev.optString("content"))
    }

    /** Publish sealed content to every live relay; returns how many took it. */
    fun publish(content: String): Int {
        val createdAt = System.currentTimeMillis() / 1000L
        val tags = listOf(listOf("x", topic))
        val id = Nip01.eventId(pubkeyHex, createdAt, EPHEMERAL_KIND, tags, content)
        val sig = Secp256k1.signSchnorr(AnywhereCrypto.fromHex(id), privKey, null)
        val ev = JSONObject()
            .put("id", id)
            .put("pubkey", pubkeyHex)
            .put("created_at", createdAt)
            .put("kind", EPHEMERAL_KIND)
            .put("tags", JSONArray().put(JSONArray().put("x").put(topic)))
            .put("content", content)
            .put("sig", AnywhereCrypto.toHex(sig))
        val msg = JSONArray().put("EVENT").put(ev).toString()
        var sent = 0
        for (conn in conns) {
            val ws = synchronized(conn) { if (conn.open) conn.ws else null }
            if (ws != null && ws.send(msg)) sent += 1
        }
        return sent
    }

    fun close() {
        closed = true
        scope.cancel()
        for (conn in conns) {
            val ws = synchronized(conn) { conn.ws }
            try {
                ws?.close(1000, null)
            } catch (e: Exception) {
                // already gone
            }
        }
    }
}

// ---------------------------------------------------------------------------
// oversize frames (packages/remote/src/tunnel.ts Reassembler)

class Reassembler {
    private class Entry(val n: Int) {
        var got = 0
        val parts = arrayOfNulls<String>(n)
        val at = System.currentTimeMillis()
    }

    private val pending = HashMap<String, Entry>()

    /** Feed a frame; returns the completed inner frame, the frame itself when unsplit, or null while waiting. */
    @Synchronized
    fun feed(frame: JSONObject): JSONObject? {
        if (frame.optString("t") != "part") return frame
        val pid = frame.optString("pid")
        val i = frame.optInt("i", -1)
        val n = frame.optInt("n", 0)
        if (pid.isEmpty() || n <= 0 || i < 0 || i >= n) return null
        val entry = pending.getOrPut(pid) { Entry(n) }
        if (i >= entry.n) return null
        if (entry.parts[i] == null) entry.got += 1
        entry.parts[i] = frame.optString("s")
        if (entry.got < entry.n) {
            // GC anything half-assembled for over a minute
            val now = System.currentTimeMillis()
            val iter = pending.entries.iterator()
            while (iter.hasNext()) {
                if (now - iter.next().value.at > 60_000) iter.remove()
            }
            return null
        }
        pending.remove(pid)
        return try {
            JSONObject(entry.parts.joinToString(""))
        } catch (e: Exception) {
            null
        }
    }
}

// ---------------------------------------------------------------------------
// tunnel client (packages/remote/src/tunnel.ts TunnelClient — relay tier only;
// the phone skips the WebRTC upgrade and ignores "webrtc" frames)

/** What the top-bar badge shows while remote. */
data class AnywhereBadge(val connected: Boolean, val daemonName: String?)

class Tunnel(private val payload: PairingPayload) {
    /** UI badge sink; called from transport threads. */
    @Volatile
    var onStatus: ((AnywhereBadge) -> Unit)? = null

    /** Fires when fresh live run events arrive (after seq dedupe); called from transport threads. */
    @Volatile
    var onLiveEvent: (() -> Unit)? = null

    private val secret = AnywhereCrypto.fromB64Url(payload.s)
    private val sealKey = AnywhereCrypto.hkdfSha256(secret, AnywhereCrypto.TUNNEL_INFO_C2D) // phone -> daemon
    private val openKey = AnywhereCrypto.hkdfSha256(secret, AnywhereCrypto.TUNNEL_INFO_D2C) // daemon -> phone
    private val topic = AnywhereCrypto.deriveTopic(secret)
    private val sid = randomId()
    private val nextReq = AtomicInteger(1)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Pair<Int, Any?>>>()
    private val guard = ReplayGuard()
    private val reasm = Reassembler()
    private val seenSeqs = LruSet<Long>(1024)

    @Volatile
    private var welcomed = false

    @Volatile
    private var daemonName: String? = null

    @Volatile
    private var nostr: NostrClient? = null

    @Volatile
    private var scope: CoroutineScope? = null

    val badge: AnywhereBadge
        get() = AnywhereBadge(welcomed, daemonName)

    /** Connect the relay bus and start saying hello. Safe to call repeatedly (foreground lifecycle). */
    @Synchronized
    fun start() {
        if (nostr != null) return
        welcomed = false
        pushStatus()
        nostr = NostrClient(payload.relays, topic) { id, content -> onNostrEvent(id, content) }
        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s
        s.launch { // re-send hello every 3s until welcomed (tunnel.ts sayHello)
            while (isActive && !welcomed) {
                try {
                    sendFrame(
                        JSONObject().put("t", "hello").put("sid", sid).put("role", "phone").put("device", "android"),
                    )
                } catch (e: Exception) {
                    // relay bus not up yet; next tick retries
                }
                delay(3_000)
            }
        }
        s.launch { // keep the daemon session warm while foregrounded
            while (isActive) {
                delay(60_000)
                if (welcomed) {
                    try {
                        sendFrame(JSONObject().put("t", "ping").put("sid", sid))
                    } catch (e: Exception) {
                        // best effort
                    }
                }
            }
        }
    }

    /** Tear the transport down (app backgrounded / unpaired). Pending requests fail fast. */
    @Synchronized
    fun stop() {
        scope?.cancel()
        scope = null
        nostr?.close()
        nostr = null
        val err = RuntimeException("Anywhere tunnel closed")
        for (key in pending.keys) {
            pending.remove(key)?.completeExceptionally(err)
        }
    }

    private fun pushStatus() {
        onStatus?.invoke(AnywhereBadge(welcomed, daemonName))
    }

    /** Perform a tunneled REST request: {t:"req"} -> {t:"res"} matched by id, 30s timeout. */
    suspend fun request(method: String, path: String, body: JSONObject? = null): Pair<Int, Any?> {
        if (nostr == null) throw RuntimeException("Anywhere tunnel is offline")
        val id = "${sid}.${nextReq.getAndIncrement()}"
        val waiter = CompletableDeferred<Pair<Int, Any?>>()
        pending[id] = waiter
        try {
            val frame = JSONObject().put("t", "req").put("id", id).put("method", method).put("path", path)
            if (body != null) frame.put("body", body)
            withContext(Dispatchers.IO) { sendFrame(frame) }
            return withTimeout(30_000L) { waiter.await() }
        } catch (e: TimeoutCancellationException) {
            throw RuntimeException("Anywhere request timed out: $method $path")
        } finally {
            pending.remove(id)
        }
    }

    /** Seal {ts,f} and publish; frames longer than the relay cap ride as "part" frames (tunnel.ts splitFrame). */
    private fun sendFrame(frame: JSONObject) {
        val bus = nostr ?: return
        val json = frame.toString()
        if (json.length <= RELAY_MAX_CHARS) {
            publishSealed(bus, frame)
            return
        }
        val n = (json.length + RELAY_MAX_CHARS - 1) / RELAY_MAX_CHARS
        val pid = randomId()
        for (i in 0 until n) {
            val end = minOf((i + 1) * RELAY_MAX_CHARS, json.length)
            val part = JSONObject()
                .put("t", "part").put("pid", pid).put("i", i).put("n", n)
                .put("s", json.substring(i * RELAY_MAX_CHARS, end))
            publishSealed(bus, part)
        }
    }

    private fun publishSealed(bus: NostrClient, frame: JSONObject) {
        val envelope = JSONObject().put("ts", System.currentTimeMillis()).put("f", frame)
        bus.publish(AnywhereCrypto.seal(sealKey, envelope.toString()))
    }

    private fun onNostrEvent(id: String, content: String) {
        val plaintext = try {
            AnywhereCrypto.open(openKey, content)
        } catch (e: Exception) {
            return // foreign or corrupted traffic on the topic — not ours
        }
        val envelope = try {
            JSONObject(plaintext)
        } catch (e: Exception) {
            return
        }
        if (!guard.check(id, envelope.optLong("ts"))) return // stale or replayed
        val frame = envelope.optJSONObject("f") ?: return
        handleFrame(frame)
    }

    private fun handleFrame(raw: JSONObject) {
        val frame = reasm.feed(raw) ?: return
        when (frame.optString("t")) {
            "welcome" -> {
                if (frame.optString("sid") != sid) return // meant for a sibling device
                welcomed = true
                daemonName = frame.optString("name", payload.name)
                pushStatus()
            }
            "res" -> {
                val waiter = pending.remove(frame.optString("id")) ?: return
                waiter.complete(Pair(frame.optInt("status"), frame.opt("body")))
            }
            "ev" -> {
                val items = frame.optJSONArray("items") ?: return
                var fresh = false
                for (i in 0 until items.length()) {
                    val item = items.optJSONObject(i) ?: continue
                    if (!item.has("q")) continue
                    if (seenSeqs.add(item.optLong("q"))) fresh = true
                }
                if (fresh) onLiveEvent?.invoke()
            }
            else -> {
                // "pong" keeps the session warm server-side; "webrtc" and anything
                // unknown is deliberately ignored (tunnel.ts handleFrame default)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// transport seam: RunsScreen / RunDetailScreen speak this, LAN or Anywhere alike

interface DaemonTransport {
    suspend fun getArray(path: String): JSONArray
    suspend fun getObject(path: String): JSONObject
    suspend fun post(path: String, body: JSONObject?): JSONObject

    /** Live-event hook; polling remains the safety net for transports that never call it. */
    fun setEventListener(listener: (() -> Unit)?) {}
}

/** The existing LAN REST path, unchanged underneath. */
class LanTransport(private val daemon: Daemon) : DaemonTransport {
    override suspend fun getArray(path: String): JSONArray =
        withContext(Dispatchers.IO) { JSONArray(daemon.get(path)) }

    override suspend fun getObject(path: String): JSONObject =
        withContext(Dispatchers.IO) { JSONObject(daemon.get(path)) }

    override suspend fun post(path: String, body: JSONObject?): JSONObject =
        withContext(Dispatchers.IO) { JSONObject(daemon.post(path, body?.toString())) }
}

/** The same REST surface carried over the encrypted relay tunnel. */
class TunnelTransport(private val tunnel: Tunnel) : DaemonTransport {
    override suspend fun getArray(path: String): JSONArray =
        exec("GET", path, null) as? JSONArray ?: throw RuntimeException("unexpected response shape")

    override suspend fun getObject(path: String): JSONObject =
        exec("GET", path, null) as? JSONObject ?: throw RuntimeException("unexpected response shape")

    override suspend fun post(path: String, body: JSONObject?): JSONObject =
        exec("POST", path, body) as? JSONObject ?: JSONObject()

    override fun setEventListener(listener: (() -> Unit)?) {
        tunnel.onLiveEvent = listener
    }

    private suspend fun exec(method: String, path: String, body: JSONObject?): Any? {
        val (status, resBody) = tunnel.request(method, path, body)
        if (status >= 400) {
            val msg = (resBody as? JSONObject)?.optString("error", "")?.takeIf { it.isNotBlank() } ?: "HTTP $status"
            throw RuntimeException(msg)
        }
        return resBody
    }
}
