// Tells a programmatic load's own change notification apart from a user edit.
//
// Why this exists (found by driving the app on Windows, not by reading it):
// `@milkdown/plugin-listener` debounces `markdownUpdated` by 200ms. A boolean
// "we are loading" flag around `replaceAll` is therefore always already closed
// when the notification for that load arrives — so every open, every tab switch
// and every external-change reload marked its document dirty ~200ms later,
// without the user touching a key.
//
// That is not cosmetic. A dirty tab prompts the close guard, enters the
// recovery journal, and — with autosave on — gets *written back to disk*,
// normalizing an untouched note (CRLF→LF, list reformatting, front matter) in a
// file the user only looked at. §3 says the user's writing is the only thing
// that truly matters; a write nobody asked for is the clearest way to fail it.
//
// The fix is to compare content rather than race a timer: a notification whose
// serialization still equals what we just loaded carries no user edit, whatever
// clock it arrived on. Pure and timing-free, so the gate can state the rule
// without reaching for fake timers.

/**
 * Remembers the serialization of the last programmatic load so a debounced
 * change notification can be classified without depending on when it lands.
 */
export class LoadEcho {
  /** Serialization of the last load, or null once a real edit has been seen. */
  private expected: string | null = null;

  /** Record what was just loaded. Pass the *serialized* document, not the
   *  source text: a non-canonical file (`*` bullets, CRLF) serializes to
   *  something else the instant it is parsed, and comparing against the raw
   *  bytes would call that difference a user edit. */
  arm(serialized: string): void {
    this.expected = serialized;
  }

  /**
   * Is this notification the echo of the last load rather than a user edit?
   *
   * Disarms on the first genuine difference, so the comparison runs at most
   * once per load instead of on every keystroke for the life of the tab.
   */
  isEcho(current: string): boolean {
    if (this.expected === null) return false;
    if (this.expected !== current) {
      this.expected = null;
      return false;
    }
    return true;
  }

  /** Forget any armed load — the next notification counts as an edit. */
  disarm(): void {
    this.expected = null;
  }
}
