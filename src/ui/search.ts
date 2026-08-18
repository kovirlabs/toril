// Find & Replace (CLAUDE.md §8 Phase 4 polish).
//
// Hand-rolled on Milkdown's bundled ProseMirror rather than pulling in
// `prosemirror-search`: a second ProseMirror copy in the tree would break plugin
// interop (ProseMirror requires exactly one). A `$prose` plugin highlights
// matches via decorations; the `SearchBar` controller owns the query/replace UI
// and drives navigation + replacement through transactions (never raw text
// rewriting of the markdown — edits go through the document like any other).
//
// Matching is case-insensitive and within a single text node (cross-node matches
// are not found — fine for a notes editor). The pure `findInText` is unit-tested.
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

/** Case-insensitive substring offsets of `needle` in `haystack` (non-overlapping). */
export function findInText(haystack: string, needle: string): number[] {
  if (needle === "") return [];
  const hay = haystack.toLowerCase();
  const nee = needle.toLowerCase();
  const offsets: number[] = [];
  let i = hay.indexOf(nee);
  while (i !== -1) {
    offsets.push(i);
    i = hay.indexOf(nee, i + nee.length);
  }
  return offsets;
}

export interface Match {
  from: number;
  to: number;
}

/** All matches of `query` across the document's text nodes, as doc positions. */
export function findMatches(doc: ProseNode, query: string): Match[] {
  const matches: Match[] = [];
  if (query === "") return matches;
  doc.descendants((node, pos) => {
    if (!node.isText || node.text == null) return;
    for (const off of findInText(node.text, query)) {
      matches.push({ from: pos + off, to: pos + off + query.length });
    }
  });
  return matches;
}

interface SearchPluginState {
  query: string;
  active: number;
}

const searchKey = new PluginKey<SearchPluginState>("toril-search");

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** Decoration plugin that highlights matches of the current query. */
export function searchPlugin() {
  return $prose(
    () =>
      new Plugin<SearchPluginState>({
        key: searchKey,
        state: {
          init: () => ({ query: "", active: 0 }),
          apply(tr, value) {
            const meta = tr.getMeta(searchKey) as SearchPluginState | undefined;
            return meta ?? value;
          },
        },
        props: {
          decorations(state) {
            const ps = searchKey.getState(state);
            if (!ps || ps.query === "") return DecorationSet.empty;
            const matches = findMatches(state.doc, ps.query);
            if (matches.length === 0) return DecorationSet.empty;
            const active = mod(ps.active, matches.length);
            const decos = matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === active ? "search-hit search-hit-active" : "search-hit",
              }),
            );
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );
}

/**
 * The Find & Replace bar. Owns the query/replacement and the active-match index;
 * mirrors them into the plugin (for highlighting) on every change.
 */
export class SearchBar {
  private query = "";
  private active = 0;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly count: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly editor: Editor,
  ) {
    container.hidden = true;
    container.className = "searchbar";

    this.findInput = this.input("Find");
    this.count = document.createElement("span");
    this.count.className = "search-count";
    this.replaceInput = this.input("Replace with");

    const prev = this.button("‹", "Previous match", () => this.go(-1));
    const next = this.button("›", "Next match", () => this.go(1));
    const replace = this.button("Replace", "Replace current match", () => this.replace());
    const replaceAll = this.button("All", "Replace all matches", () => this.replaceAll());
    const close = this.button("✕", "Close (Esc)", () => this.close());

    const findRow = document.createElement("div");
    findRow.className = "search-row";
    findRow.append(this.findInput, this.count, prev, next, close);
    const replaceRow = document.createElement("div");
    replaceRow.className = "search-row";
    replaceRow.append(this.replaceInput, replace, replaceAll);
    container.append(findRow, replaceRow);

    this.findInput.addEventListener("input", () => this.setQuery(this.findInput.value));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.go(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replace();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
  }

  private input(placeholder: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.placeholder = placeholder;
    el.className = "search-input";
    return el;
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.className = "search-btn";
    // mousedown+preventDefault keeps focus in the inputs.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  /** Open the bar; seed the query from the current selection if any. */
  open(): void {
    const selected = this.selectionText();
    if (selected && !selected.includes("\n")) {
      this.findInput.value = selected;
      this.setQuery(selected);
    }
    this.container.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }

  /**
   * Open the bar on `query` — how a vault-search result lands inside the note.
   *
   * The panel deliberately hands over the *text* rather than a line number.
   * There is no line number to jump to in a WYSIWYG surface: the doc is a
   * ProseMirror tree, and mapping a line of markdown source onto a position in
   * it would be a second, divergent parse of the same file (§3.2). Re-finding
   * the text in the doc that is actually open is both simpler and always right.
   */
  openWith(query: string): void {
    this.findInput.value = query;
    this.setQuery(query);
    this.container.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }

  close(): void {
    this.container.hidden = true;
    this.setQuery(""); // clear highlights
  }

  private selectionText(): string {
    let text = "";
    this.editor.action((ctx) => {
      const { state } = ctx.get(editorViewCtx);
      const { from, to, empty } = state.selection;
      if (!empty) text = state.doc.textBetween(from, to, "\n", "");
    });
    return text;
  }

  private matches(): Match[] {
    let result: Match[] = [];
    this.editor.action((ctx) => {
      result = findMatches(ctx.get(editorViewCtx).state.doc, this.query);
    });
    return result;
  }

  private pushState(): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(searchKey, { query: this.query, active: this.active }));
    });
  }

  private setQuery(query: string): void {
    this.query = query;
    this.active = 0;
    this.pushState();
    this.scrollToActive();
    this.updateCount();
  }

  private go(delta: number): void {
    const matches = this.matches();
    if (matches.length === 0) return;
    this.active = mod(this.active + delta, matches.length);
    this.pushState();
    this.scrollToActive();
    this.updateCount();
  }

  private replace(): void {
    const matches = this.matches();
    if (matches.length === 0) return;
    const m = matches[mod(this.active, matches.length)];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(this.replaceInput.value, m.from, m.to));
    });
    this.pushState();
    this.updateCount();
  }

  private replaceAll(): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const matches = findMatches(state.doc, this.query);
      if (matches.length === 0) return;
      let tr = state.tr;
      // Back-to-front so earlier positions stay valid as we splice.
      for (let i = matches.length - 1; i >= 0; i--) {
        tr = tr.insertText(this.replaceInput.value, matches[i].from, matches[i].to);
      }
      view.dispatch(tr);
    });
    this.updateCount();
  }

  private scrollToActive(): void {
    const matches = this.matches();
    if (matches.length === 0) return;
    const m = matches[mod(this.active, matches.length)];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const sel = TextSelection.create(state.doc, m.from, m.to);
      view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    });
  }

  private updateCount(): void {
    const n = this.matches().length;
    this.count.textContent =
      n === 0 ? (this.query === "" ? "" : "No results") : `${mod(this.active, n) + 1} of ${n}`;
  }
}
