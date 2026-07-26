// The conflict banner (ROADMAP Movement I.4, spec §5.4).
//
// Non-blocking and per-tab, rendered from `tab.diverged`. Never a `confirm()`:
// that cannot represent a background tab, evaporates when dismissed, and gives
// the user one click to destroy unsaved work.
//
// Both actions park the losing side, so no path through this UI discards bytes.

interface ConflictBarCommon {
  name: string;
  message: string;
}

/**
 * The ordinary case: both sides exist, so both choices are real and the park
 * guarantee holds. `actions` defaults to this.
 */
export interface ConflictBarResolveOptions extends ConflictBarCommon {
  actions?: "resolve";
  /** Park theirs; the buffer keeps the original path. */
  onKeepMine(): void;
  /** Park mine; reload theirs into the buffer. */
  onUseTheirs(): void;
}

/**
 * A divergence with nothing to choose between: the file could not be read, so
 * there is no "theirs" to park or load. Renders the message alone — no buttons,
 * and crucially **no park guarantee**, because nothing has been parked and
 * nothing would be. Promising safety we have not delivered is worse than saying
 * nothing: it invites exactly the confident click that loses work.
 *
 * Modelled as a separate variant rather than optional callbacks so the two
 * handlers cannot be passed where they can never fire — or omitted where the
 * buttons would render dead.
 */
export interface ConflictBarNoticeOptions extends ConflictBarCommon {
  actions: "none";
}

export type ConflictBarOptions = ConflictBarResolveOptions | ConflictBarNoticeOptions;

export class ConflictBar {
  private readonly el: HTMLDivElement;
  /**
   * The live region, created **once**.
   *
   * Assistive tech watches a live region for mutations, which means the region
   * has to already exist and be exposed before the text it should announce
   * arrives. A fresh `aria-live` span built inside a still-`hidden` container on
   * every `show()` satisfies neither: content present at creation is not a
   * mutation, and content revealed by unhiding generally is not announced
   * either. So the span outlives every `show()`/`hide()` and only its text
   * changes — and `show()` unhides the container before writing that text.
   */
  private readonly text: HTMLSpanElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "conflict-bar";
    this.el.hidden = true;
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "File changed on disk");

    this.text = document.createElement("span");
    this.text.className = "conflict-bar-text";
    this.text.setAttribute("aria-live", "polite");
    this.el.appendChild(this.text);

    host.appendChild(this.el);
  }

  /** Drop the buttons, keeping the persistent live region (always first) in place. */
  private clearActions(): void {
    while (this.el.lastChild && this.el.lastChild !== this.text) {
      this.el.removeChild(this.el.lastChild);
    }
  }

  show(opts: ConflictBarOptions): void {
    this.clearActions();
    // Unhidden before the text is written, so the mutation lands on a region
    // that is already exposed — see the `text` field's note.
    this.el.hidden = false;

    // Nothing to choose between: message only. No buttons, and no reassurance —
    // there is no other version saved beside anything.
    if (opts.actions === "none") {
      this.el.setAttribute("aria-label", "File could not be read");
      this.text.textContent = `${opts.name} — ${opts.message}.`;
      return;
    }

    this.el.setAttribute("aria-label", "File changed on disk");
    // The reassurance is deliberately visible rather than tooltip-only: a user
    // deciding under pressure needs to know, without hovering, that neither
    // choice throws work away.
    this.text.textContent = `${opts.name} — ${opts.message}. Either way, the other version is saved beside it.`;

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "conflict-bar-btn";
    keep.textContent = "Keep mine";
    keep.title = "Save the disk version alongside as a conflict copy, and keep editing yours";
    keep.addEventListener("click", () => opts.onKeepMine());
    this.el.appendChild(keep);

    const theirs = document.createElement("button");
    theirs.type = "button";
    theirs.className = "conflict-bar-btn";
    theirs.textContent = "Use theirs";
    theirs.title = "Save your version alongside as a conflict copy, and load the disk version";
    theirs.addEventListener("click", () => opts.onUseTheirs());
    this.el.appendChild(theirs);
  }

  hide(): void {
    this.el.hidden = true;
    this.clearActions();
    // Emptied, not removed: the live region has to survive so the next `show()`
    // is a text mutation on an existing region rather than a fresh one.
    this.text.textContent = "";
  }
}
