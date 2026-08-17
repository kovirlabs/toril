// The update notice (ROADMAP Movement I.5).
//
// Deliberately *not* shaped like `conflictbar.ts`, and the difference is the
// point. A conflict is about the document in front of you and must be
// impossible to miss, so it takes a row in the layout and pushes the editor
// down. An update is ambient news about the application: it is worth telling you
// and never worth interrupting a sentence for. So this is an out-of-flow toast
// — it reflows nothing, it can be dismissed, and a writer who ignores it loses
// nothing.
//
// That choice also keeps this branch out of `body`'s grid, which currently
// declares rows and no columns (§12b rule 2). Adding a third row there to
// announce a point release is not a trade worth making.
//
// **Nothing here installs anything on its own.** Every transition below is
// driven by a click; see `src/update.ts` for why.

export interface UpdateNoticeOptions {
  version: string;
  /** Release notes from the manifest, when it carries them. */
  notes?: string;
  /** Download and install. The notice goes busy until the caller says otherwise. */
  onInstall(): void;
  /** Don't raise this version again automatically. */
  onSkip(): void;
  /** Close for now; a later launch may raise it again. */
  onDismiss(): void;
}

export class UpdateNotice {
  private readonly el: HTMLDivElement;
  /**
   * The live region, created once and never replaced — same reasoning as
   * `ConflictBar.text`: assistive tech announces *mutations* to a region that is
   * already exposed, so a span built fresh inside a hidden container announces
   * nothing.
   */
  private readonly text: HTMLParagraphElement;
  private readonly actions: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "update-notice";
    this.el.hidden = true;
    // `status`, not `alert`: an available update is not urgent, and `alert`
    // interrupts a screen-reader user mid-word to say so.
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-label", "Software update");

    this.text = document.createElement("p");
    this.text.className = "update-notice-text";
    this.text.setAttribute("aria-live", "polite");
    this.el.appendChild(this.text);

    this.actions = document.createElement("div");
    this.actions.className = "update-notice-actions";
    this.el.appendChild(this.actions);

    host.appendChild(this.el);
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "update-notice-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    this.actions.appendChild(b);
    return b;
  }

  private reset(): void {
    this.actions.replaceChildren();
    this.el.hidden = false; // exposed before the text changes — see `text`
  }

  /** Offer an available update. */
  show(opts: UpdateNoticeOptions): void {
    this.reset();
    // The version is the whole message; notes are supporting detail and are
    // truncated rather than allowed to grow the toast over the editor.
    this.text.textContent = `Toril ${opts.version} is available.`;
    if (opts.notes) {
      const notes = document.createElement("span");
      notes.className = "update-notice-notes";
      notes.textContent = opts.notes.slice(0, 240);
      this.text.appendChild(document.createElement("br"));
      this.text.appendChild(notes);
    }

    this.button("Install", "Download and install this update", opts.onInstall);
    this.button("Skip", "Don't mention this version again", opts.onSkip);
    this.button("Later", "Close — Toril may mention it again next launch", opts.onDismiss);
  }

  /**
   * Installing. No buttons: the only actions available were Install (now
   * running) and dismissals that would strand a half-written binary behind a
   * closed toast.
   */
  busy(message: string): void {
    this.reset();
    this.text.textContent = message;
  }

  /** Installed — offer the restart, which is the user's call, not ours. */
  installed(onRestart: () => void, onLater: () => void): void {
    this.reset();
    this.text.textContent = "Update installed. Restart to finish.";
    this.button("Restart now", "Close Toril and reopen on the new version", onRestart);
    this.button("Later", "Finish the next time you start Toril", onLater);
  }

  /** Something went wrong. Says so, and gets out of the way. */
  failed(message: string, onDismiss: () => void): void {
    this.reset();
    this.text.textContent = `Update failed: ${message}`;
    this.button("Close", "Dismiss", onDismiss);
  }

  /**
   * A plain statement with nothing to act on — "you are up to date", or why a
   * check failed.
   *
   * Reusing the toast rather than raising a native `message()` dialog keeps one
   * mechanism for everything the updater has to say, and keeps a modal off the
   * screen: even for an answer the user asked for, a dialog steals focus from
   * the editor and has to be clicked away before typing resumes.
   */
  info(message: string, onDismiss: () => void): void {
    this.reset();
    this.text.textContent = message;
    this.button("Close", "Dismiss", onDismiss);
  }

  hide(): void {
    this.el.hidden = true;
    this.actions.replaceChildren();
    // Emptied, not removed: the next show() has to be a mutation on a region
    // that already exists.
    this.text.textContent = "";
  }
}
