// Editor zoom (ROADMAP Movement I.5, was §13 backlog).
//
// Scales the *writing surface* only — not the chrome. Zooming the whole app is
// what the OS display scaling already does; what a writer actually wants at
// 11pm is bigger prose without a bigger tab bar eating the window. That is also
// why this lives here rather than reaching for the webview's own zoom.
//
// Pure, and expressed as a multiplier rather than a font size, so the caller
// decides what it multiplies. The measure scales with it (`45em`, not `45rem`,
// in editor.css), which keeps characters-per-line roughly constant instead of
// letting a zoomed-in line run to eighteen words.

/** Multipliers, ascending. A fixed ladder, not a free-form number. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** The multiplier `Ctrl+0` returns to, and the one a fresh install starts at. */
export const ZOOM_DEFAULT = 1;

/**
 * A discrete ladder rather than "multiply by 1.1 each time" on purpose. Free
 * scaling accumulates float drift, so a user who zooms in five times and out
 * five times does not land back where they started — and "reset" then quietly
 * means something different from "the size I had". A fixed ladder is also
 * closed under round-tripping through JSON, which matters because it persists.
 */
function indexOfNearest(zoom: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[best] - zoom)) best = i;
  }
  return best;
}

/** The next step up, or the current one if already at the top. */
export function zoomIn(current: number): number {
  const i = indexOfNearest(current);
  return ZOOM_STEPS[Math.min(i + 1, ZOOM_STEPS.length - 1)];
}

/** The next step down, or the current one if already at the bottom. */
export function zoomOut(current: number): number {
  const i = indexOfNearest(current);
  return ZOOM_STEPS[Math.max(i - 1, 0)];
}

/**
 * Coerce a persisted value onto the ladder.
 *
 * Settings are a JSON file a user can edit, and a corrupt or hand-written value
 * must not be able to render the editor unreadable — a stored `0` would collapse
 * the prose to nothing with no way to zoom back out, since every step from zero
 * is still zero. Anything unusable snaps to the default rather than being
 * clamped to the nearest end: a nonsense value carries no intent to honour.
 */
export function normalizeZoom(value: number | null | undefined): number {
  if (value === null || value === undefined) return ZOOM_DEFAULT;
  if (!Number.isFinite(value) || value <= 0) return ZOOM_DEFAULT;
  return ZOOM_STEPS[indexOfNearest(value)];
}

/** How the zoom reads in the status line — "100%", "125%". */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
