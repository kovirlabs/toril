// The ONE definition of Toril's canonical markdown form (CLAUDE.md §3.2).
//
// Toril's serializer must agree with what external writers (Obsidian, Prettier)
// already produce, so that opening and saving an unmodified note is a byte-level
// no-op. Every editor that asserts canonical markdown — the app's and the gates'
// — is built through `useCanonical`, so the canon under test cannot drift from
// the canon that ships.
import type { Editor } from "@milkdown/kit/core";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";

/**
 * remark-stringify options defining Toril's canonical output.
 *
 * Only two entries, each chosen to match Obsidian's own writes. Everything else
 * stays at Milkdown's default: `fence` already emits backticks, `listItemIndent`
 * is already stable, and emphasis/strong are marker-preserved upstream (both
 * `*italic*` and `_italic_` round-trip byte-for-byte), so they need nothing.
 */
const CANONICAL_STRINGIFY_OPTIONS = {
  bullet: "-",
  rule: "-",
} as const;

/**
 * Apply Toril's canonical markdown form to an editor under construction.
 *
 * IMPORTANT: the stringify options are **spread onto** the existing value, never
 * substituted for it. `remarkStringifyOptionsCtx` defaults to
 * `{ handlers: remarkHandlers, ... }`, and those handlers are what preserve each
 * emphasis/strong node's original marker. Replacing the object drops them and
 * silently reverts `_italic_` to `*italic*` — introducing a normalization while
 * removing another.
 */
export function useCanonical(editor: Editor): Editor {
  return editor.config((ctx) => {
    ctx.set(remarkStringifyOptionsCtx, {
      ...ctx.get(remarkStringifyOptionsCtx),
      ...CANONICAL_STRINGIFY_OPTIONS,
    });
  });
}
