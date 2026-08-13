// The right-hand rail: one container, two alternative panels.
//
// Outline and History used to be independent grid columns, so both open cost
// 460px of chrome — more than a 1280px window can spare against a 720px measure.
// As a tabbed rail the cost is bounded at one width no matter how many panels
// exist later (search, AI), and each new panel is a tab rather than a column.
//
// This module owns *which panel is showing*. The panels own their own content —
// `outline.ts` and `history.ts` are untouched by this change; they still render
// into the same `#outline` / `#history` elements they always did.

import type { RailTab } from "./panes";

export interface RailCallbacks {
  /** A tab was chosen. The controller decides what that means for pane state. */
  onSelect(tab: RailTab): void;
}

export class Rail {
  private readonly tabs: HTMLButtonElement[];

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: RailCallbacks,
  ) {
    this.tabs = [...container.querySelectorAll<HTMLButtonElement>(".rail-tab")];
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        if (name === "outline" || name === "history") this.cb.onSelect(name);
      });
    }
    // Arrow keys move between tabs, which is what `role="tablist"` promises to
    // anyone navigating by keyboard.
    container.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const current = this.tabs.findIndex((t) => t === document.activeElement);
    if (current === -1) return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = this.tabs[(current + delta + this.tabs.length) % this.tabs.length];
    next?.focus();
    const name = next?.dataset.tab;
    if (name === "outline" || name === "history") this.cb.onSelect(name);
  }

  /**
   * Show one panel and hide the other.
   *
   * Panels are hidden with the `hidden` attribute rather than being detached, so
   * each keeps its scroll position and its DOM across a switch — re-rendering
   * the outline every time the tab changed would lose the reader's place.
   */
  setActive(tab: RailTab): void {
    for (const el of this.tabs) {
      const isActive = el.dataset.tab === tab;
      el.setAttribute("aria-selected", String(isActive));
      // Only the selected tab is a tab stop; arrow keys move within the set.
      el.tabIndex = isActive ? 0 : -1;
    }
    for (const panel of this.container.querySelectorAll<HTMLElement>(".rail-panel")) {
      panel.hidden = panel.id !== tab;
    }
  }

  /**
   * Mark a tab as unavailable — the history panel has nothing to show for a
   * document that has never been saved. Disabled rather than removed: a tab that
   * disappears makes the remaining ones move under the pointer.
   */
  setEnabled(tab: RailTab, enabled: boolean, reason?: string): void {
    const el = this.tabs.find((t) => t.dataset.tab === tab);
    if (!el) return;
    el.disabled = !enabled;
    if (!enabled && reason) el.title = reason;
    else el.removeAttribute("title");
  }
}
