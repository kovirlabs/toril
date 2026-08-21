// Sidebar file-operations gate (CLAUDE.md §8, ROADMAP Movement II.12).
//
// What the sidebar owns is the *interaction*, so that is what is pinned here:
// which operations the menu offers, that a rejected name keeps the field open
// with the message rather than silently doing nothing, that blur cancels rather
// than commits, and that a background refresh cannot delete what the user is
// typing. The rules the operations are judged against live in `crates/fileops`
// and are tested there; the disk itself is never touched from this file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu } from "../src/ui/contextmenu";
import { Sidebar, type SidebarCallbacks } from "../src/ui/sidebar";
import type { FileNode } from "../src/ipc";

const ROOT = "/vault";

function file(name: string, dir = ROOT): FileNode {
  return { name, path: `${dir}/${name}`, is_dir: false, children: [] };
}

function folder(name: string, children: FileNode[], dir = ROOT): FileNode {
  return { name, path: `${dir}/${name}`, is_dir: true, children };
}

function mount(cb: Partial<SidebarCallbacks> = {}, tree: FileNode[] = [file("note.md")]) {
  const container = document.createElement("div");
  document.body.append(container);
  const sidebar = new Sidebar(container, { onOpenFile: () => {}, ...cb });
  sidebar.setRoot("vault", tree, ROOT);
  return { sidebar, container };
}

function rightClick(el: Element): void {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
}

function menuLabels(): string[] {
  return Array.from(document.querySelectorAll(".context-menu-item")).map(
    (b) => b.textContent ?? "",
  );
}

function clickMenu(label: string): void {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".context-menu-item"),
  ).find((b) => b.textContent === label);
  if (!item) throw new Error(`no menu item "${label}" (have: ${menuLabels().join(", ")})`);
  item.click();
}

function field(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".sidebar-edit-input");
  if (!input) throw new Error("no name field is open");
  return input;
}

function typeAndConfirm(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

/** Let the awaited callback inside `commit` settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  closeContextMenu();
  document.body.replaceChildren();
});

describe("the tree", () => {
  it("renders files and folders, and opens a file on click", () => {
    const onOpenFile = vi.fn();
    const { container } = mount({ onOpenFile }, [folder("sub", [file("deep.md", "/vault/sub")])]);

    const entry = container.querySelector<HTMLElement>(".file-entry");
    expect(entry?.textContent).toBe("deep.md");
    entry?.click();
    expect(onOpenFile).toHaveBeenCalledWith("/vault/sub/deep.md");
  });
});

describe("the context menu", () => {
  /**
   * The empty state already follows this rule for Open Folder: a control that
   * looks live and does nothing is worse than an absent one. It matters more
   * here, because the absent handler would be Delete.
   */
  it("offers only the operations that are wired", () => {
    const { container } = mount({});
    rightClick(container.querySelector(".file-entry")!);
    expect(menuLabels()).toEqual(["Open"]);

    closeContextMenu();
    document.body.replaceChildren();

    const wired = mount({ onRename: vi.fn(), onDelete: vi.fn() });
    rightClick(wired.container.querySelector(".file-entry")!);
    expect(menuLabels()).toEqual(["Open", "Rename…", "Delete"]);
  });

  it("offers creation on a folder, and on the workspace root", () => {
    const { container } = mount(
      { onCreateNote: vi.fn(), onCreateFolder: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() },
      [folder("sub", [file("deep.md", "/vault/sub")])],
    );

    rightClick(container.querySelector("summary")!);
    expect(menuLabels()).toEqual(["New Note…", "New Folder…", "Rename…", "Delete"]);

    closeContextMenu();
    rightClick(container.querySelector(".sidebar-root")!);
    // The root is the folder the user opened: it can be added to, but Toril has
    // no business renaming or trashing it from inside the tree.
    expect(menuLabels()).toEqual(["New Note…", "New Folder…"]);
  });

  it("marks Delete as destructive", () => {
    const { container } = mount({ onDelete: vi.fn() });
    rightClick(container.querySelector(".file-entry")!);

    const del = Array.from(
      document.querySelectorAll<HTMLElement>(".context-menu-item"),
    ).find((b) => b.textContent === "Delete");
    expect(del?.dataset.danger).toBe("true");
  });

  it("passes is_dir so the caller can find every tab under a folder", () => {
    const onDelete = vi.fn();
    const { container } = mount({ onDelete }, [folder("sub", [file("deep.md", "/vault/sub")])]);

    rightClick(container.querySelector("summary")!);
    clickMenu("Delete");

    expect(onDelete).toHaveBeenCalledWith("/vault/sub", true);
  });
});

describe("creating", () => {
  it("creates a note in the folder that was right-clicked", async () => {
    const onCreateNote = vi.fn().mockResolvedValue(undefined);
    const { container } = mount({ onCreateNote }, [
      folder("sub", [file("deep.md", "/vault/sub")]),
    ]);

    rightClick(container.querySelector("summary")!);
    clickMenu("New Note…");
    typeAndConfirm(field(container), "Ideas");
    await settle();

    expect(onCreateNote).toHaveBeenCalledWith("/vault/sub", "Ideas");
    expect(container.querySelector(".sidebar-edit-input")).toBeNull();
  });

  it("creates at the root from the header button", async () => {
    const onCreateNote = vi.fn().mockResolvedValue(undefined);
    const { container } = mount({ onCreateNote });

    container.querySelector<HTMLButtonElement>(".sidebar-root-btn")?.click();
    typeAndConfirm(field(container), "Ideas");
    await settle();

    expect(onCreateNote).toHaveBeenCalledWith(ROOT, "Ideas");
  });

  it("pre-fills a suggested name without overwriting what is already typed", async () => {
    let release!: (name: string) => void;
    const suggestName = vi.fn(() => new Promise<string>((r) => (release = r)));
    const { container } = mount({ onCreateNote: vi.fn(), suggestName });

    container.querySelector<HTMLButtonElement>(".sidebar-root-btn")?.click();
    const input = field(container);
    // The user does not wait for the round trip.
    input.value = "Ideas";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    release("Untitled 2.md");
    await settle();

    expect(input.value).toBe("Ideas");
  });

  it("fills in the suggestion when the field is still untouched", async () => {
    const suggestName = vi.fn().mockResolvedValue("Untitled 2.md");
    const { container } = mount({ onCreateNote: vi.fn(), suggestName });

    container.querySelector<HTMLButtonElement>(".sidebar-root-btn")?.click();
    await settle();

    expect(field(container).value).toBe("Untitled 2.md");
  });

  it("refuses an empty name without calling the backend", async () => {
    const onCreateNote = vi.fn();
    const { container } = mount({ onCreateNote });

    container.querySelector<HTMLButtonElement>(".sidebar-root-btn")?.click();
    typeAndConfirm(field(container), "   ");
    await settle();

    expect(onCreateNote).not.toHaveBeenCalled();
    expect(container.querySelector(".sidebar-edit-error")?.textContent).toBe("Enter a name.");
  });
});

describe("renaming", () => {
  it("sends the new name and closes the field", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    expect(field(container).value).toBe("note.md");

    typeAndConfirm(field(container), "renamed.md");
    await settle();

    expect(onRename).toHaveBeenCalledWith("/vault/note.md", "renamed.md");
  });

  it("treats an unchanged name as a cancel, not a rename", async () => {
    const onRename = vi.fn();
    const { container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    typeAndConfirm(field(container), "note.md");
    await settle();

    // A no-op rename that reached Rust would still be a write in the eyes of the
    // watcher, and would show up as a change to a file nothing changed.
    expect(onRename).not.toHaveBeenCalled();
    expect(container.querySelector(".sidebar-edit-input")).toBeNull();
  });

  it("keeps the field open with the message when the backend refuses", async () => {
    const onRename = vi.fn().mockRejectedValue('"CON" is a reserved name on Windows.');
    const { container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    typeAndConfirm(field(container), "CON.md");
    await settle();

    expect(container.querySelector(".sidebar-edit-error")?.textContent).toBe(
      '"CON" is a reserved name on Windows.',
    );
    // Still editable, and still holding what was typed — a rejected name should
    // cost a keystroke, not the whole interaction.
    expect(field(container).value).toBe("CON.md");
  });

  it("Escape cancels without renaming", async () => {
    const onRename = vi.fn();
    const { container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    const input = field(container);
    input.value = "half-typed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect(onRename).not.toHaveBeenCalled();
    expect(container.querySelector(".file-entry")?.textContent).toBe("note.md");
  });

  /**
   * Blur must **cancel**. Committing on blur is how a half-typed name becomes a
   * real rename because the user clicked somewhere else — and unlike a cancel,
   * that one touches the filesystem on an action nobody confirmed.
   */
  it("blur cancels rather than committing", async () => {
    const onRename = vi.fn();
    const { container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    const input = field(container);
    input.value = "half-typed";
    input.dispatchEvent(new Event("blur", { bubbles: false }));
    await settle();

    expect(onRename).not.toHaveBeenCalled();
    expect(container.querySelector(".sidebar-edit-input")).toBeNull();
  });
});

describe("refreshes while a name is being typed", () => {
  /**
   * The controller refreshes the tree on every watcher event, so a sync daemon
   * touching an unrelated file mid-rename would otherwise re-render the field
   * out from under the user and lose what they had typed.
   */
  it("defers the new tree until the edit ends, then applies it", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { sidebar, container } = mount({ onRename });

    rightClick(container.querySelector(".file-entry")!);
    clickMenu("Rename…");
    const input = field(container);
    input.value = "half-typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    sidebar.setRoot("vault", [file("note.md"), file("arrived.md")], ROOT);

    expect(sidebar.isEditing()).toBe(true);
    expect(field(container).value).toBe("half-typed");
    expect(container.textContent).not.toContain("arrived.md");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();

    expect(sidebar.isEditing()).toBe(false);
    expect(container.textContent).toContain("arrived.md");
  });
});
