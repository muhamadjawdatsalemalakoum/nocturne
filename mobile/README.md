# Nocturne mobile

Native companion apps for the Nocturne daemon — pair by QR and monitor/control runs on the go.
Two ways to connect, both peer-to-peer in spirit and end-to-end private in fact:

- **Anywhere** (`nocturne serve --remote`) — works from **any network**: home, office, LTE behind
  carrier NAT. The phone and the daemon find each other through public rendezvous relays and
  exchange only AES-256-GCM ciphertext under keys derived from the QR secret — no account, no
  port-forwarding, no server of ours, nothing anyone else can read.
- **This Wi-Fi** (`nocturne serve --lan`) — the direct LAN connection, fastest when you're home.

## Android (`mobile/android`)

Kotlin + Jetpack Compose (Material 3), Nocturne branding. Screens: **Pair** (scan either QR from
the canvas's Pair dialog — LAN or Anywhere — or paste the link), **Runs** (live-refreshing list
with status + cost, with tunnel-pushed events applied the moment they arrive), and **Run detail**
(per-step status and output, Pause / Resume / Cancel, and Approve/Reject right on an approval
gate). When connected through Anywhere, the top bar shows an honest transport badge
(*Anywhere · encrypted relay*).

The Anywhere wire protocol lives in
[`Anywhere.kt`](android/app/src/main/java/space/nocturne/app/Anywhere.kt) — a byte-exact Kotlin
port of `packages/remote` (HKDF-SHA256 → AES-256-GCM directional keys, NIP-01 ephemeral events at
kind 24199, BIP-340 schnorr via secp256k1-kmp). It is held to the TS implementation by shared
test vectors: the same
[`anywhere-vectors.json`](android/app/src/test/resources/anywhere-vectors.json) is asserted
byte-for-byte by the JVM unit tests here **and** by `packages/remote/test/vectors.test.ts` — if
either side drifts, a test goes red.

**Get the APK:** every change to `mobile/android/` on main builds `nocturne-android.apk` in GitHub Actions
(*android-apk* workflow → artifact; unit tests gate the build), and tagged releases attach it.
Sideload it (enable "install unknown apps"), start the daemon with `--remote` and/or `--lan`, tap
the phone icon in the canvas toolbar, and scan.

**Build locally:** `gradle -p mobile/android assembleDebug` (Android SDK + JDK 17).
**Unit tests:** `gradle -p mobile/android :app:testDebugUnitTest` (pure JVM — no device needed).

Status: v0.2 — monitoring + control parity over LAN **and** Anywhere, with live tunnel events.
Workflow launch with params and Retrace on mobile are next. **iOS: coming soon.**

The phone console (a PWA) needs no install at all: scan the Anywhere QR with your camera and the
console opens in the browser — add it to your home screen for the app feel.
