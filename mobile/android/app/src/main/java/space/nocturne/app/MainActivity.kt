package space.nocturne.app

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// ---------- Nocturne palette (mirrors the canvas design system) ----------
val Cream = Color(0xFFF5F4EE)
val Surface2 = Color(0xFFFAF9F5)
val Rule = Color(0xFFE7E4DA)
val Ink = Color(0xFF1F1E1D)
val Muted = Color(0xFF6B6A63)
val Clay = Color(0xFFCC785C)
val ClayTint = Color(0xFFFBF1EC)
val Sage = Color(0xFF6B8E5A)
val Ochre = Color(0xFFBF8A30)
val Brick = Color(0xFFBC4B3C)

fun statusColor(s: String): Color = when (s) {
    "running" -> Clay
    "waiting", "waiting_timer", "waiting_approval" -> Ochre
    "succeeded", "completed" -> Sage
    "failed", "canceled" -> Brick
    else -> Muted
}

// ---------- tiny daemon client (OkHttp + org.json — no codegen, no surprises) ----------
class Daemon(private val base: String, private val token: String?) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val json = "application/json".toMediaType()

    private fun req(path: String, method: String = "GET", body: String? = null): Request {
        val b = Request.Builder().url("$base$path")
        if (token != null) b.header("Authorization", "Bearer $token")
        if (method == "POST") b.post((body ?: "{}").toRequestBody(json))
        return b.build()
    }

    private fun run(r: Request): String {
        http.newCall(r).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) {
                val msg = try { JSONObject(text).optString("error", res.message) } catch (e: Exception) { res.message }
                throw RuntimeException(msg.ifBlank { "HTTP ${res.code}" })
            }
            return text
        }
    }

    fun get(path: String): String = run(req(path))
    fun post(path: String, body: String? = null): String = run(req(path, "POST", body))
}

// ---------- persistence for the pairing (LAN url+token, or Anywhere payload blob) ----------
sealed class Pairing {
    data class Lan(val url: String, val token: String?) : Pairing()
    data class Remote(val blob: String) : Pairing()
}

fun savePairing(ctx: Context, p: Pairing) {
    val e = ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE).edit().clear()
    when (p) {
        is Pairing.Lan -> e.putString("url", p.url).putString("token", p.token)
        is Pairing.Remote -> e.putString("anywhere", p.blob)
    }
    e.apply()
}

fun loadPairing(ctx: Context): Pairing? {
    val prefs = ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE)
    val blob = prefs.getString("anywhere", null)
    if (!blob.isNullOrBlank()) return Pairing.Remote(blob)
    val url = prefs.getString("url", null)
    if (url.isNullOrBlank()) return null
    return Pairing.Lan(url, prefs.getString("token", null))
}

fun clearPairing(ctx: Context) {
    ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE).edit().clear().apply()
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { NocturneApp() }
    }
}

@Composable
fun NocturneApp() {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var pairing by remember { mutableStateOf(loadPairing(ctx)) }
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Clay, background = Cream, surface = Color.White,
            onBackground = Ink, onSurface = Ink,
        ),
    ) {
        Surface(Modifier.fillMaxSize(), color = Cream) {
            val unpair: () -> Unit = { clearPairing(ctx); pairing = null }
            when (val p = pairing) {
                null -> PairScreen { paired -> savePairing(ctx, paired); pairing = paired }
                is Pairing.Lan -> {
                    val transport = remember(p) { LanTransport(Daemon(p.url, p.token)) }
                    RunsScreen(transport = transport, subtitle = p.url, badge = null, onUnpair = unpair)
                }
                is Pairing.Remote -> RemoteHome(blob = p.blob, onUnpair = unpair)
            }
        }
    }
}

/** Anywhere mode: owns the tunnel, ties it to the foreground lifecycle, feeds the badge. */
@Composable
fun RemoteHome(blob: String, onUnpair: () -> Unit) {
    val payloadOrNull = remember(blob) { try { decodePairingPayload(blob) } catch (e: Exception) { null } }
    if (payloadOrNull == null) {
        // stored payload is corrupt — drop back to pairing
        LaunchedEffect(blob) { onUnpair() }
        return
    }
    val payload: PairingPayload = payloadOrNull
    val tunnel = remember(blob) { Tunnel(payload) }
    val transport = remember(blob) { TunnelTransport(tunnel) }
    var badge by remember { mutableStateOf(tunnel.badge) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(tunnel, lifecycleOwner) {
        tunnel.onStatus = { b -> badge = b }
        // relays are public infrastructure: connect only while foregrounded
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> tunnel.start()
                Lifecycle.Event.ON_STOP -> tunnel.stop()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            tunnel.onStatus = null
            tunnel.stop()
        }
    }
    RunsScreen(transport = transport, subtitle = payload.name, badge = badge, onUnpair = onUnpair)
}

// ---------- pairing ----------
@Composable
fun PairScreen(onPaired: (Pairing) -> Unit) {
    var manualUrl by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun accept(raw: String) {
        // Anywhere QR: console URL with #pair=<blob>, or the raw payload blob itself
        val blob = pairingBlobFrom(raw)
        if (blob != null) {
            try {
                decodePairingPayload(blob) // validates version, secret length, relays
                onPaired(Pairing.Remote(blob))
            } catch (e: Exception) {
                error = "That Anywhere pairing code didn't validate."
            }
            return
        }
        // LAN QR: plain daemon URL with ?token=
        try {
            val uri = android.net.Uri.parse(raw.trim())
            val token = uri.getQueryParameter("token")
            val base = "${uri.scheme ?: "http"}://${uri.host}:${if (uri.port > 0) uri.port else 5151}"
            if (uri.host.isNullOrBlank()) throw RuntimeException("no host")
            onPaired(Pairing.Lan(base, token))
        } catch (e: Exception) {
            error = "That doesn't look like a Nocturne pairing link."
        }
    }

    val scanner = androidx.activity.compose.rememberLauncherForActivityResult(ScanContract()) { r ->
        if (r.contents != null) accept(r.contents)
    }

    Column(
        Modifier.fillMaxSize().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        MoonMark(56.dp)
        Spacer(Modifier.height(18.dp))
        Text("Nocturne", fontSize = 32.sp, fontWeight = FontWeight.Medium, color = Ink)
        Text(
            "Pair with the daemon on your computer.\nSame Wi-Fi, or from anywhere over an encrypted relay.",
            color = Muted, fontSize = 14.sp, lineHeight = 20.sp,
            modifier = Modifier.padding(top = 10.dp, bottom = 26.dp),
        )
        Button(
            onClick = {
                scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("Scan the QR from Nocturne's Pair dialog").setBeepEnabled(false))
            },
            colors = ButtonDefaults.buttonColors(containerColor = Clay),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text("Scan pairing QR", fontSize = 16.sp) }
        Spacer(Modifier.height(14.dp))
        OutlinedTextField(
            value = manualUrl, onValueChange = { manualUrl = it },
            label = { Text("or paste the pairing link") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        TextButton(onClick = { if (manualUrl.isNotBlank()) accept(manualUrl) }) { Text("Connect", color = Clay) }
        error?.let { Text(it, color = Brick, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(30.dp))
        Text(
            "On your computer: nocturne serve --lan (same Wi-Fi), or scan the Anywhere QR to control runs from any network.",
            color = Muted, fontSize = 12.sp, lineHeight = 17.sp,
        )
    }
}

// ---------- runs ----------
@Composable
fun RunsScreen(transport: DaemonTransport, subtitle: String, badge: AnywhereBadge?, onUnpair: () -> Unit) {
    var runs by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            val arr = transport.getArray("/api/runs")
            runs = (0 until arr.length()).map { arr.getJSONObject(it) }
                .sortedByDescending { it.optLong("createdAt") }
            error = null
        } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(Unit) { while (true) { refresh(); delay(2500) } }
    DisposableEffect(transport) {
        // live "ev" pushes over the tunnel trigger an immediate re-pull; polling stays the safety net
        transport.setEventListener { scope.launch { refresh() } }
        onDispose { transport.setEventListener(null) }
    }

    val sel = selected
    if (sel != null) {
        RunDetailScreen(transport, sel, onBack = { selected = null })
        return
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(46.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            MoonMark(26.dp)
            Spacer(Modifier.width(10.dp))
            Text("Runs", fontSize = 26.sp, fontWeight = FontWeight.Medium, color = Ink)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onUnpair) { Text("Unpair", color = Muted, fontSize = 13.sp) }
        }
        if (badge != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(Ochre, CircleShape))
                Spacer(Modifier.width(6.dp))
                val label = if (badge.connected) {
                    val name = badge.daemonName
                    if (name.isNullOrBlank()) "Anywhere · encrypted relay"
                    else "Anywhere · encrypted relay · $name"
                } else "Anywhere · connecting…"
                Text(label, color = Muted, fontSize = 12.sp)
            }
        } else {
            Text(subtitle, color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
        Spacer(Modifier.height(14.dp))
        error?.let {
            Card(colors = CardDefaults.cardColors(containerColor = ClayTint), shape = RoundedCornerShape(12.dp)) {
                Text("Can't reach the daemon: $it", color = Brick, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
            }
            Spacer(Modifier.height(10.dp))
        }
        if (runs.isEmpty() && error == null) {
            Text("No runs yet — launch one from the canvas or from Claude.", color = Muted, fontSize = 14.sp)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(runs, key = { it.optString("runId") }) { r ->
                val status = r.optString("status")
                Card(
                    onClick = { selected = r.optString("runId") },
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    shape = RoundedCornerShape(14.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, Rule),
                ) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).background(statusColor(status), CircleShape))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(r.optString("workflowName"), fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = Ink)
                            Text(status.replace('_', ' '), color = statusColor(status), fontSize = 12.sp)
                        }
                        Text("$" + String.format("%.3f", r.optDouble("totalCostUsd", 0.0)),
                            color = Muted, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }
    }
}

// ---------- run detail ----------
@Composable
fun RunDetailScreen(transport: DaemonTransport, runId: String, onBack: () -> Unit) {
    var run by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try { run = transport.getObject("/api/runs/$runId") } catch (_: Exception) {}
    }
    LaunchedEffect(runId) { while (true) { refresh(); delay(1500) } }

    fun act(block: suspend () -> Unit) {
        scope.launch { busy = true; try { block() } catch (_: Exception) {}; refresh(); busy = false }
    }

    val r = run
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(46.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("← Runs", color = Clay) }
            Spacer(Modifier.weight(1f))
            if (r != null) {
                val st = r.optString("status")
                Text(st.replace('_', ' '), color = statusColor(st), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
        }
        if (r == null) { Text("Loading…", color = Muted); return }
        Text(r.optString("workflowName"), fontSize = 22.sp, fontWeight = FontWeight.Medium, color = Ink)
        Text("$" + String.format("%.3f", r.optDouble("totalCostUsd", 0.0)) + "  ·  " + r.optString("runId"),
            color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(12.dp))

        val status = r.optString("status")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (status == "running") ControlButton("Pause", Muted, busy) { act { transport.post("/api/runs/$runId/pause", null) } }
            if (status == "paused" || status == "waiting_timer" || status == "interrupted")
                ControlButton("Resume now", Clay, busy) { act { transport.post("/api/runs/$runId/resume", null) } }
            if (status !in listOf("completed", "failed", "canceled"))
                ControlButton("Cancel", Brick, busy) { act { transport.post("/api/runs/$runId/cancel", null) } }
        }
        Spacer(Modifier.height(12.dp))

        val steps = r.optJSONObject("steps") ?: JSONObject()
        val gate = r.optString("waitingApprovalNodeId", "")
        val order = steps.keys().asSequence().toList()
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(order, key = { it }) { id ->
                val s = steps.getJSONObject(id)
                val st = s.optString("status")
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    shape = RoundedCornerShape(12.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, if (st == "running") Clay.copy(alpha = .5f) else Rule),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(9.dp).background(statusColor(st), CircleShape))
                            Spacer(Modifier.width(8.dp))
                            Text(id, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = Ink, modifier = Modifier.weight(1f))
                            Text(st, color = statusColor(st), fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                        }
                        val out = s.optString("output", "")
                        if (out.isNotBlank()) Text(out.take(280), color = Muted, fontSize = 12.5.sp,
                            lineHeight = 17.sp, modifier = Modifier.padding(top = 6.dp))
                        val err = s.optString("error", "")
                        if (err.isNotBlank()) Text(err.take(280), color = Brick, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
                        if (id == gate && st == "waiting") {
                            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = { act { transport.post("/api/runs/$runId/approve",
                                        JSONObject().put("nodeId", id).put("approved", true)) } },
                                    colors = ButtonDefaults.buttonColors(containerColor = Clay),
                                    shape = RoundedCornerShape(10.dp), enabled = !busy,
                                    modifier = Modifier.weight(1f).height(46.dp),
                                ) { Text("Approve") }
                                OutlinedButton(
                                    onClick = { act { transport.post("/api/runs/$runId/approve",
                                        JSONObject().put("nodeId", id).put("approved", false)) } },
                                    shape = RoundedCornerShape(10.dp), enabled = !busy,
                                    modifier = Modifier.weight(1f).height(46.dp),
                                ) { Text("Reject", color = Brick) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ControlButton(label: String, color: Color, busy: Boolean, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = !busy, shape = RoundedCornerShape(10.dp)) {
        Text(label, color = color)
    }
}

/** The brand mark: a clay disc occluded into a crescent — same motif as the canvas. */
@Composable
fun MoonMark(size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size)) {
        Box(Modifier.size(size).background(Clay, CircleShape))
        Box(
            Modifier.size(size * 0.92f).offset(x = size * 0.25f, y = -size * 0.12f)
                .background(Cream, CircleShape),
        )
    }
}
