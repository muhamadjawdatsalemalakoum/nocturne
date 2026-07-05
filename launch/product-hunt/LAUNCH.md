# Nocturne — Product Hunt launch kit

Everything you need to launch, copy-paste ready. Assets are in `./assets/`.

---

## 1. The essentials

| Field | Value |
|---|---|
| **Name** | Nocturne |
| **Tagline** (≤60 chars) | `Run Claude Code workflows while you sleep` |
| **Website** | https://muhamadjawdatsalemalakoum.github.io/nocturne/ |
| **GitHub** | https://github.com/muhamadjawdatsalemalakoum/nocturne |
| **Pricing** | Free · Open source (MIT) |
| **Platforms** | Web · macOS · Windows · Linux · Android |
| **Topics** (pick 3) | Developer Tools · Artificial Intelligence · Open Source |

### Tagline alternatives (in case you want to A/B)
- `Run Claude Code workflows while you sleep` ← **recommended**
- `Durable Claude Code workflows that survive the night`
- `Design Claude Code pipelines on a canvas, run overnight`
- `The durability layer for Claude Code`

---

## 2. Description (the short blurb under the tagline, ~260 chars)

> Nocturne is a local, open-source workflow runner for Claude Code. Design multi-agent pipelines on a canvas and run them unattended — hit your usage limit at 2am and it checkpoints, waits for the reset, and resumes. Plus a peer-to-peer mobile app to watch it from anywhere.

---

## 3. The maker's first comment (post this immediately after launch)

> Hey Product Hunt 👋
>
> I live in Claude Code. But two things always nagged at me:
>
> **1. It dies when the session dies.** Close the terminal or let the laptop sleep, and a long multi-step run is just gone.
> **2. The usage limit is a wall.** Hit it at 2am and everything stops — you come back to a job that quit halfway.
>
> Anthropic's cloud Routines give you durability, but they run in a fresh clone — not *your* machine, your files, your MCP servers, your toolchain. The local CLI has all your context but none of the durability. Nobody fills the gap in between.
>
> **That's Nocturne.**
>
> You lay out a multi-step agent pipeline on an infinite canvas — pick the model per step, drop in timed waits, human approval gates, and if/else branches — then hit **Run**. Each step runs as its own Claude Code subagent, in its own context, handing its output to the next.
>
> And the feature the whole thing is built around: **when a run hits your usage limit, it checkpoints, waits for the window to reset, and resumes exactly where it stopped.** Unattended execution on the flat-rate subscription you already pay for — you get to use 100% of your plan, including the hours you're asleep. 🌙
>
> A few things I'm proud of:
>
> 🔭 **Retrace** reads your last 24h of Claude Code sessions — locally — and drafts reusable workflows from what you actually did.
>
> 📱 **The first Claude Code plugin with a peer-to-peer mobile companion.** Start the daemon with `--remote`, scan a QR, and monitor + approve runs from your phone — from *any* network, not just your Wi-Fi. End-to-end encrypted, no account, no server of mine in the middle; it even upgrades to a direct phone↔laptop connection when the networks allow.
>
> 🔌 **Drive it from Claude itself** over MCP — "run the overnight-refactor on this repo", "how's it going?", "approve the gate."
>
> It's **free, open-source (MIT), and fully local.** It spawns the official `claude` binary, so it runs on your plan, never touches your tokens, and nothing leaves your machine.
>
> Try it → https://muhamadjawdatsalemalakoum.github.io/nocturne/
> Code → https://github.com/muhamadjawdatsalemalakoum/nocturne
>
> I'd genuinely love to know: **what's the first overnight workflow you'd run?**

---

## 4. Gallery images (in `./assets/`, order matters)

Product Hunt shows these as a carousel; the **first is the most important** (it's the feed thumbnail on some surfaces). Recommended order:

1. `gallery-1-cover.png` — the hook: "Run Claude Code workflows while you sleep"
2. `gallery-2-canvas.png` — design multi-agent pipelines on a canvas
3. `gallery-3-resume.png` — the hero feature: hits the limit, waits, resumes
4. `gallery-4-mobile.png` — peer-to-peer mobile companion, any network
5. `gallery-5-branch.png` — if/else branching + drive it from Claude (MCP)
6. `gallery-6-open.png` — free, open-source, local, tested
- `demo.gif` — the "full run" walkthrough animating (use as the **first** gallery slide if PH accepts it there; GIFs autoplay and dramatically lift engagement)
- `thumbnail.png` (240×240) — the logo/avatar for the listing

---

## 5. Social launch posts

### X / Twitter (launch tweet)
> Nocturne is live on Product Hunt today 🌙
>
> Design multi-agent Claude Code workflows on a canvas → run them unattended.
>
> Hit your usage limit at 2am? It checkpoints, waits for the reset, and resumes where it stopped. On the subscription you already pay for.
>
> Free & open source 👇
> [PH link]

### X thread (follow-ups)
> 1/ The core idea: "works on your subscription" and "survives the usage limit" are the same feature. You can't run unattended without an engine that checkpoints, waits out the reset, and resumes. That engine is the product.
>
> 2/ It's the first Claude Code plugin with a peer-to-peer mobile companion. Scan a QR, watch your runs from your phone — from any network, end-to-end encrypted, no account, no server in the middle. Approve a gate from bed. 📱
>
> 3/ Retrace reads your last 24h of Claude Code sessions locally and drafts reusable workflows from what you actually did. The hardest part of automation is noticing what's worth automating — it does that for you.
>
> 4/ Drive it from Claude itself over MCP. "Run the overnight-refactor on this repo." "Approve the gate." The run keeps going after the chat ends.
>
> 5/ Free, MIT, fully local. It spawns the official `claude` binary — runs on your plan, never touches your tokens, nothing leaves your machine.
> ⭐ [GitHub]  ·  🚀 [PH link]

### LinkedIn
> I just launched Nocturne on Product Hunt 🌙
>
> It's a local, open-source workflow runner for Claude Code. You design a multi-step agent pipeline on a canvas and run it unattended — and when it hits your usage limit at 2am, it checkpoints, waits for the reset, and resumes exactly where it stopped. Unattended automation on the flat-rate plan you already have.
>
> It also ships the first peer-to-peer mobile companion for a Claude Code plugin — monitor and approve runs from your phone, from any network, end-to-end encrypted.
>
> Free and MIT-licensed. Would love your support and feedback 👇
> [PH link]

### Show HN / Reddit (r/ClaudeAI, r/programming)
> **Show HN: Nocturne – Durable Claude Code workflows that survive the usage limit**
>
> I wanted my Claude Code runs to keep going after I close the terminal — and to not die when they hit the 5-hour usage window. So I built a local daemon that runs multi-step agent pipelines, checkpoints every state transition, and auto-resumes after a limit reset. It spawns the official `claude` binary (runs on your subscription, never extracts tokens), has a visual canvas, an MCP server, and a peer-to-peer mobile companion. MIT-licensed.
>
> Site: [link] · Code: [link] · Happy to answer anything.

---

## 6. Launch-day checklist

**Timing:** Product Hunt's day starts at **12:01am PT**. Launch right at the reset so you get a full 24h on the leaderboard. Tuesday–Thursday tend to be most competitive but highest-traffic.

**Before launch**
- [ ] Create the PH listing as a draft the night before; add all gallery images + thumbnail
- [ ] Set the maker's first comment ready to paste (section 3)
- [ ] Make sure the website is live and fast (it is — hard-refresh to confirm)
- [ ] Line up 5–10 friends/colleagues who'll genuinely try it and comment (not just upvote — PH weights real engagement)
- [ ] Pin a repo README banner / GitHub social preview (the og-card is already set)
- [ ] Have the GitHub repo topics set: `claude-code`, `ai-agents`, `workflow-automation`, `mcp`, `developer-tools`

**At launch (12:01am PT)**
- [ ] Publish the listing
- [ ] Post the maker's first comment immediately
- [ ] Post the X launch tweet + thread; LinkedIn; relevant subreddits/Discords
- [ ] Message your warm list with the direct link

**Through the day**
- [ ] Reply to **every** comment within minutes — PH rewards maker activity
- [ ] Post a mid-day update if you cross a milestone ("#3 of the day, thank you!")
- [ ] Share in Claude/AI communities where it's genuinely relevant (don't spam)

**Rules of thumb**
- Never ask for "upvotes" directly (against PH guidelines) — ask people to "check it out" / "try it."
- Engagement > raw votes. Real comments and questions move you up.

---

## 7. Comment-prep (answers ready for likely questions)

**"How is this different from Anthropic's Routines?"**
Routines run in a fresh cloud clone. Nocturne runs on *your* machine — your files, MCP servers, toolchain, permission rules — and survives closing the session. It's the durability layer on top of your local environment, not a separate cloud.

**"Does it use my API key / cost extra?"**
No. It spawns the official `claude` binary, so it runs on your existing subscription and never extracts or handles your tokens. Flat-rate — no per-token metering.

**"Is the mobile thing really peer-to-peer?"**
Yes. The pairing secret lives only in the QR (in the URL fragment, never sent to a server). Your phone and laptop find each other through public rendezvous relays that only ever carry ciphertext, and upgrade to a direct WebRTC connection when the networks allow. No account, no server I run.

**"Windows/Mac/Linux?"** All three (Node daemon). Android app for mobile; iOS is on the roadmap.

**"Self-hostable / private?"** It's fully local by default (binds to localhost). LAN and internet access are explicit opt-in flags.

**"What's the catch / license?"** MIT. No catch. Roadmap: OS wake helpers, iOS app, a shared workflow gallery.

---

## 8. One-liners (for bios, DevHunt, BetaList, etc.)
- Nocturne — run Claude Code workflows while you sleep.
- The durability layer for Claude Code: design on a canvas, run overnight, resume after the limit.
- Local, open-source, peer-to-peer. Your agents, your machine, your plan.
