// Outline / TOC (CLAUDE.md §4). Reads the live ProseMirror doc (never a second
// text parse, §3.2) to list headings; navigation is a pure selection move.
// The pure helpers are unit-tested; the Outline class (added later) wires them
// to the editor and the DOM, mirroring StatusBar.
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";

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

export class Outline {
  private rafId = 0;
  private headings: Heading[] = [];
  private entries: HTMLButtonElement[] = [];
  private pendingViewport = false;
  private readonly onCaret = () => this.scheduleActive(false);
  private readonly onScroll = () => this.scheduleActive(true);

  constructor(
    private readonly el: HTMLElement,
    private readonly editor: Editor,
    private readonly editorRoot: HTMLElement,
  ) {
    // Structure changes come via the controller's refresh(); these only move the
    // active highlight (scroll-spy), like StatusBar watches the surface directly.
    this.editorRoot.addEventListener("keyup", this.onCaret);
    this.editorRoot.addEventListener("mouseup", this.onCaret);
    this.editorRoot.addEventListener("scroll", this.onScroll);
    document.addEventListener("selectionchange", this.onCaret);
    this.refresh();
  }

  destroy(): void {
    this.editorRoot.removeEventListener("keyup", this.onCaret);
    this.editorRoot.removeEventListener("mouseup", this.onCaret);
    this.editorRoot.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("selectionchange", this.onCaret);
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  /** Re-read the doc, rebuild the list, refresh the active highlight. */
  refresh(): void {
    this.headings = this.read();
    this.render();
    this.updateActive(false);
  }

  private read(): Heading[] {
    let result: Heading[] = [];
    this.editor.action((ctx) => {
      result = extractHeadings(ctx.get(editorViewCtx).state.doc);
    });
    return result;
  }

  private render(): void {
    this.el.replaceChildren();
    this.entries = [];
    if (this.headings.length === 0) {
      const hint = document.createElement("p");
      hint.className = "outline-empty";
      hint.textContent = "No headings";
      this.el.append(hint);
      return;
    }
    const list = document.createElement("ul");
    list.className = "outline-list";
    this.headings.forEach((h, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "outline-entry";
      btn.dataset.level = String(h.level);
      btn.textContent = h.text || "(untitled)";
      btn.addEventListener("click", () => this.goTo(this.headings[i].pos));
      li.append(btn);
      list.append(li);
      this.entries.push(btn);
    });
    this.el.append(list);
  }

  /** Move the caret into the heading at `pos` and scroll it into view (§3.2: selection only). */
  private goTo(pos: number): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const sel = TextSelection.near(state.doc.resolve(pos + 1));
      view.dispatch(state.tr.setSelection(sel).scrollIntoView());
      view.focus();
    });
  }

  private scheduleActive(viewport: boolean): void {
    this.pendingViewport = viewport;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.updateActive(this.pendingViewport);
    });
  }

  /**
   * Highlight the heading enclosing the current position. On a selection move
   * that position is the caret; on scroll it is the doc position at the top of
   * the viewport (the only view-dependent line, guarded for a null result).
   */
  private updateActive(viewport: boolean): void {
    if (this.headings.length === 0) return;
    let pos = 0;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      pos = view.state.selection.head;
      if (viewport) {
        const rect = this.editorRoot.getBoundingClientRect();
        const top = view.posAtCoords({ left: rect.left + 1, top: rect.top + 1 });
        if (top) pos = top.pos;
      }
    });
    const active = activeHeadingIndex(this.headings, pos);
    this.entries.forEach((btn, i) => {
      btn.dataset.active = String(i === active);
    });
  }
}
