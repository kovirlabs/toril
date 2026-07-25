// Milkdown WYSIWYG setup (CLAUDE.md §6). Phase 1 wires the inline editing core:
// CommonMark + GFM (tables, task lists, strikethrough) + a change listener.
// Phase 3 adds emoji shortcodes (`:smile:` → 😄). Math is deferred — its only
// Milkdown plugin is deprecated (§8). Plugins are added here, never by
// hand-rolling ProseMirror nodes (§11).
import { Editor, commandsCtx, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark, insertImageCommand } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
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
      .use(listener)
      .use(searchPlugin()),
  );
  if (onImagePaste) {
    editor = editor.use(imagePastePlugin(onImagePaste));
  }
  return editor.create();
}
