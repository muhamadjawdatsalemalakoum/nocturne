🌙 **Nocturne — run Claude Code workflows while you sleep.**

Design multi-agent Claude Code pipelines on a canvas and run them unattended. When a run hits your usage limit, it checkpoints, waits for the window to reset, and resumes exactly where it stopped — on the subscription you already pay for.

## Downloads

**📱 Android app — `nocturne-android.apk`** (attached below)
Enable "install unknown apps", sideload the APK, then start the daemon with `nocturne serve --remote` (works from any network) or `--lan` (same Wi-Fi), tap the phone icon in the canvas, and scan the QR. Verify the download against the attached `nocturne-android.apk.sha256`.

**💻 Daemon — macOS · Windows · Linux** (grab the source archive below)
```bash
npm install
npm run build:ui          # build the canvas
npm run serve             # daemon → http://localhost:5151
```
For unattended overnight runs, set up a long-lived token: `claude setup-token`.

---

Full walkthrough → https://muhamadjawdatsalemalakoum.github.io/nocturne/
Format, semantics & architecture → [SPEC.md](https://github.com/muhamadjawdatsalemalakoum/nocturne/blob/main/SPEC.md) · MCP + Desktop setup → [integrations/README.md](https://github.com/muhamadjawdatsalemalakoum/nocturne/blob/main/integrations/README.md)

Free · open source (MIT) · fully local — it spawns the official `claude` binary, so it runs on your plan and never touches your tokens.
