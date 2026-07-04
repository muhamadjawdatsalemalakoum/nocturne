package space.nocturne.app

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
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

    fun health(): String = JSONObject(run(req("/api/health"))).optString("version", "?")
    fun runs(): JSONArray = JSONArray(run(req("/api/runs")))
    fun runDetail(id: String): JSONObject = JSONObject(run(req("/api/runs/$id")))
    fun action(id: String, verb: String): JSONObject = JSONObject(run(req("/api/runs/$id/$verb", "POST")))
    fun approve(id: String, nodeId: String, ok: Boolean): JSONObject =
        JSONObject(run(req("/api/runs/$id/approve", "POST", JSONObject().put("nodeId", nodeId).put("approved", ok).toString())))
}

// ---------- persistence for the pairing ----------
fun saveDaemon(ctx: Context, url: String, token: String?) {
    ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE).edit()
        .putString("url", url).putString("token", token).apply()
}
fun loadDaemon(ctx: Context): Pair<String, String?>? {
    val p = ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE)
    val url = p.getString("url", null) ?: return null
    return Pair(url, p.getString("token", null))
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
    var pairing by remember { mutableStateOf(loadDaemon(ctx)) }
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Clay, background = Cream, surface = Color.White,
            onBackground = Ink, onSurface = Ink,
        ),
    ) {
        Surface(Modifier.fillMaxSize(), color = Cream) {
            val p = pairing
            if (p == null) PairScreen { url, token -> saveDaemon(ctx, url, token); pairing = Pair(url, token) }
            else RunsScreen(daemon = Daemon(p.first, p.second), baseUrl = p.first) {
                saveDaemon(ctx, "", null)
                ctx.getSharedPreferences("nocturne", Context.MODE_PRIVATE).edit().clear().apply()
                pairing = null
            }
        }
    }
}

// ---------- pairing ----------
@Composable
fun PairScreen(onPaired: (String, String?) -> Unit) {
    var manualUrl by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun accept(raw: String) {
        try {
            val uri = android.net.Uri.parse(raw.trim())
            val token = uri.getQueryParameter("token")
            val base = "${uri.scheme ?: "http"}://${uri.host}:${if (uri.port > 0) uri.port else 5151}"
            if (uri.host.isNullOrBlank()) throw RuntimeException("no host")
            onPaired(base, token)
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
            "Pair with the daemon on your computer.\nSame Wi-Fi · peer-to-peer · nothing leaves your network.",
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
            "On your computer: nocturne serve --lan, then tap the phone icon in the toolbar.",
            color = Muted, fontSize = 12.sp, lineHeight = 17.sp,
        )
    }
}

// ---------- runs ----------
@Composable
fun RunsScreen(daemon: Daemon, baseUrl: String, onUnpair: () -> Unit) {
    var runs by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            val arr = withContext(Dispatchers.IO) { daemon.runs() }
            runs = (0 until arr.length()).map { arr.getJSONObject(it) }
                .sortedByDescending { it.optLong("createdAt") }
            error = null
        } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(Unit) { while (true) { refresh(); delay(2500) } }

    val sel = selected
    if (sel != null) {
        RunDetailScreen(daemon, sel, onBack = { selected = null })
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
        Text(baseUrl, color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
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
fun RunDetailScreen(daemon: Daemon, runId: String, onBack: () -> Unit) {
    var run by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try { run = withContext(Dispatchers.IO) { daemon.runDetail(runId) } } catch (_: Exception) {}
    }
    LaunchedEffect(runId) { while (true) { refresh(); delay(1500) } }

    fun act(block: suspend () -> Unit) {
        scope.launch { busy = true; try { withContext(Dispatchers.IO) { block() } } catch (_: Exception) {}; refresh(); busy = false }
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
            if (status == "running") ControlButton("Pause", Muted, busy) { act { daemon.action(runId, "pause") } }
            if (status == "paused" || status == "waiting_timer" || status == "interrupted")
                ControlButton("Resume now", Clay, busy) { act { daemon.action(runId, "resume") } }
            if (status !in listOf("completed", "failed", "canceled"))
                ControlButton("Cancel", Brick, busy) { act { daemon.action(runId, "cancel") } }
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
                                    onClick = { act { daemon.approve(runId, id, true) } },
                                    colors = ButtonDefaults.buttonColors(containerColor = Clay),
                                    shape = RoundedCornerShape(10.dp), enabled = !busy,
                                    modifier = Modifier.weight(1f).height(46.dp),
                                ) { Text("Approve") }
                                OutlinedButton(
                                    onClick = { act { daemon.approve(runId, id, false) } },
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
