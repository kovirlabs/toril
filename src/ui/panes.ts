// Pane layout state — pure, no DOM and no IPC (the `sync.ts` / `paths.ts` pattern).
//
// The workspace is three grid columns: sidebar | main | rail. The rail is a
// *tabbed* container — Outline and History are alternatives, never simultaneous
// — so chrome is bounded at one rail width regardless of how many panels exist.
// That bound is the whole point: two independent rails cost 460px, which leaves
// a 1280px-wide window less than the editor's 720px measure.
//
// Everything here is a value transform, so the interesting behaviour (toggle
// semantics, restore clamping, legacy migration) is gated headlessly in
// `tests/panes.test.ts` and only the DOM glue needs a running window (§8).

import type { Settings } from "../ipc";

/** Which panel the single right-hand rail is currently showing. */
export type RailTab = "outline" | "history";

/**
 * Pane state.
 *
 * `sidebarWidth` / `railWidth` are the widths the user *chose*, not the widths
 * currently on screen. What fits is derived per render by {@link effectiveWidths}
 * against the live viewport.
 *
 * Keeping those separate is load-bearing. When they were one field, narrowing
 * the window shrank the stored value, widening it again never restored it, and
 * the next session save wrote the shrunken number over the user's preference —
 * so a moment at a small window size permanently destroyed their layout.
 */
export interface PaneState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  railVisible: boolean;
  railWidth: number;
  railTab: RailTab;
}

/**
 * Width bounds per pane. `max` is an upper bound on the *preference*; the
 * viewport clamp in {@link clampWidth} applies on top of it, so a width saved
 * on a 4K monitor cannot swallow a Surface Pro's window.
 */
export const PANE_LIMITS = {
  sidebar: { min: 160, max: 480, preferred: 240 },
  rail: { min: 180, max: 420, preferred: 260 },
} as const;

/** Share of the viewport a single pane may never exceed, however it was saved. */
const MAX_VIEWPORT_SHARE = 0.4;

/**
 * Width the editor column must keep. Below roughly this, the writing surface
 * stops being one — and the entire point of the tabbed rail was to stop chrome
 * from eating the measure.
 *
 * This is a *combined* bound, and it is not implied by the per-pane clamp above:
 * two panes can each honour the 40% rule and still take 70% of the window
 * between them.
 */
const MIN_MAIN_WIDTH = 480;

export function defaultPaneState(): PaneState {
  return {
    sidebarVisible: true,
    sidebarWidth: PANE_LIMITS.sidebar.preferred,
    railVisible: true,
    railWidth: PANE_LIMITS.rail.preferred,
    railTab: "outline",
  };
}

/**
 * Clamp a width to its pane's bounds and to a share of the viewport.
 *
 * A non-finite width (corrupt settings, a NaN from a bad drag) falls back to the
 * preferred width rather than propagating NaN into a grid template, where it
 * would silently collapse the column.
 */
export function clampWidth(
  width: number,
  limits: { min: number; max: number; preferred: number },
  viewportWidth: number,
  /** Space already spoken for by the sibling pane, during a live drag. */
  reserved = 0,
): number {
  if (!Number.isFinite(width)) return limits.preferred;
  const viewportCap = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth * MAX_VIEWPORT_SHARE)
    : limits.max;
  const mainCap = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth - reserved - MIN_MAIN_WIDTH)
    : limits.max;
  // Both caps can fall below `min` on a very narrow window; the pane's own
  // minimum wins there, because a 60px sidebar is worse than a tight one.
  const upper = Math.max(limits.min, Math.min(limits.max, viewportCap, mainCap));
  return Math.round(Math.min(upper, Math.max(limits.min, width)));
}

/**
 * The widths to actually render, given the window we have right now.
 *
 * Derived, never stored. Two panes can each honour the 40%-of-viewport clamp and
 * still take 70% of the window between them, so the combined budget is enforced
 * here by shrinking both proportionally — and because this is recomputed every
 * render, widening the window restores the user's chosen widths automatically.
 */
export function effectiveWidths(
  state: PaneState,
  viewportWidth: number,
): { sidebar: number; rail: number } {
  const sidebar = clampWidth(state.sidebarWidth, PANE_LIMITS.sidebar, viewportWidth);
  const rail = clampWidth(state.railWidth, PANE_LIMITS.rail, viewportWidth);
  if (!Number.isFinite(viewportWidth)) return { sidebar, rail };

  const onScreen = (state.sidebarVisible ? sidebar : 0) + (state.railVisible ? rail : 0);
  const budget = viewportWidth - MIN_MAIN_WIDTH;
  if (onScreen <= budget || onScreen === 0) return { sidebar, rail };

  const scale = budget / onScreen;
  return {
    sidebar: state.sidebarVisible
      ? Math.max(PANE_LIMITS.sidebar.min, Math.round(sidebar * scale))
      : sidebar,
    rail: state.railVisible ? Math.max(PANE_LIMITS.rail.min, Math.round(rail * scale)) : rail,
  };
}

/** Collapse/expand the sidebar. Width is preserved across the toggle. */
export function toggleSidebar(state: PaneState): PaneState {
  return { ...state, sidebarVisible: !state.sidebarVisible };
}

/**
 * Activate a rail tab. The three cases are what makes the tabbed rail feel like
 * the two independent toggles it replaces:
 *
 * - rail closed            → open it on `tab`
 * - rail open, other tab   → switch to `tab` (chrome width does not change)
 * - rail open, same tab    → close it (so ≡ still reads as a toggle)
 */
export function selectRailTab(state: PaneState, tab: RailTab): PaneState {
  if (!state.railVisible) return { ...state, railVisible: true, railTab: tab };
  if (state.railTab !== tab) return { ...state, railTab: tab };
  return { ...state, railVisible: false };
}

/** Close the rail without changing which tab it will reopen on. */
export function hideRail(state: PaneState): PaneState {
  return { ...state, railVisible: false };
}

export function setSidebarWidth(state: PaneState, width: number, viewportWidth: number): PaneState {
  const reserved = state.railVisible ? state.railWidth : 0;
  return {
    ...state,
    sidebarWidth: clampWidth(width, PANE_LIMITS.sidebar, viewportWidth, reserved),
  };
}

export function setRailWidth(state: PaneState, width: number, viewportWidth: number): PaneState {
  const reserved = state.sidebarVisible ? state.sidebarWidth : 0;
  return { ...state, railWidth: clampWidth(width, PANE_LIMITS.rail, viewportWidth, reserved) };
}

/**
 * Rebuild pane state from persisted settings.
 *
 * Handles the migration from the two-rail era: `outline_visible` and
 * `history_visible` were independent booleans, and both could be true. There is
 * no honest way to preserve "both open" in a tabbed rail, so the tie resolves to
 * Outline — deterministic, and documented in the design rather than left to
 * whichever branch happened to run last.
 */
export function restorePaneState(settings: Settings, viewportWidth: number): PaneState {
  const base = defaultPaneState();

  const sidebarVisible = settings.sidebar_visible ?? base.sidebarVisible;
  const sidebarWidth = clampWidth(
    settings.sidebar_width ?? base.sidebarWidth,
    PANE_LIMITS.sidebar,
    viewportWidth,
  );
  const railWidth = clampWidth(
    settings.rail_width ?? base.railWidth,
    PANE_LIMITS.rail,
    viewportWidth,
  );

  // Prefer the new fields; fall back to the legacy pair only when the rail has
  // never been persisted, so a post-migration "rail closed" is not overridden by
  // a stale `outline_visible: true` that no longer gets written.
  if (settings.rail_visible !== null && settings.rail_visible !== undefined) {
    return {
      sidebarVisible,
      sidebarWidth,
      railVisible: settings.rail_visible,
      railWidth,
      railTab: settings.rail_tab === "history" ? "history" : "outline",
    };
  }

  const legacyOutline = settings.outline_visible ?? true;
  const legacyHistory = settings.history_visible ?? false;
  return {
    sidebarVisible,
    sidebarWidth,
    railVisible: legacyOutline || legacyHistory,
    railWidth,
    railTab: legacyOutline ? "outline" : legacyHistory ? "history" : "outline",
  };
}

/**
 * The persisted projection of pane state. Legacy `outline_visible` /
 * `history_visible` are deliberately **not** written back: they are read once at
 * migration and then go stale, which is what lets the fallback above stay
 * one-directional.
 */
export function toSettingsPatch(
  state: PaneState,
): Pick<
  Settings,
  "sidebar_visible" | "sidebar_width" | "rail_visible" | "rail_width" | "rail_tab"
> {
  return {
    sidebar_visible: state.sidebarVisible,
    sidebar_width: state.sidebarWidth,
    rail_visible: state.railVisible,
    rail_width: state.railWidth,
    rail_tab: state.railTab,
  };
}

/**
 * The CSS custom properties the grid reads, for the current viewport.
 *
 * A hidden pane still reports a width: collapsing zeroes the pane's own width in
 * CSS, so the variable survives to animate back out on expand.
 */
export function paneCssVars(state: PaneState, viewportWidth: number): Record<string, string> {
  const { sidebar, rail } = effectiveWidths(state, viewportWidth);
  return {
    "--sidebar-w": `${sidebar}px`,
    "--rail-w": `${rail}px`,
  };
}
