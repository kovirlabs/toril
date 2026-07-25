// Multi-document tabs (CLAUDE.md §4). One Milkdown editor is shared across
// tabs; each tab keeps its own canonical markdown buffer. On switch the
// controller serializes the outgoing tab from the editor (onDeactivate) and
// loads the incoming one (onActivate), so there is always exactly one source of
// truth per document (no diverging buffers, §3.2).

/** Which canonical representation a tab's `content` is in (§3.2). */
export type DocFormat = "markdown" | "html";

/**
 * Why a tab is blocked from writing, and the disk content that caused it.
 *
 * `theirs` is captured at detection time so a resolution can park the losing
 * side without re-reading the file — a second read could race the sync daemon
 * that wrote it.
 */
export interface DivergedState {
  theirs: string;
  reason: "conflict" | "error";
  message: string;
}

export interface TabState {
  readonly id: string;
  /** Absolute path, or null for an unsaved "Untitled" document. */
  path: string | null;
  name: string;
  /**
   * Canonical content in the tab's `format` (markdown or HTML). Authoritative
   * while the tab is inactive. Each format has exactly one serializer (§3.2).
   */
  content: string;
  /** Determines which serializer loads/saves this tab. */
  format: DocFormat;
  dirty: boolean;
  /**
   * Exact bytes last read from / written to disk — the merge base for a
   * three-way merge (ROADMAP I.4). Kept in memory only: it is always exactly
   * right while the app runs, and needs no storage.
   */
  base: string;
  /** Non-null while the tab is diverged from disk. Blocks all writes (§3). */
  diverged: DivergedState | null;
}

export interface TabCallbacks {
  /** The outgoing tab is losing focus — persist editor state into it. */
  onDeactivate(tab: TabState): void;
  /** The incoming tab gained focus — load its content into the editor. */
  onActivate(tab: TabState): void;
  /** The close (×) control was clicked — controller decides what to do. */
  onCloseRequest(tab: TabState): void;
}

export class TabManager {
  private items: TabState[] = [];
  private activeId: string | null = null;
  private seq = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: TabCallbacks,
  ) {}

  list(): readonly TabState[] {
    return this.items;
  }

  active(): TabState | undefined {
    return this.items.find((t) => t.id === this.activeId);
  }

  byPath(path: string): TabState | undefined {
    return this.items.find((t) => t.path === path);
  }

  /**
   * Open a document. If a tab for the same (non-null) path already exists, it is
   * activated instead of duplicated. Returns the resulting tab.
   */
  open(opts: {
    path: string | null;
    name: string;
    content: string;
    format?: DocFormat;
  }): TabState {
    if (opts.path) {
      const existing = this.byPath(opts.path);
      if (existing) {
        this.setActive(existing.id);
        return existing;
      }
    }
    const tab: TabState = {
      id: `tab-${this.seq++}`,
      path: opts.path,
      name: opts.name,
      content: opts.content,
      format: opts.format ?? "markdown",
      dirty: false,
      base: opts.content,
      diverged: null,
    };
    this.items.push(tab);
    this.setActive(tab.id);
    return tab;
  }

  setActive(id: string): void {
    if (this.activeId === id) {
      this.render();
      return;
    }
    const prev = this.active();
    if (prev) this.cb.onDeactivate(prev);
    this.activeId = id;
    const next = this.active();
    if (next) this.cb.onActivate(next);
    this.render();
  }

  /** Remove a tab and activate a neighbor if it was active. */
  close(id: string): void {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const wasActive = this.activeId === id;
    this.items.splice(idx, 1);
    if (wasActive) {
      const next = this.items[idx] ?? this.items[idx - 1];
      this.activeId = next ? next.id : null;
      if (next) this.cb.onActivate(next); // no onDeactivate: the old tab is gone
    }
    this.render();
  }

  setDirty(id: string, dirty: boolean): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab && tab.dirty !== dirty) {
      tab.dirty = dirty;
      this.render();
    }
  }

  /** Record the bytes now on disk for this tab (open, save, reload, merge). */
  setBase(id: string, base: string): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab) tab.base = base;
  }

  /** Mark or clear divergence. While set, no write path may touch this tab. */
  setDiverged(id: string, d: DivergedState | null): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab) tab.diverged = d;
  }

  setPath(id: string, path: string, name: string): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab) {
      tab.path = path;
      tab.name = name;
      this.render();
    }
  }

  render(): void {
    this.container.replaceChildren();
    for (const tab of this.items) {
      const el = document.createElement("div");
      el.className = "tab";
      el.dataset.active = String(tab.id === this.activeId);
      el.dataset.dirty = String(tab.dirty);

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = `${tab.dirty ? "• " : ""}${tab.name}`;
      label.addEventListener("click", () => this.setActive(tab.id));

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onCloseRequest(tab);
      });

      el.append(label, close);
      this.container.append(el);
    }
  }
}
