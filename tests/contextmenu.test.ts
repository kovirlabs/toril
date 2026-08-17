// Context-menu gate (CLAUDE.md §8, ROADMAP Movement II.12).
//
// The menu is the entry point to every destructive file operation, so what is
// pinned here is the behaviour that decides whether the *right* action runs:
// only one menu at a time, dismissal actually removing its document listeners,
// and the menu closing before its handler runs (the handlers open an inline
// field and take focus).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeContextMenu,
  isContextMenuOpen,
  openContextMenu,
  type MenuEntry,
} from "../src/ui/contextmenu";

afterEach(() => {
  closeContextMenu();
  document.body.replaceChildren();
});

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu-item"));
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function open(entries: MenuEntry[]): void {
  openContextMenu({ x: 10, y: 10, entries });
}

describe("openContextMenu", () => {
  it("renders one row per item and skips separators as choices", () => {
    open([
      { label: "Open", onSelect: () => {} },
      "separator",
      { label: "Delete", onSelect: () => {}, danger: true },
    ]);

    expect(items().map((b) => b.textContent)).toEqual(["Open", "Delete"]);
    expect(document.querySelectorAll(".context-menu-sep")).toHaveLength(1);
    expect(items()[1].dataset.danger).toBe("true");
  });

  it("opening a second menu replaces the first", () => {
    open([{ label: "A", onSelect: () => {} }]);
    open([{ label: "B", onSelect: () => {} }]);

    expect(document.querySelectorAll(".context-menu")).toHaveLength(1);
    expect(items().map((b) => b.textContent)).toEqual(["B"]);
  });

  it("closes before running the handler, so the handler can take focus", () => {
    let openWhenHandlerRan: boolean | null = null;
    open([{ label: "Rename…", onSelect: () => (openWhenHandlerRan = isContextMenuOpen()) }]);

    items()[0].click();

    expect(openWhenHandlerRan).toBe(false);
    expect(isContextMenuOpen()).toBe(false);
  });

  it("Escape closes without selecting anything", () => {
    const onSelect = vi.fn();
    open([{ label: "Delete", onSelect }]);

    press("Escape");

    expect(isContextMenuOpen()).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a pointer press outside closes it; one inside does not", () => {
    open([{ label: "Open", onSelect: () => {} }]);

    items()[0].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(isContextMenuOpen()).toBe(true);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(isContextMenuOpen()).toBe(false);
  });

  /**
   * The failure this pins is silent: a menu that closes but leaves its
   * document-level listeners attached goes on swallowing the next Escape or
   * click, and nothing about the UI shows why.
   */
  it("stops handling keys once closed", () => {
    const onSelect = vi.fn();
    open([{ label: "Delete", onSelect }]);
    closeContextMenu();

    press("ArrowDown");
    press("Enter");

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("arrow keys move focus and wrap in both directions", () => {
    open([
      { label: "One", onSelect: () => {} },
      { label: "Two", onSelect: () => {} },
      { label: "Three", onSelect: () => {} },
    ]);
    const [one, two, three] = items();

    expect(document.activeElement).toBe(one);
    press("ArrowDown");
    expect(document.activeElement).toBe(two);
    press("ArrowUp");
    expect(document.activeElement).toBe(one);
    press("ArrowUp"); // wraps to the end
    expect(document.activeElement).toBe(three);
    press("ArrowDown"); // wraps to the start
    expect(document.activeElement).toBe(one);
    press("End");
    expect(document.activeElement).toBe(three);
    press("Home");
    expect(document.activeElement).toBe(one);
  });

  it("skips a disabled item in keyboard traversal and cannot select it", () => {
    const onSelect = vi.fn();
    open([
      { label: "Open", onSelect: () => {} },
      { label: "Rename…", onSelect, disabled: true },
      { label: "Delete", onSelect: () => {} },
    ]);

    press("ArrowDown");

    expect((document.activeElement as HTMLElement).textContent).toBe("Delete");
    items()[1].click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("restores focus to whatever opened it", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    open([{ label: "Open", onSelect: () => {} }]);
    expect(document.activeElement).not.toBe(trigger);

    press("Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("does not yank focus back when dismissed by a click elsewhere", () => {
    const trigger = document.createElement("button");
    const other = document.createElement("input");
    document.body.append(trigger, other);
    trigger.focus();

    open([{ label: "Open", onSelect: () => {} }]);
    other.focus();
    other.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

    expect(document.activeElement).toBe(other);
  });

  /**
   * Regression: the dismiss-on-window-blur listener was registered with
   * `capture: true`, and a capturing window listener sees every *element's*
   * blur too — so opening a menu while anything was focused closed it again
   * the instant it focused its own first item.
   */
  it("survives opening while another element has focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    open([{ label: "Open", onSelect: () => {} }]);

    expect(isContextMenuOpen()).toBe(true);
    expect(items()).toHaveLength(1);
  });

  it("keeps a negative anchor on screen", () => {
    openContextMenu({ x: -50, y: -20, entries: [{ label: "Open", onSelect: () => {} }] });
    const menu = document.querySelector<HTMLElement>(".context-menu");

    expect(menu?.style.left).toBe("0px");
    expect(menu?.style.top).toBe("0px");
  });
});
