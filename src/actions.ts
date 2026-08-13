// Single-dispatch guard for app actions.
//
// Every command reaches the controller through two doors: the native menu
// (which emits a `menu` event) and the in-webview keydown handler. Once the menu
// items carry **real accelerators** — which is what makes Windows render
// "Ctrl+S" right-aligned in grey instead of jamming it into the label — one
// physical keypress can come through both at once, and "Save As" opens two
// dialogs.
//
// `menu.rs` used to avoid this by shipping no accelerators at all. That fixed
// the double-fire by giving up the platform's shortcut display.
//
// The alternative is to keep both doors and make a repeat impossible: route
// every action through one dispatcher that ignores the same action arriving
// twice inside a very short window. Simultaneous deliveries collapse to one; a
// human pressing the same shortcut twice is hundreds of milliseconds apart and
// still gets two actions.
//
// Pure and injectable, so the behaviour is gated headlessly (§8) rather than
// discovered on a device.

/**
 * Window inside which a repeat of the same action is treated as the same
 * physical event. The two deliveries of one keypress land in the same event-loop
 * turn (sub-millisecond); the fastest deliberate double-press is >150ms.
 */
export const DEDUPE_MS = 80;

export class ActionDispatcher {
  private readonly last = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Run `fn` unless this action already ran within {@link DEDUPE_MS}.
   * Returns whether it ran, which is what the tests assert on.
   */
  dispatch(action: string, fn: () => void): boolean {
    const at = this.now();
    const previous = this.last.get(action);
    if (previous !== undefined && at - previous < DEDUPE_MS) return false;
    this.last.set(action, at);
    fn();
    return true;
  }
}
