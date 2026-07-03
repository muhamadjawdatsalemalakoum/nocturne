import type { JSX } from "react";

/**
 * Bespoke glyph family — 1.75px strokes, BUTT caps, sharp joins, drawn on a 24 grid.
 * The heavier weight + flat caps + astronomical metaphors are the tell that these are
 * drawn, not defaulted (lucide is 1.5px round). Metaphors: meridian ticks, horizons,
 * phases, reticles.
 */
type P = { className?: string };
const svg = (path: JSX.Element): ((p: P) => JSX.Element) =>
  function Icon(p: P) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="butt" strokeLinejoin="miter" className={p.className} aria-hidden="true">
        {path}
      </svg>
    );
  };

// a subagent step — a station on the transit: a node dot framed by a meridian tick
export const IconAgent = svg(
  <>
    <line x1="12" y1="3" x2="12" y2="8" />
    <line x1="12" y1="16" x2="12" y2="21" />
    <rect x="6" y="8" width="12" height="8" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </>,
);

// wait — a full circle crossed by a horizon line (the moon holding on the horizon)
export const IconWait = svg(
  <>
    <circle cx="12" cy="12" r="8" />
    <line x1="4" y1="12" x2="20" y2="12" />
  </>,
);

// approval — a gate/decision: a diamond reticle with a center tick
export const IconApproval = svg(
  <>
    <path d="M12 4 L20 12 L12 20 L4 12 Z" />
    <line x1="12" y1="9" x2="12" y2="15" />
  </>,
);

// start — a waxing arc, the night's work beginning
export const IconStart = svg(<path d="M9 4 a8 8 0 0 1 0 16 a5.5 5.5 0 0 0 0 -16 Z" fill="currentColor" stroke="none" />);

// end — a terminus mark: a filled square set on the meridian
export const IconEnd = svg(<rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none" />);

// run — begin: a waxing moon
export const IconRun = svg(<path d="M9 4 a8 8 0 0 1 0 16 a5.5 5.5 0 0 0 0 -16 Z" fill="currentColor" stroke="none" />);

// import — a mark crossing below the horizon into the register
export const IconImport = svg(
  <>
    <line x1="12" y1="4" x2="12" y2="14" />
    <path d="M8 10 L12 14 L16 10" />
    <line x1="5" y1="19" x2="19" y2="19" />
  </>,
);

// export — a mark rising above the horizon
export const IconExport = svg(
  <>
    <line x1="12" y1="20" x2="12" y2="10" />
    <path d="M8 14 L12 10 L16 14" />
    <line x1="5" y1="5" x2="19" y2="5" />
  </>,
);

// save — the moon setting below the horizon (state persisted below the line)
export const IconSave = svg(
  <>
    <line x1="4" y1="14" x2="20" y2="14" />
    <path d="M6 14 a6 6 0 0 1 12 0" fill="currentColor" stroke="none" opacity="0.5" />
    <path d="M6 14 a6 6 0 0 1 12 0" />
  </>,
);

// remove — occlude to new moon: a ring with a strike
export const IconTrash = svg(
  <>
    <circle cx="12" cy="12" r="8" />
    <line x1="7" y1="12" x2="17" y2="12" />
  </>,
);

export const IconUndo = svg(
  <>
    <path d="M9 7 L4 12 L9 17" />
    <path d="M4 12 H14 a5 5 0 0 1 0 10 H11" />
  </>,
);
export const IconRedo = svg(
  <>
    <path d="M15 7 L20 12 L15 17" />
    <path d="M20 12 H10 a5 5 0 0 0 0 10 H13" />
  </>,
);
export const IconClose = svg(
  <>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </>,
);
export const IconMinus = svg(<line x1="5" y1="12" x2="19" y2="12" />);
export const IconPlus = svg(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
);
// retrace — looking back over the night's trail: a counter-clockwise dial returning to a node
export const IconRetrace = svg(
  <>
    <path d="M5 12 a7 7 0 1 1 2.2 5" />
    <path d="M5 7.5 V12 H9.5" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </>,
);
// template glyphs
export const IconWrench = svg(<path d="M15 4 a4 4 0 0 0 -5 5 L4 15 l3 3 l6-6 a4 4 0 0 0 5-5 l-3 3 l-2-2 Z" />);
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="6" />
    <line x1="15.5" y1="15.5" x2="20" y2="20" />
  </>,
);
export const IconShield = svg(<path d="M12 3 L19 6 V11 a9 9 0 0 1 -7 9 a9 9 0 0 1 -7 -9 V6 Z" />);
export const IconBeaker = svg(
  <>
    <path d="M9 3 v6 L4 19 a1 1 0 0 0 1 1 h14 a1 1 0 0 0 1 -1 L15 9 V3" />
    <line x1="8" y1="3" x2="16" y2="3" />
    <line x1="7" y1="14" x2="17" y2="14" />
  </>,
);
