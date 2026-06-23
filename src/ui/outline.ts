// Outline / TOC (CLAUDE.md §4). Reads the live ProseMirror doc (never a second
// text parse, §3.2) to list headings; navigation is a pure selection move.
// The pure helpers are unit-tested; the Outline class (added later) wires them
// to the editor and the DOM, mirroring StatusBar.
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

export interface Heading {
  /** 1–6. */
  level: number;
  /** The heading's text content. */
  text: string;
  /** Position *before* the heading node (for selection/navigation). */
  pos: number;
}

/** Walk heading nodes in document order. */
export function extractHeadings(doc: ProseNode): Heading[] {
  const headings: Heading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({
        level: Number(node.attrs.level) || 1,
        text: node.textContent,
        pos,
      });
      return false; // no headings nested inside a heading — don't descend
    }
    return undefined; // descend into everything else
  });
  return headings;
}

/**
 * Index of the last heading at or before `pos` (the heading the caret/viewport
 * is currently within); -1 when `pos` is above the first heading. Headings are
 * in document order, so we can stop at the first one past `pos`.
 */
export function activeHeadingIndex(headings: Heading[], pos: number): number {
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].pos <= pos) idx = i;
    else break;
  }
  return idx;
}
