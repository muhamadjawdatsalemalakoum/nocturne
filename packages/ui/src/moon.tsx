import type { CSSProperties } from "react";

export type Phase = "new" | "waxing" | "full" | "wait" | "fail";

/**
 * The load-bearing Nocturne motif: a circle occluded by a terminator.
 * Logo, favicon, node status glyph, and progress dial are all this one shape.
 *   new    = queued        (empty ring)
 *   waxing = running       (illuminated right limb)
 *   full   = done          (full disc)
 *   wait   = holding       (ring + horizon line)
 *   fail   = failed        (ring + strike)
 */
export function Moon({
  phase = "new",
  size = 18,
  className,
  style,
}: {
  phase?: Phase;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const r = 9;
  const c = 12;
  const clipId = `mn-${phase}-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={c} cy={c} r={r} />
        </clipPath>
      </defs>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {phase === "full" && <circle cx={c} cy={c} r={r} fill="currentColor" />}
      {phase === "waxing" && (
        <rect x={c} y={c - r} width={r} height={r * 2} fill="currentColor" opacity="0.6" clipPath={`url(#${clipId})`} />
      )}
      {phase === "wait" && <line x1={c - r} y1={c} x2={c + r} y2={c} stroke="currentColor" strokeWidth="1.5" />}
      {phase === "fail" && <line x1={c - r + 1} y1={c - r + 1} x2={c + r - 1} y2={c + r - 1} stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

/** Continuous progress dial (0..1) — the terminator sweeps as the run completes. */
export function MoonProgress({ progress = 0, size = 18, className }: { progress?: number; size?: number; className?: string }) {
  const r = 9;
  const c = 12;
  const p = Math.max(0, Math.min(1, progress));
  const clipId = `mp-${size}`;
  const litW = r * 2 * p;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={c} cy={c} r={r} />
        </clipPath>
      </defs>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {p > 0 && <rect x={c + r - litW} y={c - r} width={litW} height={r * 2} fill="currentColor" opacity="0.55" clipPath={`url(#${clipId})`} />}
    </svg>
  );
}

/** Brand mark: a clean clay crescent moon. Doubles as the wordmark glyph. */
export function MoonMark({ size = 20 }: { size?: number }) {
  const c = 12;
  const r = 9;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <clipPath id="brand-moon">
          <circle cx={c} cy={c} r={r} />
        </clipPath>
      </defs>
      <circle cx={c} cy={c} r={r} fill="var(--accent)" />
      <circle cx={c + 4} cy={c - 2.5} r={r - 0.5} fill="var(--surface)" clipPath="url(#brand-moon)" />
    </svg>
  );
}
