// GATE for the menu/keyboard double-fire guard (feat/chrome-ux).
//
// menu.rs now registers real accelerators, so one Ctrl+S can arrive twice: once
// from the native menu and once from the webview keydown handler. Without this
// guard, "Save As" opens two dialogs. The rule: simultaneous deliveries of one
// action collapse to one; deliberate repeats still get through.
import { describe, expect, it } from "vitest";
import { ActionDispatcher, DEDUPE_MS } from "../src/actions";

/** A clock we drive by hand, so the tests carry no real time. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ActionDispatcher", () => {
  it("runs an action the first time", () => {
    let ran = 0;
    const d = new ActionDispatcher(fakeClock().now);
    expect(d.dispatch("save", () => ran++)).toBe(true);
    expect(ran).toBe(1);
  });

  it("collapses the menu + keydown pair from a single keypress", () => {
    let ran = 0;
    const clock = fakeClock();
    const d = new ActionDispatcher(clock.now);
    // Both doors deliver in the same event-loop turn: no time passes.
    d.dispatch("save_as", () => ran++);
    d.dispatch("save_as", () => ran++);
    expect(ran).toBe(1);
  });

  it("still allows a deliberate repeat once the window has passed", () => {
    let ran = 0;
    const clock = fakeClock();
    const d = new ActionDispatcher(clock.now);
    d.dispatch("save", () => ran++);
    clock.advance(DEDUPE_MS + 1);
    d.dispatch("save", () => ran++);
    expect(ran).toBe(2);
  });

  it("does not let one action suppress a different one", () => {
    const ran: string[] = [];
    const d = new ActionDispatcher(fakeClock().now);
    d.dispatch("save", () => ran.push("save"));
    d.dispatch("new", () => ran.push("new"));
    d.dispatch("open", () => ran.push("open"));
    expect(ran).toEqual(["save", "new", "open"]);
  });

  it("reports the suppression rather than failing silently", () => {
    const clock = fakeClock();
    const d = new ActionDispatcher(clock.now);
    d.dispatch("save", () => {});
    expect(d.dispatch("save", () => {})).toBe(false);
  });

  it("holds the guard open for exactly the window, not a moving target", () => {
    let ran = 0;
    const clock = fakeClock();
    const d = new ActionDispatcher(clock.now);
    d.dispatch("save", () => ran++);
    // A burst of repeats inside the window must not keep pushing the deadline
    // out — otherwise a key held down would never fire again.
    for (let i = 0; i < 5; i++) {
      clock.advance(DEDUPE_MS - 1);
      d.dispatch("save", () => ran++);
    }
    expect(ran).toBeGreaterThan(1);
  });
});
