// The ONE emoji stack (CLAUDE.md §6): upstream @milkdown/plugin-emoji, plus a
// correction that keeps text twemoji does not draw as an image out of the
// `emoji` node. The app (milkdown.ts) and every gate import `emoji` from here,
// so the stack under test is the stack that ships — like canonical.ts.
//
// The defect, in @milkdown/plugin-emoji 7.21.1 and still half-present in 7.23.0:
// its remark step splits text on `emoji-regex`, which matches ©, ® and ™ (they
// are emoji with a *text* default presentation), and wraps each match in an
// `emoji` node holding `twemoji.parse(match)`. twemoji only draws the
// emoji-presentation forms (©️ with U+FE0F), so for a bare © the node holds the
// plain character. Two things then go wrong with that node:
//
//   1. It cannot be drawn. Its `toDOM` hands ProseMirror a Text node, and
//      prosemirror-model ≥ 1.25.5 accepts only Element nodes in a DOM spec, so
//      the load throws "Invalid array passed to renderSpec" — any note with a ®
//      in it fails to open. (7.23.0 fixes this half.)
//   2. It cannot be saved. Its `toMarkdown` writes the `<img>`'s title, and
//      there is no `<img>`, so the character is DELETED: `A © B` saves as
//      `A  B` (§3.2). (7.23.0 does not fix this half — upgrading alone would
//      turn a visible open failure into silent loss on save.)
//
// The fix is at the source: after twemoji runs, any `emoji` node whose html is
// not an image goes back to being ordinary text. A ™ in prose is prose — it
// takes the same search, word-count, escaping and serialization path as the
// letters around it, and no custom schema is involved (§11).
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as MdNode } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import { emoji as upstreamEmoji } from "@milkdown/plugin-emoji";

type Literal = MdNode & { value: string };
type Parent = MdNode & { children: MdNode[] };

const isParent = (node: MdNode): node is Parent =>
  Array.isArray((node as Partial<Parent>).children);

/** True for an `emoji` mdast node that twemoji left as plain text (no image). */
function isTextOnlyEmoji(node: MdNode): node is Literal {
  if (node.type !== "emoji") return false;
  const value = (node as Partial<Literal>).value;
  return typeof value === "string" && !value.includes("<img");
}

/**
 * Turn text-only `emoji` nodes back into `text`, merging each into an adjacent
 * text node so the tree is exactly what remark would have produced had the
 * emoji step never split it.
 */
export function demoteTextOnlyEmoji(tree: MdNode): void {
  if (!isParent(tree)) return;
  const out: MdNode[] = [];
  for (const child of tree.children) {
    demoteTextOnlyEmoji(child);
    const node: MdNode = isTextOnlyEmoji(child) ? { ...child, type: "text" } : child;
    const prev = out[out.length - 1];
    if (node.type === "text" && prev?.type === "text") {
      (prev as Literal).value += (node as Literal).value;
    } else {
      out.push(node);
    }
  }
  tree.children = out;
}

/** Registered after upstream's twemoji step, so it sees that step's output. */
export const remarkSymbolsAsText = $remark("remarkSymbolsAsText", () => () => demoteTextOnlyEmoji);

export const emoji: MilkdownPlugin[] = [...upstreamEmoji, ...remarkSymbolsAsText].flat();
