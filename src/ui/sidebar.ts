// Workspace file tree (CLAUDE.md §4). Renders the FileNode[] from `open_folder`
// as a collapsible tree; clicking a markdown file asks the controller to open
// it. Folders use native <details> for zero-JS collapse.
import type { FileNode } from "../ipc";

export interface SidebarCallbacks {
  onOpenFile(path: string): void;
  /**
   * Open a folder from the empty state.
   *
   * Optional so the sidebar stays constructible without it, but when it is
   * absent the empty state falls back to text — a dead button that looks live
   * is worse than a sentence.
   */
  onOpenFolder?(): void;
}

export class Sidebar {
  constructor(
    private readonly container: HTMLElement,
    private readonly cb: SidebarCallbacks,
  ) {}

  /** Render a workspace, or an empty-state hint when no folder is open. */
  setRoot(rootName: string | null, tree: FileNode[]): void {
    this.container.replaceChildren();

    if (rootName === null) {
      // An empty state that only *names* the emptiness leaves the user to find
      // the menu; the fix for "no folder open" belongs next to the message.
      const wrap = document.createElement("div");
      wrap.className = "sidebar-empty";

      const hint = document.createElement("p");
      hint.className = "sidebar-empty-text";
      hint.textContent = "No folder open.";
      wrap.append(hint);

      if (this.cb.onOpenFolder) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sidebar-empty-btn";
        btn.textContent = "Open Folder…";
        btn.addEventListener("click", () => this.cb.onOpenFolder?.());
        wrap.append(btn);

        const note = document.createElement("p");
        note.className = "sidebar-empty-note";
        // Worth saying once, here: the folder is the user's, not Toril's. It is
        // the single most load-bearing promise in §1 and the empty state is the
        // moment someone is deciding whether to point it at a real vault.
        note.textContent =
          "Pick any folder of notes — including an Obsidian vault. Files stay plain Markdown where they are.";
        wrap.append(note);
      }

      this.container.append(wrap);
      return;
    }

    const heading = document.createElement("div");
    heading.className = "sidebar-root";
    heading.textContent = rootName;
    this.container.append(heading);
    this.container.append(this.renderNodes(tree));
  }

  /** Highlight the currently active file by path (no-op if not in the tree). */
  setActivePath(path: string | null): void {
    for (const el of this.container.querySelectorAll<HTMLElement>(".file-entry")) {
      el.dataset.active = String(el.dataset.path === path);
    }
  }

  private renderNodes(nodes: FileNode[]): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "tree";
    for (const node of nodes) {
      ul.append(node.is_dir ? this.renderDir(node) : this.renderFile(node));
    }
    return ul;
  }

  private renderDir(node: FileNode): HTMLElement {
    const li = document.createElement("li");
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = node.name;
    details.append(summary, this.renderNodes(node.children));
    li.append(details);
    return li;
  }

  private renderFile(node: FileNode): HTMLElement {
    const li = document.createElement("li");
    const entry = document.createElement("button");
    entry.className = "file-entry";
    entry.dataset.path = node.path;
    entry.textContent = node.name;
    entry.addEventListener("click", () => this.cb.onOpenFile(node.path));
    li.append(entry);
    return li;
  }
}
