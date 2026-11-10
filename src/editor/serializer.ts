// The ONE markdown ⇄ document converter (CLAUDE.md §3.2). Every conversion in
// Toril — editor load, save, source-mode swap, tests — goes through these two
// functions, so there is exactly one canonical markdown representation and no
// second, diverging code path.
//
// Both wrap Milkdown's own remark-backed pipeline (markdown ⇄ mdast ⇄
// ProseMirror), so we inherit its tested round-trip behavior rather than
// hand-rolling a schema (§11).
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { replaceAll } from "@milkdown/kit/utils";
import { minimizeEscapes } from "./escapes";

/**
 * Serialize the editor's current document to canonical markdown.
 *
 * remark escapes defensively, which turns Obsidian's `[[wikilinks]]`,
 * `![[embeds]]` and `> [!callouts]` into literal text. `minimizeEscapes` takes
 * back every escape whose removal provably parses to the same document.
 *
 * For the whole document, a candidate is accepted if it loads as the **live**
 * document (the ideal, and one parse) or, failing that, as the fully escaped
 * output would — the exact pre-minimization behavior, which differs from the
 * live doc only where remark's round trip is already lossy.
 */
export function docToMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const serializer = ctx.get(serializerCtx);
    const parser = ctx.get(parserCtx);
    const live = ctx.get(editorViewCtx).state.doc;
    const escaped = serializer(live);

    let escapedDoc: Node | null = null;
    let lastRef: string | null = null;
    let lastRefDoc: Node | null = null;
    return minimizeEscapes(escaped, (candidate, reference) => {
      const parsed = parser(candidate);
      if (reference === escaped) {
        if (parsed.eq(live)) return true;
        escapedDoc ??= parser(escaped);
        return parsed.eq(escapedDoc);
      }
      // A block, verified standalone. Bisection re-tests against the same
      // reference many times, so keep its parse.
      if (reference !== lastRef) {
        lastRef = reference;
        lastRefDoc = parser(reference);
      }
      return lastRefDoc !== null && parsed.eq(lastRefDoc);
    });
  });
}

/** Replace the editor's entire document with the result of parsing `markdown`. */
export function markdownToDoc(editor: Editor, markdown: string): void {
  editor.action(replaceAll(markdown));
}
