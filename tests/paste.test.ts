// Pasting plain-text markdown.
//
// Found driving the app: pasting `**bold**` or `## Heading` from Notepad arrived
// as literal characters — the clipboard plugin was never loaded, so text/plain
// went straight in as text. These drive the editor's real paste handlers with a
// fake clipboard (jsdom has no ClipboardEvent data).
import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createEditor } from "../src/editor/milkdown";
import { docToMarkdown } from "../src/editor/serializer";

let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

async function mount(initial: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  editor = await createEditor({ root, initial });
  return editor;
}

/** Run the editor's paste handlers the way ProseMirror does on a real paste. */
function paste(ed: Editor, data: Record<string, string>): boolean {
  return ed.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const event = {
      clipboardData: { getData: (type: string) => data[type] ?? "", items: [] },
      preventDefault() {},
    } as unknown as ClipboardEvent;
    return Boolean(view.someProp("handlePaste", (f) => f(view, event, undefined as never)));
  });
}

/** Caret on a fresh empty line at the end — where a paste usually lands.
 *  (Mid-paragraph, ProseMirror joins the first pasted block into the current
 *  one, as it does for any paste.) */
function caretOnNewLine(ed: Editor): void {
  ed.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const tr = view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes.paragraph.create());
    view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)));
  });
}

describe("pasting plain text", () => {
  it("parses markdown instead of inserting the syntax as text", async () => {
    const ed = await mount("Intro\n");
    caretOnNewLine(ed);
    expect(paste(ed, { "text/plain": "## Heading\n\n- **one**\n- two\n" })).toBe(true);
    const md = docToMarkdown(ed);
    expect(md).toContain("## Heading");
    expect(md).toContain("- **one**");
    expect(md).not.toContain("\\*\\*"); // escaped, i.e. literal, asterisks
  });

  it("pastes literally inside a code block", async () => {
    const ed = await mount("```\nx\n```\n");
    ed.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    });
    // Declined by the markdown handler, so ProseMirror's default inserts text.
    expect(paste(ed, { "text/plain": "**not bold**" })).toBe(false);
  });
});
