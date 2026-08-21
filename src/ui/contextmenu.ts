// A small in-app context menu (ROADMAP Movement II.12, `feat/sidebar-file-ops`).
//
// **Why not a native menu.** `menu.rs` can build one, and the app menu already
// does — but a native popup cannot be driven by the headless gates, and native
// dialogs are the one thing documented to hang the app on the Linux dev box
// (`docs/ON-DEVICE-VERIFICATION.md`). A DOM menu is testable in jsdom, renders
// identically in both webview engines, and keeps the file operations reachable
// on the box where they are actually developed.
//
// Exactly one menu exists at a time: opening a second closes the first. That is
// enforced here rather than by callers, because a stray menu left behind would
// keep a document-level dismiss listener alive and swallow the next click.

/** A selectable row. `danger` styles a destructive action (delete). */
export interface MenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  /** Rendered but unselectable, with the reason as its tooltip. */
  disabled?: boolean;
  title?: string;
}

/** A rule between groups. Never focusable — it is decoration, not a row. */
export type MenuEntry = MenuItem | "separator";

export interface ContextMenuOptions {
  /** Viewport coordinates, normally from the triggering pointer event. */
  x: number;
  y: number;
  entries: MenuEntry[];
  /** Where to mount. Defaults to `document.body`. */
  host?: HTMLElement;
}

let openMenu: HTMLElement | null = null;
let dismiss: (() => void) | null = null;
/**
 * Where focus was before the menu opened.
 *
 * Restored on close, and it matters more here than in most menus: the sidebar
 * row that opened this is the thing a keyboard user was navigating, and
 * dropping focus to `<body>` would send them back to the top of the document
 * every time they pressed Escape.
 */
let returnFocusTo: HTMLElement | null = null;

/** Close any open context menu. Safe to call when none is open. */
export function closeContextMenu(): void {
  dismiss?.();
}

function isItem(entry: MenuEntry): entry is MenuItem {
  return entry !== "separator";
}

/**
 * Open a context menu at `(x, y)`.
 *
 * Selecting an item closes the menu **before** running its handler: handlers
 * open inline editors and move focus, and a menu still on screen would fight
 * them for it.
 */
export function openContextMenu(opts: ContextMenuOptions): void {
  closeContextMenu();

  const host = opts.host ?? document.body;
  const active = document.activeElement;
  returnFocusTo = active instanceof HTMLElement ? active : null;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${Math.max(0, opts.x)}px`;
  menu.style.top = `${Math.max(0, opts.y)}px`;

  const buttons: HTMLButtonElement[] = [];
  for (const entry of opts.entries) {
    if (!isItem(entry)) {
      const rule = document.createElement("div");
      rule.className = "context-menu-sep";
      // Decorative: exposing it as a menu row would make screen readers count
      // separators among the choices.
      rule.setAttribute("role", "none");
      menu.append(rule);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = entry.label;
    if (entry.danger) btn.dataset.danger = "true";
    if (entry.title) btn.title = entry.title;
    if (entry.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        close();
        entry.onSelect();
      });
      buttons.push(btn);
    }
    menu.append(btn);
  }

  function close(restoreFocus = true): void {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onDismissEvent);
    window.removeEventListener("blur", onDismissEvent);
    menu.remove();
    if (openMenu === menu) {
      openMenu = null;
      dismiss = null;
    }
    // Only when the menu still owned focus. A pointer dismiss has already moved
    // focus somewhere the user chose, and yanking it back would undo that.
    if (restoreFocus && returnFocusTo?.isConnected) returnFocusTo.focus();
    returnFocusTo = null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    close(false);
  }

  function onDismissEvent(): void {
    close(false);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // Tab out of a menu means "I'm done here" everywhere else; closing without
    // swallowing the key lets focus move on naturally.
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (buttons.length === 0) return;

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % buttons.length;
    else if (e.key === "ArrowUp")
      next = current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;

    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      buttons[next]?.focus();
    }
  }

  host.append(menu);
  openMenu = menu;
  dismiss = () => close();

  // Keep the menu on screen. Measured after mounting because the width is not
  // known until the labels are laid out; `getBoundingClientRect` reports zeroes
  // under jsdom, and the clamp is written to be a no-op in that case rather
  // than to produce a negative offset.
  const rect = menu.getBoundingClientRect();
  if (rect.width > 0 && opts.x + rect.width > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
  }
  if (rect.height > 0 && opts.y + rect.height > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height)}px`;
  }

  // Capture phase on the document pair: the sidebar, the editor and the global
  // keymap all listen at the document level, and an open menu must take the key
  // or the click before they act on it.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  // **Not** capture on the window pair, and `blur` is why. `blur` does not
  // bubble, but a capturing window listener still sees every element's blur on
  // the way down — so the menu would dismiss itself the instant it focused its
  // own first item, taking whatever the user was about to click with it. Without
  // capture this is what it reads as: the *window* losing focus.
  window.addEventListener("resize", onDismissEvent);
  window.addEventListener("blur", onDismissEvent);

  buttons[0]?.focus();
}

/** Whether a context menu is currently open (for tests and guards). */
export function isContextMenuOpen(): boolean {
  return openMenu !== null;
}
