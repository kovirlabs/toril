// Workspace file tree (CLAUDE.md §4). Renders the FileNode[] from `open_folder`
// as a collapsible tree; clicking a markdown file asks the controller to open
// it. Folders use native <details> for zero-JS collapse.
//
// File operations (ROADMAP Movement II.12) live here as *UX only*: the context
// menu, the inline name field, and where an error message lands. Every rule that
// decides whether an operation is allowed — name validation, vault containment,
// refusing to clobber — is in `crates/fileops`, and every disk write is a Rust
// command (§10). Nothing in this file may be the only thing standing between a
// bad name and the filesystem.
import { openContextMenu, type MenuEntry } from "./contextmenu";
import type { FileNode } from "../ipc";

/**
 * Callbacks the controller supplies. The file-operation ones are **optional**,
 * and the menu offers only what is wired — the same rule the empty state already
 * follows: a dead control that looks live is worse than an absent one.
 *
 * The operation callbacks may reject. The sidebar catches, shows the message
 * beside the still-open name field, and lets the user correct it — so a rejected
 * name costs a keystroke rather than the whole interaction.
 */
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
  /** Create an empty note called `name` in `dir`. */
  onCreateNote?(dir: string, name: string): Promise<void>;
  /** Create a folder called `name` in `parent`. */
  onCreateFolder?(parent: string, name: string): Promise<void>;
  /** Rename the entry at `path` to `newName`, in the same parent. */
  onRename?(path: string, newName: string): Promise<void>;
  /** Delete (soft, to trash) the entry at `path`. */
  onDelete?(path: string, isDir: boolean): void;
  /** A note name not already taken in `dir`, to pre-fill the field with. */
  suggestName?(dir: string): Promise<string>;
}

/** What the open inline field is for. */
type EditKind = "note" | "folder" | "rename";

interface EditState {
  kind: EditKind;
  /** Container the new entry goes in (create), or the entry's parent (rename). */
  dir: string;
  /** The entry being renamed. Absent for creates. */
  target?: { path: string; name: string };
  /** Current field text, so a re-open after a rejected name keeps it. */
  value: string;
  error: string | null;
}

export class Sidebar {
  private rootName: string | null = null;
  private rootPath: string | null = null;
  private tree: FileNode[] = [];
  private edit: EditState | null = null;
  /**
   * A tree that arrived while a name was being typed.
   *
   * The controller refreshes on every watcher event, and a sync daemon touching
   * an unrelated file mid-rename would otherwise re-render the field out from
   * under the user, losing what they had typed. Deferring is safe because the
   * delay is bounded by the edit: confirming or cancelling flushes immediately,
   * and the operation itself triggers a fresh refresh straight after.
   */
  private pendingTree: { rootName: string | null; rootPath: string | null; tree: FileNode[] } | null =
    null;
  private activePath: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: SidebarCallbacks,
  ) {}

  /**
   * Render a workspace, or an empty-state hint when no folder is open.
   *
   * `rootPath` is what the file operations need — a new note has to be created
   * *somewhere*, and the root heading is a legitimate target.
   */
  setRoot(rootName: string | null, tree: FileNode[], rootPath: string | null = null): void {
    if (this.edit) {
      this.pendingTree = { rootName, rootPath, tree };
      return;
    }
    this.rootName = rootName;
    this.rootPath = rootPath;
    this.tree = tree;
    this.render();
  }

  /** Highlight the currently active file by path (no-op if not in the tree). */
  setActivePath(path: string | null): void {
    this.activePath = path;
    this.applyActive();
  }

  /** Whether an inline name field is currently open (renders are deferred while it is). */
  isEditing(): boolean {
    return this.edit !== null;
  }

  private applyActive(): void {
    for (const el of this.container.querySelectorAll<HTMLElement>(".file-entry")) {
      el.dataset.active = String(el.dataset.path === this.activePath);
    }
  }

  private render(): void {
    this.container.replaceChildren();

    if (this.rootName === null) {
      this.container.append(this.renderEmptyState());
      return;
    }

    this.container.append(this.renderHeading(this.rootName));
    this.container.append(this.renderNodes(this.tree, this.rootPath));
    this.mountEditor();
    this.applyActive();
  }

  private renderEmptyState(): HTMLElement {
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
    return wrap;
  }

  private renderHeading(rootName: string): HTMLElement {
    const heading = document.createElement("div");
    heading.className = "sidebar-root";

    const label = document.createElement("span");
    label.className = "sidebar-root-name";
    label.textContent = rootName;
    heading.append(label);

    const root = this.rootPath;
    if (root !== null) {
      // Buttons as well as the context menu: right-click is invisible, and a
      // brand-new note is the one operation someone needs on their first minute
      // in a folder.
      if (this.cb.onCreateNote) {
        heading.append(
          this.iconButton("New note", "＋", () => this.beginEdit({ kind: "note", dir: root })),
        );
      }
      if (this.cb.onCreateFolder) {
        heading.append(
          this.iconButton("New folder", "🗀", () => this.beginEdit({ kind: "folder", dir: root })),
        );
      }
      heading.addEventListener("contextmenu", (e) => this.openMenuForFolder(e, root, null));
    }
    return heading;
  }

  private iconButton(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sidebar-root-btn";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    // The glyph is decorative — the accessible name comes from aria-label, and
    // announcing "plus sign" after it would be noise.
    btn.textContent = glyph;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private renderNodes(nodes: FileNode[], dir: string | null): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "tree";
    // Marks which folder this list belongs to, so an inline "new note" field can
    // be mounted into the right one after a render.
    if (dir !== null) ul.dataset.dir = dir;
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
    summary.dataset.path = node.path;
    summary.addEventListener("contextmenu", (e) => this.openMenuForFolder(e, node.path, node));
    details.append(summary, this.renderNodes(node.children, node.path));
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
    entry.addEventListener("contextmenu", (e) => this.openMenuForFile(e, node));
    li.append(entry);
    return li;
  }

  // ---- context menus -------------------------------------------------------

  /**
   * Menu coordinates. A `contextmenu` event raised from the keyboard (Shift+F10,
   * the menu key) carries no pointer position and reports 0,0 — anchoring to the
   * row's own box puts the menu where the user is looking instead of the corner
   * of the window.
   */
  private menuPosition(e: MouseEvent): { x: number; y: number } {
    if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
    const target = e.currentTarget;
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom };
    }
    return { x: 0, y: 0 };
  }

  private openMenuForFile(e: MouseEvent, node: FileNode): void {
    e.preventDefault();
    e.stopPropagation();
    const dir = parentDir(node.path);
    const entries: MenuEntry[] = [
      { label: "Open", onSelect: () => this.cb.onOpenFile(node.path) },
    ];
    if (this.cb.onRename) {
      entries.push({
        label: "Rename…",
        onSelect: () =>
          this.beginEdit({ kind: "rename", dir, target: { path: node.path, name: node.name } }),
      });
    }
    if (this.cb.onDelete) {
      entries.push("separator", {
        label: "Delete",
        danger: true,
        title: "Move to the workspace .trash folder — this can be undone",
        onSelect: () => this.cb.onDelete?.(node.path, false),
      });
    }
    openContextMenu({ ...this.menuPosition(e), entries });
  }

  /** `node` is null for the workspace root, which can be added to but not renamed. */
  private openMenuForFolder(e: MouseEvent, path: string, node: FileNode | null): void {
    e.preventDefault();
    e.stopPropagation();
    const entries: MenuEntry[] = [];
    if (this.cb.onCreateNote) {
      entries.push({
        label: "New Note…",
        onSelect: () => this.beginEdit({ kind: "note", dir: path }),
      });
    }
    if (this.cb.onCreateFolder) {
      entries.push({
        label: "New Folder…",
        onSelect: () => this.beginEdit({ kind: "folder", dir: path }),
      });
    }
    if (node) {
      if (this.cb.onRename) {
        entries.push("separator", {
          label: "Rename…",
          onSelect: () =>
            this.beginEdit({
              kind: "rename",
              dir: parentDir(node.path),
              target: { path: node.path, name: node.name },
            }),
        });
      }
      if (this.cb.onDelete) {
        if (!this.cb.onRename) entries.push("separator");
        entries.push({
          label: "Delete",
          danger: true,
          title: "Move the folder and everything in it to .trash — this can be undone",
          onSelect: () => this.cb.onDelete?.(node.path, true),
        });
      }
    }
    if (entries.length === 0) return;
    openContextMenu({ ...this.menuPosition(e), entries });
  }

  // ---- the inline name field ----------------------------------------------

  private beginEdit(edit: Omit<EditState, "value" | "error"> & { value?: string }): void {
    this.edit = {
      ...edit,
      value: edit.value ?? edit.target?.name ?? "",
      error: null,
    };
    this.render();

    // A create field starts empty and is filled in asynchronously, so the user
    // can begin typing immediately and a slow suggestion never overwrites what
    // they typed — checked against the field's *current* value, not the state's.
    if (edit.kind === "note" && this.cb.suggestName && !edit.value) {
      const dir = edit.dir;
      void this.cb.suggestName(dir).then((name) => {
        const input = this.fieldInput();
        if (!this.edit || this.edit.kind !== "note" || this.edit.dir !== dir) return;
        if (!input || input.value !== "") return;
        input.value = name;
        this.edit.value = name;
        selectStem(input);
      });
    }
  }

  private endEdit(): void {
    this.edit = null;
    const pending = this.pendingTree;
    this.pendingTree = null;
    if (pending) {
      this.rootName = pending.rootName;
      this.rootPath = pending.rootPath;
      this.tree = pending.tree;
    }
    this.render();
  }

  private fieldInput(): HTMLInputElement | null {
    return this.container.querySelector<HTMLInputElement>(".sidebar-edit-input");
  }

  /**
   * Put the field into the rendered tree.
   *
   * Called after every render so the field survives one — a create is mounted
   * into its folder's list, a rename replaces the row it renames. If the anchor
   * is missing (the folder disappeared from under us) the edit is abandoned
   * rather than mounted somewhere arbitrary.
   */
  private mountEditor(): void {
    const edit = this.edit;
    if (!edit) return;

    const field = this.buildField(edit);

    if (edit.kind === "rename" && edit.target) {
      const row =
        this.container.querySelector<HTMLElement>(`.file-entry[data-path="${cssEscape(edit.target.path)}"]`) ??
        this.container.querySelector<HTMLElement>(`summary[data-path="${cssEscape(edit.target.path)}"]`);
      if (!row) {
        this.edit = null;
        return;
      }
      row.replaceWith(field);
    } else {
      const list = this.container.querySelector<HTMLElement>(
        `ul[data-dir="${cssEscape(edit.dir)}"]`,
      );
      if (!list) {
        this.edit = null;
        return;
      }
      const li = document.createElement("li");
      li.append(field);
      list.prepend(li);
      // A collapsed folder would hide the field the user is typing into.
      const details = list.closest("details");
      if (details) details.open = true;
    }

    const input = field.querySelector("input");
    input?.focus();
    if (input) selectStem(input);
  }

  private buildField(edit: EditState): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sidebar-edit";
    wrap.dataset.kind = edit.kind;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "sidebar-edit-input";
    input.value = edit.value;
    input.spellcheck = false;
    input.setAttribute(
      "aria-label",
      edit.kind === "rename" ? `Rename ${edit.target?.name ?? ""}` : `Name of the new ${edit.kind}`,
    );
    input.addEventListener("input", () => {
      if (this.edit) this.edit.value = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.commit(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Escape must not also reach the global keymap (which closes panes).
        e.stopPropagation();
        this.endEdit();
      }
    });
    // Blur **cancels** rather than commits. Committing on blur is how a
    // half-typed name becomes a real rename because someone clicked away; the
    // cost of cancelling is retyping, which is recoverable, and this direction
    // never touches the filesystem on an action the user did not confirm.
    //
    // `isConnected` distinguishes the user leaving the field from the field
    // being replaced by a re-render — showing an error rebuilds it, and treating
    // that as a cancel would wipe the message the moment it appeared.
    input.addEventListener("blur", () => {
      if (!input.isConnected) return;
      if (this.edit && !this.busy) this.endEdit();
    });
    wrap.append(input);

    if (edit.error) {
      const err = document.createElement("div");
      err.className = "sidebar-edit-error";
      err.setAttribute("role", "alert");
      err.textContent = edit.error;
      wrap.append(err);
    }
    return wrap;
  }

  /**
   * True while an operation is in flight.
   *
   * Guards two things: the blur handler (the field loses focus while the awaited
   * command runs, and that must not read as a cancel), and double submission
   * from a second Enter before the first resolves — which for a create would be
   * a second create attempt against a path the first one is making.
   */
  private busy = false;

  private async commit(value: string): Promise<void> {
    const edit = this.edit;
    if (!edit || this.busy) return;

    const name = value.trim();
    if (name === "") {
      this.showError("Enter a name.");
      return;
    }
    // A rename to the same name is a no-op the backend also accepts; short-
    // circuiting here keeps it from showing up as a save in version history.
    if (edit.kind === "rename" && name === edit.target?.name) {
      this.endEdit();
      return;
    }

    this.busy = true;
    try {
      if (edit.kind === "note") await this.cb.onCreateNote?.(edit.dir, name);
      else if (edit.kind === "folder") await this.cb.onCreateFolder?.(edit.dir, name);
      else if (edit.target) await this.cb.onRename?.(edit.target.path, name);
      this.busy = false;
      this.endEdit();
    } catch (e) {
      this.busy = false;
      this.showError(messageOf(e));
    }
  }

  /** Re-render the field with an error beside it, keeping what was typed. */
  private showError(error: string): void {
    if (!this.edit) return;
    this.edit.error = error;
    this.render();
  }
}

/** The containing directory of `path`, using whichever separator it carries. */
function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * Select the name but not the extension, so typing replaces `note` in `note.md`.
 *
 * The convention every file manager uses, and it matters more here: the field is
 * pre-filled with a full file name, and a plain select-all means renaming
 * usually starts by retyping `.md`.
 */
function selectStem(input: HTMLInputElement): void {
  const dot = input.value.lastIndexOf(".");
  // `setSelectionRange` is not implemented for every input type in every engine;
  // a failure here costs a nicety, never the rename.
  try {
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  } catch {
    /* selection is cosmetic */
  }
}

/**
 * Quote a path for use inside an attribute selector.
 *
 * Paths are arbitrary user data and Windows paths are full of backslashes, which
 * a selector reads as escapes. `CSS.escape` is the correct tool and exists in
 * both webview engines; the fallback keeps this working under a bare jsdom that
 * has not implemented it.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** The user-facing text of a rejection, which from Tauri is a plain string. */
function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
