// The conflict banner (ROADMAP Movement I.4, spec §5.4).
//
// Non-blocking and per-tab, rendered from `tab.diverged`. Never a `confirm()`:
// that cannot represent a background tab, evaporates when dismissed, and gives
// the user one click to destroy unsaved work.
//
// Both actions park the losing side, so no path through this UI discards bytes.

export interface ConflictBarOptions {
  name: string;
  message: string;
  /** Park theirs; the buffer keeps the original path. */
  onKeepMine(): void;
  /** Park mine; reload theirs into the buffer. */
  onUseTheirs(): void;
}

export class ConflictBar {
  private readonly el: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "conflict-bar";
    this.el.hidden = true;
    this.el.setAttribute("role", "alert");
    host.appendChild(this.el);
  }

  show(opts: ConflictBarOptions): void {
    this.el.replaceChildren();

    const text = document.createElement("span");
    text.className = "conflict-bar-text";
    text.textContent = `${opts.name} — ${opts.message}`;
    this.el.appendChild(text);

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

    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
    this.el.replaceChildren();
  }
}
