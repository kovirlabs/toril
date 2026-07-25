// Phase 3 GATE (CLAUDE.md §3.2, §8): the formatting toolbar must not open a
// second markdown conversion path.
//
// Two properties are asserted for every toolbar command:
//
//   1. Equivalence: applying a format via the command yields the SAME canonical
//      markdown as typing the equivalent syntax by hand (round-tripped through
//      serializer.ts). The toolbar is just another producer of canonical docs.
//   2. No raw-markdown-text insertion: after applying an inline format, the
//      document's text content is unchanged — the syntax lives as marks/nodes,
//      never as literal characters like `**` or `> `. A button that cheated by
//      inserting markdown text would fail this.
//
// The command layer (src/ui/toolbar.ts `editorCommands`) is exercised directly
// on a real Milkdown editor — the same commonmark + gfm + emoji stack the app
// builds — so this gate guards the actual code the buttons call.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "@milkdown/plugin-emoji";
import { TextSelection } from "@milkdown/kit/prose/state";
import { useCanonical } from "../src/editor/canonical";
import { docToMarkdown } from "../src/editor/serializer";
import { activeState, editorCommands } from "../src/ui/toolbar";

async function makeEditor(md: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
}

/** Build a one-paragraph editor whose entire text is selected. */
async function withSelection(text: string): Promise<Editor> {
  const editor = await makeEditor(text);
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const sel = TextSelection.create(state.doc, 1, Math.max(1, state.doc.content.size - 1));
    view.dispatch(state.tr.setSelection(sel));
  });
  return editor;
}

function docText(editor: Editor): string {
  let text = "";
  editor.action((ctx) => {
    text = ctx.get(editorViewCtx).state.doc.textContent;
  });
  return text;
}

/** Canonical markdown for hand-typed syntax — the reference the toolbar must match. */
async function roundtrip(md: string): Promise<string> {
  const editor = await makeEditor(md);
  const out = docToMarkdown(editor);
  await editor.destroy();
  return out;
}

describe("formatting toolbar — round-trip equivalence (Phase 3 gate)", () => {
  // [command id, sample text, the syntax a user would type by hand]
  const inlineCases: [keyof typeof editorCommands, string, string][] = [
    ["bold", "hello", "**hello**"],
    ["italic", "hello", "*hello*"],
    ["strikethrough", "hello", "~~hello~~"],
    ["inlineCode", "hello", "`hello`"],
  ];

  for (const [id, text, syntax] of inlineCases) {
    it(`inline mark ${id} matches typing the syntax`, async () => {
      const editor = await withSelection(text);
      (editorCommands[id] as (e: Editor) => void)(editor);
      const out = docToMarkdown(editor);
      expect(out).toBe(await roundtrip(syntax)); // (1) equivalence
      expect(docText(editor)).toBe(text); // (2) no raw syntax injected as text
      await editor.destroy();
    });
  }

  const blockCases: [keyof typeof editorCommands, string, string][] = [
    ["blockquote", "quote", "> quote"],
    ["bulletList", "item", "* item"],
    ["orderedList", "item", "1. item"],
    ["codeBlock", "code", "```\ncode\n```"],
  ];

  for (const [id, text, syntax] of blockCases) {
    it(`block ${id} matches typing the syntax`, async () => {
      const editor = await withSelection(text);
      (editorCommands[id] as (e: Editor) => void)(editor);
      const out = docToMarkdown(editor);
      expect(out).toBe(await roundtrip(syntax));
      expect(docText(editor)).toBe(text); // text preserved; markers are structure
      await editor.destroy();
    });
  }

  it("heading sets the chosen level and matches typed syntax", async () => {
    for (let level = 1; level <= 6; level++) {
      const editor = await withSelection("Title");
      editorCommands.heading(editor, level);
      const out = docToMarkdown(editor);
      expect(out).toBe(await roundtrip(`${"#".repeat(level)} Title`));
      expect(docText(editor)).toBe("Title");
      expect(activeState(editor).headingLevel).toBe(level);
      await editor.destroy();
    }
  });

  it("paragraph clears a heading back to plain text", async () => {
    const editor = await makeEditor("# Title\n");
    editorCommands.paragraph(editor);
    expect(docToMarkdown(editor)).toBe("Title\n");
    await editor.destroy();
  });

  it("task list produces a GFM checkbox item, not literal text", async () => {
    const editor = await withSelection("todo");
    editorCommands.taskList(editor);
    expect(docToMarkdown(editor)).toBe(await roundtrip("* [ ] todo"));
    expect(docText(editor)).toBe("todo"); // `[ ]` is an attribute, not text
    expect(activeState(editor).isTask).toBe(true);
    await editor.destroy();
  });

  it("link applies an href without inserting bracket syntax as text", async () => {
    const editor = await withSelection("text");
    editorCommands.link(editor, { href: "https://example.com" });
    expect(docToMarkdown(editor)).toBe(await roundtrip("[text](https://example.com)"));
    expect(docText(editor)).toBe("text");
    await editor.destroy();
  });

  it("image inserts an image node matching typed syntax", async () => {
    const editor = await makeEditor("");
    editorCommands.image(editor, { src: "pic.png", alt: "a picture" });
    expect(docToMarkdown(editor)).toBe(await roundtrip("![a picture](pic.png)"));
    await editor.destroy();
  });

  it("horizontal rule serializes to the canonical thematic break", async () => {
    const editor = await makeEditor("above\n");
    editorCommands.hr(editor);
    expect(docToMarkdown(editor)).toContain("---");
    await editor.destroy();
  });

  it("table inserts a GFM table, never raw pipe text", async () => {
    const editor = await makeEditor("");
    editorCommands.table(editor);
    const out = docToMarkdown(editor);
    expect(out).toContain("|"); // it is a real table…
    expect(out).toMatch(/\| :?-+:? \|/); // …with the GFM header separator row
    await editor.destroy();
  });

  it("emoji inserts the unicode character (canonical form), not a shortcode", async () => {
    const editor = await makeEditor("Ship it \n");
    // caret after "Ship it " — append the emoji at the end of the paragraph.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const end = TextSelection.create(state.doc, state.doc.content.size - 1);
      view.dispatch(state.tr.setSelection(end));
    });
    editorCommands.emoji(editor, "🚀");
    const out = docToMarkdown(editor);
    expect(out).toContain("🚀");
    expect(out).not.toContain(":rocket:"); // not a shortcode
    expect(await roundtrip(out)).toBe(out); // and it round-trips stably
    await editor.destroy();
  });

  it("clear formatting strips inline marks but keeps the text", async () => {
    const editor = await withSelection("hello");
    editorCommands.bold(editor); // first make it bold…
    editorCommands.italic(editor);
    expect(activeState(editor).marks.size).toBeGreaterThan(0);
    editorCommands.clearFormatting(editor); // …then clear it
    expect(docToMarkdown(editor)).toBe("hello\n");
    expect(docText(editor)).toBe("hello");
    await editor.destroy();
  });
});

describe("formatting toolbar — active state reflects the selection", () => {
  it("reports the active inline mark", async () => {
    const editor = await withSelection("hello");
    expect(activeState(editor).marks.has("strong")).toBe(false);
    editorCommands.bold(editor);
    expect(activeState(editor).marks.has("strong")).toBe(true);
    await editor.destroy();
  });

  it("reports list context", async () => {
    const editor = await withSelection("item");
    expect(activeState(editor).inBulletList).toBe(false);
    editorCommands.bulletList(editor);
    expect(activeState(editor).inBulletList).toBe(true);
    await editor.destroy();
  });
});
