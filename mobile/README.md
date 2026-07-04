# Nocturne mobile

Native companion apps for the Nocturne daemon — pair by QR over your own Wi-Fi (peer-to-peer,
no account, no cloud) and monitor/control runs on the go.

## Android (`mobile/android`)

Kotlin + Jetpack Compose (Material 3), Nocturne branding. Screens: **Pair** (scan the QR from the
canvas's Pair dialog, or paste the link), **Runs** (live-refreshing list with status + cost), and
**Run detail** (per-step status and output, Pause / Resume / Cancel, and Approve/Reject right on
an approval gate).

**Get the APK:** every change to `mobile/` builds `nocturne-android.apk` in GitHub Actions
(*android-apk* workflow → artifact), and tagged releases attach it to the release. Sideload it
(enable "install unknown apps"), start the daemon with `nocturne serve --lan`, tap the phone icon
in the canvas toolbar, and scan.

**Build locally:** `gradle -p mobile/android assembleDebug` (Android SDK + JDK 17).

Status: v0.1 — monitoring + control parity. Live WebSocket streaming, workflow launch with
params, and Retrace on mobile are next. **iOS: coming soon.**

The web canvas itself is also a mobile-optimized PWA — the paired URL can simply be added to your
home screen if you don't want to sideload.
