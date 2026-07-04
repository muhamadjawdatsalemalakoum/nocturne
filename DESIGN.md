# Nocturne — Design System

Nocturne is styled after **Claude/Anthropic**: warm and calm, editorial, and quietly
powerful. The layout is **Figma-like** — a full-bleed canvas with white panels that
float above it and minimize/maximize — and the interaction model is **Apple-simple**:
options over empty fields, one-tap templates and presets, progressive disclosure of
advanced controls. It is easy to pick up and hard to put down, without hiding power.

Open source, so it leans into Anthropic's palette on purpose.

## 1. Palette — Anthropic ivory & clay

A warm light theme. One accent — Claude **clay/coral** — carries brand and "active,"
never decoration.

```
--canvas   #ECEAE1  deep ivory (canvas)     --surface   #FFFFFF  panels & nodes
--bg       #F5F4EE  ivory                   --surface-2 #FAF9F5  insets / secondary rows
--rule     #E7E4DA  warm hairline           --rule-strong #D8D4C6
--text     #1F1E1D  warm near-black ink     --muted     #6B6A63   --faint #9A988E
--accent   #CC785C  Claude clay             --accent-bright #D97757 (hover)  --accent-tint #FBF1EC
```

Status ramp, tuned for a warm light field (systematic, never rainbow pills):

```
running #CC785C (clay = active)   waiting #BF8A30 (ochre)   done #6B8E5A (sage)
failed  #BC4B3C (brick)           queued  #B3B0A5 (warm grey)
```

## 2. Type

Three faces, bundled fully offline via `@fontsource-variable`:

- **Fraunces** — the "Nocturne" wordmark and empty-state voice (a warm editorial serif).
- **Hanken Grotesk** — all UI: labels, titles, body, buttons.
- **Martian Mono** — every number: timing, durations, cost, model tags, run IDs, logs —
  with `tabular-nums` so figures never reflow.

## 3. Layout — floating panels over a full canvas

- The canvas fills the viewport (a soft warm dot-grid).
- A **frosted pill toolbar** floats at the top: moon mark + wordmark + workflow name, then
  undo/redo, Import/Export/Save, Runs, and the clay **Run** button.
- **Build** panel (left) and **Properties** panel (right) float over the canvas, each with a
  header and a **minimize/maximize** toggle. The **Run** panel floats bottom-right, collapsible
  and closable.
- Panels are white with a soft warm shadow and generous rounding (`--r-panel` 16px); nodes and
  rows use tighter `--r-card` 11px. Rounding varies by role, it is not one global radius.

## 4. Options over fields — the Apple move

Free-text is a last resort. The Properties panel offers, in order of reach:

- **Model** — a segmented control (inherit / haiku / sonnet / opus).
- **Prompt** — one-tap starter chips (Analyze, Implement, Write tests, Review, Summarize,
  Use prior step) above the editor; the editor is there when you want it, not before.
- **Tools** — preset bundles (Read-only / Edit code / Full access) plus toggle-chips per tool;
  no comma-separated typing.
- **Permission** — a plain-language dropdown ("Deny unlisted tools (safe default)").
- **Wait** — segmented mode with duration presets (15m / 1h / 4h / 8h) or a clock time.
- **Advanced** — cwd, effort, session-continuation, custom tool patterns — tucked behind a
  disclosure so the common case stays clean.

**Templates** turn a blank canvas into a working pipeline in one click — Overnight refactor,
Fix failing tests, Research & summarize, Rate-limit-safe pipeline, Implement · approve · ship.

## 5. Nodes, edges & the moon

- **Nodes** are clean white cards: a moon status glyph, title, a mono `model · subagent` line,
  and a prompt/status readout. Status reads from the moon (phase + colour) and a whisper-subtle,
  *symmetric* border tint — never a colored left rule. The running node streams a live activity
  line. Handles are invisible (no dot chrome).
- **Edges** are orthogonal (`smoothstep`) hairlines; completed edges go sage, the one active edge
  flows clay in the direction of dataflow.
- The **moon-phase primitive** is the logo, favicon, and every node's status glyph — new = queued,
  waxing = running, full = done — recolored to clay/slate.

## 6. Restraint — earned, not decorative

Ornament has to encode something true, or it reads as generated. A few lines held against the
"AI slop" defaults (researched, not guessed):

- **No colored left-border rails.** The 3px status/accent stripe welded to a card is the single
  most reliable tell of generated UI. Status lives in the moon glyph + a symmetric border tint;
  emphasis lives in type, spacing, and colour — never a bolted-on bar.
- **Solid surfaces, not glass.** Panels and the toolbar are ivory with a hairline and a soft
  shadow. `backdrop-blur` is reserved for a surface that genuinely floats over content (the image
  lightbox), not sprayed on for a "modern" look.
- **Shape is a hierarchy axis.** Pills only for the primary floating toolbar; fine controls
  (tool chips, presets) take the tight `--r-chip` radius. Never one radius on everything.
- **No emoji as chrome.** Danger is said in language and colour (brick text), not a ⚠.
- **Elevation is information.** Three shadow tokens map to real depth; flat things separate with a
  hairline or a tint step, not a reflexive drop shadow on every card.

## 7. Motion — restrained, Apple easing

`cubic-bezier(0.32, 0.72, 0, 1)`, ~180ms. Buttons settle on press; panels and chips transition
color, not scale. A slow breath marks waiting; a slow clay flow marks the active edge. Everything
else holds still. `prefers-reduced-motion` drops all ambient motion.

## 7. Implementation

Tokens: `packages/ui/src/styles.css` (`:root`). Fonts import in `main.tsx`. Moon primitive
`moon.tsx`; icons `icons.tsx`; templates & presets `templates.ts`; nodes `nodes.tsx`;
layout `App.tsx`; options-first properties `Inspector.tsx`. Plain CSS variables + React —
no framework — for full control and a self-contained, offline bundle.
```
