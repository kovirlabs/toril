// Undo/redo, and the one rule that makes it safe with a shared editor.
//
// Found driving the app: the history plugin was never loaded, so Ctrl+Z and
// Edit → Undo did nothing at all. Loading it alone is not enough — every tab
// renders into the same editor, so a tab switch is a whole-document replace,
// and an undoable one would put the previous tab's text into this one.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import { callCommand } from "@milkdown/kit/utils";
import type { Editor } from "@milkdown/kit/core";
import { caretOf, createEditor, resetHistory } from "../src/editor/milkdown";
import { TextSelection } from "@milkdown/kit/prose/state";
import { docToMarkdown, markdownToDoc } from "../src/editor/serializer";

async function makeEditor(initial: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return createEditor({ root, initial });
}

function typeAtEnd(editor: Editor, text: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const end = view.state.doc.content.size - 1; // inside the last paragraph
    view.dispatch(view.state.tr.insertText(text, end));
  });
}

const undo = (editor: Editor) => editor.action(callCommand(undoCommand.key));
const redo = (editor: Editor) => editor.action(callCommand(redoCommand.key));

describe("undo history", () => {
  it("undoes and redoes an edit", async () => {
    const editor = await makeEditor("hello\n");
    typeAtEnd(editor, " world");
    expect(docToMarkdown(editor)).toBe("hello world\n");

    undo(editor);
    expect(docToMarkdown(editor)).toBe("hello\n");
    redo(editor);
    expect(docToMarkdown(editor)).toBe("hello world\n");
    await editor.destroy();
  });

  it("cannot undo a document load back into the previous document", async () => {
    const editor = await makeEditor("first tab\n");
    typeAtEnd(editor, " edited");

    // Exactly what loadIntoEditor() does on a tab switch.
    markdownToDoc(editor, "second tab\n");
    resetHistory(editor, "start");

    undo(editor);
    expect(docToMarkdown(editor)).toBe("second tab\n");
    await editor.destroy();
  });

  it("puts the caret at the top for a new document, and keeps it on a reload", async () => {
    const editor = await makeEditor("one\n\ntwo\n");
    const caret = () =>
      editor.action((ctx) => ctx.get(editorViewCtx).state.selection.from);

    resetHistory(editor, "start");
    expect(caret()).toBe(1);

    typeAtEnd(editor, "!");
    const before = caret();
    resetHistory(editor, caretOf(editor));
    expect(caret()).toBe(before);
    await editor.destroy();
  });

  // Found driving the app: a merged external change moved the caret from the
  // line being typed in to the end of the note, because a whole-document
  // replace maps every position to the end.
  it("keeps the caret in place across a reload of the same document", async () => {
    const editor = await makeEditor("first line\n\nlast line\n");
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    });
    const snapshot = caretOf(editor);

    markdownToDoc(editor, "first line\n\nlast line, changed on disk\n"); // what a merge loads
    resetHistory(editor, snapshot);

    expect(editor.action((ctx) => ctx.get(editorViewCtx).state.selection.head)).toBe(6);
    await editor.destroy();
  });
});
