// GATE for pane layout state (feat/chrome-ux).
//
// The rules this file protects:
//
//   1. the tabbed rail still *feels* like the two toggles it replaced —
//      opening, switching, and closing are all reachable from one control;
//   2. a persisted width can never make a pane unusable on a smaller screen
//      than the one it was saved on;
//   3. the migration off the two-rail era is deterministic and one-directional.
//
// Rule 2 is the one with teeth: the old layout had fixed widths, so restoring a
// session could not break geometry. Now it can.
import { describe, expect, it } from "vitest";
import {
  PANE_LIMITS,
  clampWidth,
  defaultPaneState,
  effectiveWidths,
  hideRail,
  paneCssVars,
  restorePaneState,
  selectRailTab,
  setRailWidth,
  setSidebarWidth,
  toSettingsPatch,
  toggleSidebar,
} from "../src/ui/panes";
import type { Settings } from "../src/ipc";

/** A settings object with everything null — i.e. a first run. */
const emptySettings = (over: Partial<Settings> = {}): Settings => ({
  version: 1,
  last_folder: null,
  open_files: [],
  active_file: null,
  theme: null,
  sidebar_visible: null,
  sidebar_width: null,
  rail_visible: null,
  rail_width: null,
  rail_tab: null,
  outline_visible: null,
  history_visible: null,
  autosave: null,
  autosave_debounce_ms: null,
  ...over,
});

const WIDE = 1920;

describe("selectRailTab", () => {
  it("opens the rail on the requested tab when it is closed", () => {
    const closed = hideRail(defaultPaneState());
    const next = selectRailTab(closed, "history");
    expect(next.railVisible).toBe(true);
    expect(next.railTab).toBe("history");
  });

  it("switches tabs without changing chrome width", () => {
    const onOutline = defaultPaneState();
    const next = selectRailTab(onOutline, "history");
    expect(next.railVisible).toBe(true);
    expect(next.railTab).toBe("history");
    expect(next.railWidth).toBe(onOutline.railWidth);
  });

  it("closes the rail when the active tab is re-selected, so the control still toggles", () => {
    const onOutline = defaultPaneState();
    expect(selectRailTab(onOutline, "outline").railVisible).toBe(false);
  });

  it("reopens on the tab it was closed from", () => {
    const state = selectRailTab(selectRailTab(defaultPaneState(), "history"), "history");
    expect(state.railVisible).toBe(false);
    expect(selectRailTab(state, "history")).toMatchObject({
      railVisible: true,
      railTab: "history",
    });
  });
});

describe("toggleSidebar", () => {
  it("preserves width across a collapse/expand cycle (so it animates back out)", () => {
    const sized = setSidebarWidth(defaultPaneState(), 300, WIDE);
    const roundTrip = toggleSidebar(toggleSidebar(sized));
    expect(roundTrip.sidebarWidth).toBe(300);
    expect(roundTrip.sidebarVisible).toBe(true);
  });
});

describe("clampWidth", () => {
  it("holds a width inside the pane's own bounds", () => {
    expect(clampWidth(10_000, PANE_LIMITS.sidebar, WIDE)).toBe(PANE_LIMITS.sidebar.max);
    expect(clampWidth(0, PANE_LIMITS.sidebar, WIDE)).toBe(PANE_LIMITS.sidebar.min);
  });

  it("never lets one pane exceed 40% of the viewport", () => {
    // 480px preference on an 800px window would be 60% of the screen.
    expect(clampWidth(480, PANE_LIMITS.sidebar, 800)).toBe(320);
  });

  it("lets the pane minimum win on a viewport too narrow for the 40% rule", () => {
    // 40% of 300px is 120px — narrower than any usable sidebar.
    expect(clampWidth(240, PANE_LIMITS.sidebar, 300)).toBe(PANE_LIMITS.sidebar.min);
  });

  it("falls back to the preferred width rather than propagating NaN into the grid", () => {
    expect(clampWidth(Number.NaN, PANE_LIMITS.rail, WIDE)).toBe(PANE_LIMITS.rail.preferred);
    expect(clampWidth(Number.POSITIVE_INFINITY, PANE_LIMITS.rail, WIDE)).toBe(
      PANE_LIMITS.rail.preferred,
    );
  });
});

describe("restorePaneState", () => {
  it("returns defaults on a first run", () => {
    expect(restorePaneState(emptySettings(), WIDE)).toEqual(defaultPaneState());
  });

  it("renders a width saved on a larger monitor down to what fits", () => {
    // 460px rail saved on a 4K screen, restored into a 1280px Surface Pro window.
    const state = restorePaneState(emptySettings({ rail_width: 460 }), 1280);
    const { rail } = effectiveWidths(state, 1280);
    expect(rail).toBeLessThanOrEqual(PANE_LIMITS.rail.max);
    expect(rail).toBeLessThanOrEqual(Math.floor(1280 * 0.4));
  });

  it("leaves the editor a usable measure with both panes restored at maximum", () => {
    const state = restorePaneState(emptySettings({ sidebar_width: 9999, rail_width: 9999 }), 1280);
    const { sidebar, rail } = effectiveWidths(state, 1280);
    expect(1280 - (sidebar + rail)).toBeGreaterThan(400);
  });

  it("prefers the new fields over the legacy pair", () => {
    const state = restorePaneState(
      emptySettings({ rail_visible: false, rail_tab: "history", outline_visible: true }),
      WIDE,
    );
    expect(state.railVisible).toBe(false);
    expect(state.railTab).toBe("history");
  });

  it("treats an unknown rail_tab as outline rather than trusting the file", () => {
    const state = restorePaneState(
      emptySettings({ rail_visible: true, rail_tab: "wat" }),
      WIDE,
    );
    expect(state.railTab).toBe("outline");
  });
});

describe("restorePaneState — migration off the two-rail era", () => {
  it("opens the rail when either legacy panel was visible", () => {
    expect(
      restorePaneState(emptySettings({ outline_visible: false, history_visible: true }), WIDE),
    ).toMatchObject({ railVisible: true, railTab: "history" });
  });

  it("closes the rail when neither legacy panel was visible", () => {
    expect(
      restorePaneState(emptySettings({ outline_visible: false, history_visible: false }), WIDE),
    ).toMatchObject({ railVisible: false });
  });

  it("resolves the both-open tie to outline, deterministically", () => {
    expect(
      restorePaneState(emptySettings({ outline_visible: true, history_visible: true }), WIDE),
    ).toMatchObject({ railVisible: true, railTab: "outline" });
  });

  it("does not write the legacy fields back, so migration cannot run twice", () => {
    const patch = toSettingsPatch(defaultPaneState());
    expect(patch).not.toHaveProperty("outline_visible");
    expect(patch).not.toHaveProperty("history_visible");
  });

  it("survives a save/restore round trip once migrated", () => {
    const migrated = restorePaneState(emptySettings({ history_visible: true }), WIDE);
    const reloaded = restorePaneState(emptySettings(toSettingsPatch(migrated)), WIDE);
    expect(reloaded).toEqual(migrated);
  });
});

describe("paneCssVars", () => {
  it("reports the stored width even while hidden, so expand animates from it", () => {
    const collapsed = toggleSidebar(setSidebarWidth(defaultPaneState(), 300, WIDE));
    expect(collapsed.sidebarVisible).toBe(false);
    expect(paneCssVars(collapsed, WIDE)["--sidebar-w"]).toBe("300px");
  });

  it("emits px units — a bare number would silently invalidate the grid template", () => {
    for (const value of Object.values(paneCssVars(defaultPaneState(), WIDE))) {
      expect(value).toMatch(/^\d+px$/);
    }
  });
});

describe("setRailWidth", () => {
  it("clamps through the same path as restore", () => {
    expect(setRailWidth(defaultPaneState(), 5, WIDE).railWidth).toBe(PANE_LIMITS.rail.min);
  });
});

describe("live drag bounds", () => {
  it("will not let a drag squeeze the editor below its minimum", () => {
    // 1000px window, rail open at 260 → the sidebar cannot pass 1000-260-480.
    const state = defaultPaneState();
    const dragged = setSidebarWidth(state, 900, 1000);
    expect(dragged.sidebarWidth + state.railWidth).toBeLessThanOrEqual(1000 - 480);
  });

  it("gives the dragged pane more room once its sibling is collapsed", () => {
    const withRail = setSidebarWidth(defaultPaneState(), 900, 1000);
    const withoutRail = setSidebarWidth(hideRail(defaultPaneState()), 900, 1000);
    expect(withoutRail.sidebarWidth).toBeGreaterThan(withRail.sidebarWidth);
  });

  it("does not resize the sibling under the pointer during a drag", () => {
    const state = defaultPaneState();
    expect(setSidebarWidth(state, 900, 1000).railWidth).toBe(state.railWidth);
  });
});

describe("effectiveWidths", () => {
  it("renders the chosen widths when they already fit", () => {
    const state = defaultPaneState();
    expect(effectiveWidths(state, WIDE)).toEqual({
      sidebar: state.sidebarWidth,
      rail: state.railWidth,
    });
  });

  it("ignores a collapsed pane when measuring the budget", () => {
    const collapsed = { ...defaultPaneState(), sidebarVisible: false, sidebarWidth: 480 };
    // Only the 260px rail is really on screen, so nothing needs shrinking.
    expect(effectiveWidths(collapsed, 1000).rail).toBe(260);
  });

  it("never shrinks a pane below its own minimum", () => {
    const fat = { ...defaultPaneState(), sidebarWidth: 480, railWidth: 420 };
    const fitted = effectiveWidths(fat, 700);
    expect(fitted.sidebar).toBeGreaterThanOrEqual(PANE_LIMITS.sidebar.min);
    expect(fitted.rail).toBeGreaterThanOrEqual(PANE_LIMITS.rail.min);
  });

  // The regression that motivated splitting chosen width from rendered width.
  it("gives the chosen width back when the window widens again", () => {
    const chosen = { ...defaultPaneState(), sidebarWidth: 300, railWidth: 300 };
    const narrow = effectiveWidths(chosen, 800);
    expect(narrow.sidebar).toBeLessThan(300);
    expect(effectiveWidths(chosen, 1920)).toEqual({ sidebar: 300, rail: 300 });
  });
});

describe("width preference survives a narrow window", () => {
  it("does not edit stored widths when the viewport shrinks", () => {
    const chosen = { ...defaultPaneState(), sidebarWidth: 300, railWidth: 300 };
    // Rendering at any size is a pure read: state is untouched.
    effectiveWidths(chosen, 640);
    expect(chosen.sidebarWidth).toBe(300);
    expect(chosen.railWidth).toBe(300);
  });

  it("persists the chosen width, not the width that happened to fit", () => {
    const chosen = { ...defaultPaneState(), sidebarWidth: 300, railWidth: 300 };
    effectiveWidths(chosen, 640);
    expect(toSettingsPatch(chosen)).toMatchObject({ sidebar_width: 300, rail_width: 300 });
  });
});
