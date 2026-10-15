// Milkdown WYSIWYG setup (CLAUDE.md §6). Phase 1 wires the inline editing core:
// CommonMark + GFM (tables, task lists, strikethrough) + a change listener.
// Phase 3 adds emoji shortcodes (`:smile:` → 😄). Math is deferred — its only
// Milkdown plugin is deprecated (§8). Plugins are added here, never by
// hand-rolling ProseMirror nodes (§11).
import { Editor, commandsCtx, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark, insertImageCommand } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { $prose } from "@milkdown/kit/utils";
import { EditorState, Plugin, PluginKey, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { emoji } from "@milkdown/plugin-emoji";
import { nord } from "@milkdown/theme-nord";
import { searchPlugin } from "../ui/search";
import { useCanonical } from "./canonical";
import { htmlConstructs } from "./html-constructs";

/**
 * Resolves a pasted image's bytes to a document-relative `src` to link, or
 * `null` to skip insertion (e.g. the document isn't saved yet). The controller
 * supplies this; the editor stays agnostic about where images are written.
 */
export type ImagePasteHandler = (bytes: Uint8Array) => Promise<string | null>;

// Intercept paste of an image file: hand its bytes to `onImagePaste`, then
// insert a real image node via the canonical command (never raw markdown text,
// §3.2). Returning true tells ProseMirror we've handled the paste.
function imagePastePlugin(onImagePaste: ImagePasteHandler) {
  return $prose(
    (ctx) =>
      new Plugin({
        key: new PluginKey("toril-image-paste"),
        props: {
          handlePaste: (_view, event) => {
            const items = Array.from(event.clipboardData?.items ?? []);
            const image = items.find(
              (it) => it.kind === "file" && it.type.startsWith("image/"),
            );
            const file = image?.getAsFile();
            if (!file) return false; // not an image paste — let ProseMirror handle it
            event.preventDefault();
            void (async () => {
              try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const src = await onImagePaste(bytes);
                if (src) ctx.get(commandsCtx).call(insertImageCommand.key, { src });
              } catch {
                // Upload/insert failed (or the editor went away) — already surfaced
                // to the user by the handler; nothing more to do here.
              }
            })();
            return true;
          },
        },
      }),
  );
}

/** Blocks a caret can simply be put at the end of. Anything else at the end of
 *  the document (code block, table, list, quote, rule, …) needs a paragraph
 *  after it before there is anywhere to type. */
function endsInWritableBlock(view: EditorView): boolean {
  const name = view.state.doc.lastChild?.type.name;
  return name === "paragraph" || name === "heading";
}

/** Put the caret at the very end of the document, appending an empty paragraph
 *  first when the last block is one the caret cannot follow. */
function caretToEnd(view: EditorView): void {
  let tr = view.state.tr;
  if (!endsInWritableBlock(view)) {
    tr = tr.insert(tr.doc.content.size, view.state.schema.nodes.paragraph.create());
  }
  view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
  view.focus();
}

// Found by driving the app: a document ending in a code block or table was a
// trap — clicking below it did nothing and ↓ stayed put (only the unadvertised
// Mod-Enter escaped a code block). And the area around the ProseMirror element
// is not part of it, so in a short or empty note most of the visible page
// ignored clicks entirely: a blank new note could not be focused except by
// hitting its one invisible line.
function reachTheEndPlugin(root: HTMLElement) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey("toril-reach-the-end"),
        props: {
          handleKeyDown: (view, event) => {
            if (event.key !== "ArrowDown" || event.shiftKey || event.altKey) return false;
            if (event.ctrlKey || event.metaKey) return false;
            const { selection, doc } = view.state;
            if (!selection.empty || endsInWritableBlock(view)) return false;
            if (!view.endOfTextblock("down")) return false;
            // Only from the last line of the last textblock: anywhere else, ↓
            // already has somewhere to go.
            let later = false;
            doc.nodesBetween(selection.$head.after(), doc.content.size, (node) => {
              if (node.isTextblock) later = true;
              return !later;
            });
            if (later) return false;
            caretToEnd(view);
            return true;
          },
        },
        view: (view) => {
          const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 || view.dom.contains(e.target as Node)) return;
            // Leave the root's own scrollbars alone: a press there is a drag.
            const box = root.getBoundingClientRect();
            if (e.clientX >= box.left + root.clientLeft + root.clientWidth) return;
            if (e.clientY >= box.top + root.clientTop + root.clientHeight) return;
            const content = view.dom.getBoundingClientRect();
            if (e.clientY < content.top) return;
            e.preventDefault();
            if (e.clientY > content.bottom) {
              caretToEnd(view);
              return;
            }
            // Beside the text (the margins of the measure): the nearest line.
            const left = Math.min(Math.max(e.clientX, content.left + 1), content.right - 1);
            const hit = view.posAtCoords({ left, top: e.clientY });
            if (hit) {
              const $pos = view.state.doc.resolve(hit.pos);
              view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
            }
            view.focus();
          };
          root.addEventListener("mousedown", onMouseDown);
          return { destroy: () => root.removeEventListener("mousedown", onMouseDown) };
        },
      }),
  );
}

/**
 * Start the editor's state over on the document it already holds: empty undo
 * history. Called after every programmatic load, because the tabs share one
 * editor — without it, the first Ctrl+Z after switching tabs would "undo" the
 * switch and put the previous tab's text into this one.
 *
 * `caret: "start"` is for showing a different document. For a reload of the
 * same one (an external change merged in), pass the {@link caretOf} taken
 * *before* the load: a whole-document replace maps every position to the end,
 * so someone typing in the first line when a merge landed found their next
 * keystrokes at the bottom of the note. The old offsets, clamped, are right
 * whenever the change was below the caret and close otherwise.
 */
export function resetHistory(editor: Editor, caret: "start" | CaretSnapshot = "start"): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { doc, plugins } = view.state;
    let selection: Selection | undefined;
    if (caret !== "start") {
      const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
      selection = TextSelection.between(doc.resolve(clamp(caret.anchor)), doc.resolve(clamp(caret.head)));
    }
    view.updateState(EditorState.create({ doc, plugins, selection }));
  });
}

/** Where the caret is, as plain offsets that survive a document swap. */
export interface CaretSnapshot {
  anchor: number;
  head: number;
}

export function caretOf(editor: Editor): CaretSnapshot {
  return editor.action((ctx) => {
    const { anchor, head } = ctx.get(editorViewCtx).state.selection;
    return { anchor, head };
  });
}

export interface CreateEditorOptions {
  /** Element the editor mounts into. */
  root: HTMLElement;
  /** Initial markdown to load. */
  initial?: string;
  /** Called whenever the document changes (user edits or programmatic loads). */
  onChange?: () => void;
  /** Handle a pasted image (§6); omit to disable image-paste interception. */
  onImagePaste?: ImagePasteHandler;
}

/** Create and mount a Milkdown editor. Resolves once it is ready. */
export function createEditor(options: CreateEditorOptions): Promise<Editor> {
  const { root, initial = "", onChange, onImagePaste } = options;
  let editor = useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        if (onChange) {
          ctx.get(listenerCtx).markdownUpdated(() => onChange());
        }
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(emoji)
      .use(htmlConstructs)
      .use(history)
      .use(listener)
      .use(searchPlugin())
      .use(reachTheEndPlugin(root)),
  );
  if (onImagePaste) {
    editor = editor.use(imagePastePlugin(onImagePaste));
  }
  // Paste handlers run in registration order, so this must come after the
  // image handler: a copied image often carries an HTML twin that the clipboard
  // plugin would otherwise take first.
  //
  // Pasting markdown as plain text used to arrive literally — `**bold**`,
  // `## Heading` — in a markdown editor. This parses text/plain through the same
  // parser that opens files (§3.2), leaves HTML pastes on ProseMirror's
  // schema-limited path, and pastes literally inside a code block. It also
  // makes a copy *out* of Toril put markdown, not bare text, on the clipboard.
  editor = editor.use(clipboard);
  return editor.create();
}
