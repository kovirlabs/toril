// GATE for pane drag geometry (feat/chrome-ux).
//
// Two properties worth protecting:
//
//   1. drag direction is correct per edge — a right-hand pane grows as the
//      pointer moves *left*, and inverting that is the classic resizer bug:
//      obvious in a test, invisible in review;
//   2. dragging hard toward the edge closes the pane instead of parking it at
//      the minimum, because a pointer that keeps moving while nothing keeps
//      happening reads as broken.
import { describe, expect, it } from "vitest";
import { COLLAPSE_MARGIN, NUDGE_STEP, nudgeWidth, resolveDrag } from "../src/ui/resizer";
import { PANE_LIMITS } from "../src/ui/panes";

const WIDE = 1920;
const sidebar = PANE_LIMITS.sidebar;
const rail = PANE_LIMITS.rail;

const drag = (over: Partial<Parameters<typeof resolveDrag>[0]> = {}) =>
  resolveDrag({
    edge: "left",
    startWidth: 240,
    deltaX: 0,
    limits: sidebar,
    viewportWidth: WIDE,
    ...over,
  });

describe("resolveDrag — direction", () => {
  it("widens a left-hand pane when the pointer moves right", () => {
    expect(drag({ deltaX: 60 })).toEqual({ kind: "width", width: 300 });
  });

  it("narrows a left-hand pane when the pointer moves left", () => {
    expect(drag({ deltaX: -60 })).toEqual({ kind: "width", width: 180 });
  });

  it("widens a right-hand pane when the pointer moves LEFT", () => {
    expect(drag({ edge: "right", startWidth: 260, limits: rail, deltaX: -60 })).toEqual({
      kind: "width",
      width: 320,
    });
  });

  it("narrows a right-hand pane when the pointer moves right", () => {
    expect(drag({ edge: "right", startWidth: 260, limits: rail, deltaX: 60 })).toEqual({
      kind: "width",
      width: 200,
    });
  });

  it("is a no-op at zero movement", () => {
    expect(drag({ deltaX: 0 })).toEqual({ kind: "width", width: 240 });
  });
});

describe("resolveDrag — collapse", () => {
  it("parks at the minimum for a drag that stops short of the collapse margin", () => {
    const justInside = -(240 - sidebar.min) - (COLLAPSE_MARGIN - 1);
    expect(drag({ deltaX: justInside })).toEqual({ kind: "width", width: sidebar.min });
  });

  it("collapses once the drag passes the margin", () => {
    const justPast = -(240 - sidebar.min) - (COLLAPSE_MARGIN + 1);
    expect(drag({ deltaX: justPast })).toEqual({ kind: "collapse" });
  });

  it("collapses a right-hand pane dragged toward its own edge", () => {
    expect(
      drag({ edge: "right", startWidth: 260, limits: rail, deltaX: 260 }),
    ).toEqual({ kind: "collapse" });
  });

  it("never collapses from an outward drag, however far", () => {
    expect(drag({ deltaX: 5000 })).toEqual({ kind: "width", width: sidebar.max });
  });
});

describe("resolveDrag — bounds", () => {
  it("respects the pane maximum", () => {
    expect(drag({ deltaX: 1000 })).toEqual({ kind: "width", width: sidebar.max });
  });

  it("leaves the editor its minimum, accounting for the opposite pane", () => {
    // 1000px window with a 260px rail open: the sidebar may reach 1000-260-480.
    const out = drag({ deltaX: 1000, viewportWidth: 1000, reserved: 260 });
    expect(out).toEqual({ kind: "width", width: 260 });
  });

  it("gives the same drag more room when the opposite pane is closed", () => {
    const withSibling = drag({ deltaX: 1000, viewportWidth: 1000, reserved: 260 });
    const alone = drag({ deltaX: 1000, viewportWidth: 1000, reserved: 0 });
    expect(alone).toEqual({ kind: "width", width: 400 });
    expect(withSibling).not.toEqual(alone);
  });
});

describe("nudgeWidth", () => {
  it("widens a left-hand pane with ArrowRight", () => {
    expect(nudgeWidth("left", 240, "ArrowRight", sidebar, WIDE)).toBe(240 + NUDGE_STEP);
  });

  it("widens a right-hand pane with ArrowLeft", () => {
    expect(nudgeWidth("right", 260, "ArrowLeft", rail, WIDE)).toBe(260 + NUDGE_STEP);
  });

  it("stops at the minimum instead of collapsing — no one-keystroke surprise", () => {
    let width = sidebar.min;
    for (let i = 0; i < 10; i++) width = nudgeWidth("left", width, "ArrowLeft", sidebar, WIDE);
    expect(width).toBe(sidebar.min);
  });

  it("stops at the maximum", () => {
    let width = sidebar.max;
    for (let i = 0; i < 10; i++) width = nudgeWidth("left", width, "ArrowRight", sidebar, WIDE);
    expect(width).toBe(sidebar.max);
  });
});
