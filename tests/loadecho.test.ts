// GATE (CLAUDE.md §3): a programmatic load must not mark a document dirty.
//
// This is the regression from the first Windows on-device sweep. Every tab —
// including a brand-new empty one — showed the dirty dot the instant it opened,
// because `@milkdown/plugin-listener` debounces `markdownUpdated` by 200ms and
// the controller's `loading` flag is a synchronous window. A dirty tab is not
// cosmetic: it prompts the close guard, enters the recovery journal, and with
// autosave on it is *written back to disk*, normalizing a note the user only
// opened.
//
// Two halves, deliberately:
//   1. the pure classifier, stated as rules and free of timing;
//   2. one real-Milkdown test that waits past the debounce — the assertion the
//      whole suite was missing. Every pre-existing test returned before 200ms,
//      which is exactly why 271 green tests could not see this.
import { describe, expect, it } from "vitest";
import { createEditor } from "../src/editor/milkdown";
import { docToMarkdown, markdownToDoc } from "../src/editor/serializer";
import { LoadEcho } from "../src/editor/loadecho";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longer than the 200ms lodash debounce inside @milkdown/plugin-listener. */
const PAST_DEBOUNCE_MS = 400;

describe("LoadEcho", () => {
  it("treats a notification matching the last load as an echo", () => {
    const echo = new LoadEcho();
    echo.arm("# Hello\n");
    expect(echo.isEcho("# Hello\n")).toBe(true);
  });

  it("treats different content as a real edit", () => {
    const echo = new LoadEcho();
    echo.arm("# Hello\n");
    expect(echo.isEcho("# Hello!\n")).toBe(false);
  });

  it("reports an edit when nothing was loaded", () => {
    expect(new LoadEcho().isEcho("anything")).toBe(false);
  });

  it("stays disarmed after the first real edit", () => {
    const echo = new LoadEcho();
    echo.arm("# Hello\n");
    expect(echo.isEcho("# Hello!\n")).toBe(false);
    // Typing back to the loaded text must not resurrect the suppression — the
    // next load is what re-arms it, not a coincidence of content.
    expect(echo.isEcho("# Hello\n")).toBe(false);
  });

  it("re-arms on the next load", () => {
    const echo = new LoadEcho();
    echo.arm("a\n");
    echo.isEcho("b\n");
    echo.arm("b\n");
    expect(echo.isEcho("b\n")).toBe(true);
  });

  it("forgets an armed load on demand", () => {
    const echo = new LoadEcho();
    echo.arm("a\n");
    echo.disarm();
    expect(echo.isEcho("a\n")).toBe(false);
  });
});

describe("programmatic load against a real editor", () => {
  it("notifies only after the guard window, and the echo absorbs it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const seen: string[] = [];
    const editor = await createEditor({
      root,
      initial: "# First\n",
      onChange: () => seen.push("change"),
    });
    await tick(PAST_DEBOUNCE_MS);
    seen.length = 0;

    // Exactly what loadIntoEditor() does: load inside a synchronous flag, then
    // arm the echo with the resulting serialization.
    const echo = new LoadEcho();
    let loading = true;
    markdownToDoc(editor, "# Second\n");
    loading = false;
    echo.arm(docToMarkdown(editor));

    await tick(50);
    expect(seen).toEqual([]); // nothing synchronous — the flag never sees it
    await tick(PAST_DEBOUNCE_MS);

    // The notification does arrive, and it arrives unguarded. This is the fact
    // the flag alone cannot handle; if a Milkdown upgrade ever makes the
    // listener synchronous, this line fails and the comment above needs redoing.
    expect(seen).toEqual(["change"]);
    expect(loading).toBe(false);

    // …and the classifier absorbs it, so the controller leaves the tab clean.
    expect(echo.isEcho(docToMarkdown(editor))).toBe(true);

    // A genuine edit after that same load is still an edit.
    markdownToDoc(editor, "# Second, edited\n");
    expect(echo.isEcho(docToMarkdown(editor))).toBe(false);

    await editor.destroy();
    root.remove();
  });
});
