// GATE for editor zoom (ROADMAP Movement I.5).
//
// The reason this is a module with a test rather than three lines in main.ts is
// the round-trip property below: zoom persists, so a value that drifts or a
// value that comes back corrupt has consequences past the current session. The
// worst case is not cosmetic — a stored zoom of 0 renders the editor unreadable
// *and* unfixable, because every step from zero is still zero.
import { describe, expect, it } from "vitest";
import {
  ZOOM_DEFAULT,
  ZOOM_STEPS,
  formatZoom,
  normalizeZoom,
  zoomIn,
  zoomOut,
} from "../src/zoom";

describe("stepping", () => {
  it("moves one step at a time", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
  });

  it("stops at the ends instead of running off them", () => {
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    const min = ZOOM_STEPS[0];
    expect(zoomIn(max)).toBe(max);
    expect(zoomOut(min)).toBe(min);
  });

  // The property that makes a fixed ladder worth having over `* 1.1`: without
  // it, five in and five out lands somewhere near 1 but not on it, and "reset"
  // silently stops meaning "the size I had".
  it("returns exactly where it started after equal steps in and out", () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 5; i++) z = zoomIn(z);
    for (let i = 0; i < 5; i++) z = zoomOut(z);
    expect(z).toBe(ZOOM_DEFAULT);
  });

  it("walks the whole ladder without skipping or repeating", () => {
    const seen: number[] = [ZOOM_STEPS[0]];
    let z: number = ZOOM_STEPS[0];
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const next = zoomIn(z);
      if (next === z) break;
      seen.push(next);
      z = next;
    }
    expect(seen).toEqual([...ZOOM_STEPS]);
  });
});

describe("normalizeZoom", () => {
  it("keeps a value already on the ladder", () => {
    for (const step of ZOOM_STEPS) expect(normalizeZoom(step)).toBe(step);
  });

  it("defaults when there is nothing stored", () => {
    expect(normalizeZoom(null)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(undefined)).toBe(ZOOM_DEFAULT);
  });

  // The unreadable-and-unfixable case. A clamp to the nearest end would give
  // 0.8 here, which is a guess at intent; a nonsense value carries none.
  it("refuses a zoom that would make the editor unusable", () => {
    expect(normalizeZoom(0)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(-2)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_DEFAULT);
  });

  it("snaps an off-ladder value to the nearest step", () => {
    expect(normalizeZoom(1.12)).toBe(1.1);
    expect(normalizeZoom(1.4)).toBe(1.5);
    // Beyond the top of the ladder is a real intent — pin it to the maximum.
    expect(normalizeZoom(99)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  it("survives a JSON round trip, which is how it is actually stored", () => {
    for (const step of ZOOM_STEPS) {
      const back = JSON.parse(JSON.stringify({ z: step })).z as number;
      expect(normalizeZoom(back)).toBe(step);
    }
  });
});

describe("formatZoom", () => {
  it("reads as a percentage", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(1.25)).toBe("125%");
    expect(formatZoom(0.8)).toBe("80%");
  });
});
