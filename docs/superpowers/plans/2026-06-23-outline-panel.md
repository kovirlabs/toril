# Outline / TOC Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side panel listing the active document's headings (nested by level), with click-to-scroll and active-heading "scroll-spy" highlighting.

**Architecture:** A dedicated `Outline` class mirroring `StatusBar` — pure, unit-tested helpers (`extractHeadings`, `activeHeadingIndex`) plus a thin wiring class that reads the live ProseMirror doc. Works for `.md` and `.html` tabs (same heading nodes). Navigation is a pure selection move, never text insertion (§3.2).

**Tech Stack:** TypeScript (strict), Milkdown/ProseMirror (`@milkdown/kit`), Vitest + jsdom, Rust (Tauri settings).

**Spec:** `docs/superpowers/specs/2026-06-23-outline-panel-design.md`

## Global Constraints

- TS `strict` on; **no `any`** (CLAUDE.md §10).
- All markdown/doc reads go through the live editor doc — never a second text parse (§3.2).
- Navigation moves the selection only; **never inserts markdown text** (§3.2).
- No new dependencies (§2) — use `@milkdown/kit/*` already in the tree.
- Prose imports: `editorViewCtx` from `@milkdown/kit/core`; `TextSelection` from `@milkdown/kit/prose/state`; `Node` from `@milkdown/kit/prose/model`.
- New settings fields are additive: Rust uses `#[serde(default)]` (no `version` bump); existing settings files must still deserialize.
- Conventional commits (`feat:` / `docs:`); commit after each task.
- Heading node: `node.type.name === "heading"`, level at `node.attrs.level`.

---

### Task 1: Pure helpers — `extractHeadings` + `activeHeadingIndex`

**Files:**
- Create: `src/ui/outline.ts`
- Test: `tests/outline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Heading { level: number; text: string; pos: number }`
  - `function extractHeadings(doc: ProseNode): Heading[]` — heading nodes in document order; `pos` is the position *before* the node.
  - `function activeHeadingIndex(headings: Heading[], pos: number): number` — index of the last heading with `pos <= pos`; `-1` if above the first.

- [ ] **Step 1: Write the failing test**

Create `tests/outline.test.ts`:

```ts
// Outline gate (CLAUDE.md §4, §8): heading extraction + active-heading logic.
// extractHeadings runs against a real Milkdown doc (like roundtrip.test.ts);
// activeHeadingIndex is pure. The DOM/scroll-spy wiring is GUI (needs the
// webview), so it is verified on-device, not here.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { activeHeadingIndex, extractHeadings, type Heading } from "../src/ui/outline";

async function makeEditor(md: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, md);
    })
    .use(commonmark)
    .use(gfm)
    .create();
}

function docOf(editor: Editor): ProseNode {
  let doc!: ProseNode;
  editor.action((ctx) => {
    doc = ctx.get(editorViewCtx).state.doc;
  });
  return doc;
}

describe("extractHeadings", () => {
  it("returns headings in order with level, text, and increasing pos", async () => {
    const editor = await makeEditor("# H1\n\n## H2\n\n### H3\n");
    const headings = extractHeadings(docOf(editor));
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings.map((h) => h.text)).toEqual(["H1", "H2", "H3"]);
    expect(headings[0].pos).toBeLessThan(headings[1].pos);
    expect(headings[1].pos).toBeLessThan(headings[2].pos);
    await editor.destroy();
  });

  it("is empty for a document with no headings", async () => {
    const editor = await makeEditor("Just a paragraph.\n");
    expect(extractHeadings(docOf(editor))).toEqual([]);
    await editor.destroy();
  });
});

describe("activeHeadingIndex", () => {
  const hs: Heading[] = [
    { level: 1, text: "A", pos: 5 },
    { level: 2, text: "B", pos: 12 },
    { level: 1, text: "C", pos: 30 },
  ];
  it("is -1 when the position is above the first heading", () => {
    expect(activeHeadingIndex(hs, 2)).toBe(-1);
  });
  it("returns the enclosing heading", () => {
    expect(activeHeadingIndex(hs, 5)).toBe(0); // exactly on the first
    expect(activeHeadingIndex(hs, 8)).toBe(0); // inside the first section
    expect(activeHeadingIndex(hs, 12)).toBe(1); // exactly on the second
  });
  it("returns the last heading for a position past the end", () => {
    expect(activeHeadingIndex(hs, 99)).toBe(2);
  });
  it("is -1 for an empty list", () => {
    expect(activeHeadingIndex([], 10)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/outline.test.ts`
Expected: FAIL — `extractHeadings`/`activeHeadingIndex` not exported from `src/ui/outline`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/ui/outline.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/outline.test.ts`
Expected: PASS (all cases in both `describe` blocks).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/outline.ts tests/outline.test.ts
git commit -m "feat(outline): heading extraction + active-heading helpers"
```

---

### Task 2: The `Outline` class (render, navigate, scroll-spy)

**Files:**
- Modify: `src/ui/outline.ts` (append the class)
- Test: `tests/outline.test.ts` (append a `describe("Outline")` block)

**Interfaces:**
- Consumes: `extractHeadings`, `activeHeadingIndex`, `Heading` from Task 1; `Editor` (`@milkdown/kit/core`).
- Produces:
  - `class Outline` with constructor `(el: HTMLElement, editor: Editor, editorRoot: HTMLElement)` and methods `refresh(): void` and `destroy(): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/outline.test.ts` (add `Outline` to the import from `../src/ui/outline`):

```ts
import { Outline } from "../src/ui/outline";

describe("Outline (render + navigate)", () => {
  it("renders one entry per heading with its text and level", async () => {
    const editor = await makeEditor("# Alpha\n\n## Beta\n");
    const editorRoot = document.createElement("div");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, editorRoot);
    const entries = panel.querySelectorAll<HTMLElement>(".outline-entry");
    expect([...entries].map((e) => e.textContent)).toEqual(["Alpha", "Beta"]);
    expect(entries[0].dataset.level).toBe("1");
    expect(entries[1].dataset.level).toBe("2");
    outline.destroy();
    await editor.destroy();
  });

  it("shows an empty-state when there are no headings", async () => {
    const editor = await makeEditor("Just text.\n");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, document.createElement("div"));
    expect(panel.querySelector(".outline-entry")).toBeNull();
    expect(panel.querySelector(".outline-empty")?.textContent).toBe("No headings");
    outline.destroy();
    await editor.destroy();
  });

  it("moves the selection into the heading when an entry is clicked", async () => {
    const editor = await makeEditor("# Alpha\n\n## Beta\n");
    const editorRoot = document.createElement("div");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, editorRoot);
    const entries = panel.querySelectorAll<HTMLButtonElement>(".outline-entry");
    entries[1].click(); // navigate to "Beta"

    let parentName = "";
    let parentText = "";
    editor.action((ctx) => {
      const { selection } = ctx.get(editorViewCtx).state;
      parentName = selection.$from.parent.type.name;
      parentText = selection.$from.parent.textContent;
    });
    expect(parentName).toBe("heading");
    expect(parentText).toBe("Beta");
    outline.destroy();
    await editor.destroy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/outline.test.ts`
Expected: FAIL — `Outline` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/ui/outline.ts` (and add the two imports at the top of the file):

```ts
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
```

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/outline.test.ts`
Expected: PASS (render, empty-state, and click→selection cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/outline.ts tests/outline.test.ts
git commit -m "feat(outline): Outline panel class with navigate + scroll-spy"
```

---

### Task 3: Mount the panel — DOM, CSS, controller wiring & toggle

**Files:**
- Modify: `app.html`
- Modify: `src/styles.css:131-144` (the `#workspace` grid + sidebar-hidden rules)
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `Outline` from Task 2.
- Produces: a live, toggleable `#outline` panel; module-level `outline` + `outlineVisible`; `toggleOutline()`. (Persistence is Task 4.)

- [ ] **Step 1: Add the panel + toggle button to `app.html`**

In the header `.actions` block, add the toggle button right after `#btn-toggle-sidebar`:

```html
        <button id="btn-toggle-sidebar" title="Toggle Sidebar (Ctrl+\)">☰</button>
        <button id="btn-toggle-outline" title="Toggle Outline (Ctrl+Shift+\)">≣</button>
```

In `#workspace`, add the panel as a sibling **after** `#main`:

```html
      <section id="main">
        <nav id="tabbar"></nav>
        <div id="format-toolbar" class="format-toolbar"></div>
        <div id="searchbar"></div>
        <main id="editor" class="editor"></main>
      </section>
      <aside id="outline"></aside>
    </div>
```

- [ ] **Step 2: Update the grid in `src/styles.css`**

Replace the existing block at lines 131-144:

```css
#workspace {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 0;
}

/* Toggled via Ctrl+\ / the ☰ button; the sidebar collapses to zero width. */
#workspace.sidebar-hidden {
  grid-template-columns: 0 1fr;
}

#workspace.sidebar-hidden #sidebar {
  display: none;
}
```

with (two independent collapsible columns via composable CSS vars):

```css
#workspace {
  display: grid;
  grid-template-columns: var(--sidebar-w, 240px) 1fr var(--outline-w, 220px);
  min-height: 0;
}

/* Two independent toggles compose without a combinatorial rule explosion:
   Ctrl+\ collapses the sidebar, Ctrl+Shift+\ the outline. */
#workspace.sidebar-hidden {
  --sidebar-w: 0;
}

#workspace.outline-hidden {
  --outline-w: 0;
}

#workspace.sidebar-hidden #sidebar,
#workspace.outline-hidden #outline {
  display: none;
}

#outline {
  background: var(--sidebar-bg);
  border-left: 1px solid var(--border);
  overflow: auto;
  padding: 0.5rem;
}

#outline .outline-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

#outline .outline-entry {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0.15rem 0.25rem;
  border-radius: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#outline .outline-entry[data-level="2"] { padding-left: 1rem; }
#outline .outline-entry[data-level="3"] { padding-left: 1.75rem; }
#outline .outline-entry[data-level="4"] { padding-left: 2.5rem; }
#outline .outline-entry[data-level="5"] { padding-left: 3.25rem; }
#outline .outline-entry[data-level="6"] { padding-left: 4rem; }

#outline .outline-entry:hover { background: var(--hover-bg, rgba(127, 127, 127, 0.15)); }
#outline .outline-entry[data-active="true"] { background: var(--active-bg, rgba(127, 127, 127, 0.28)); font-weight: 600; }

#outline .outline-empty {
  color: var(--muted, #888);
  font-size: 0.85rem;
  padding: 0.25rem;
}
```

> Note: `--hover-bg`/`--active-bg`/`--muted` fall back inline, so this works even
> if those variables are not defined per-theme. Match `.sidebar-empty`'s color if
> a `--muted` token already exists in the file — check and reuse it.

- [ ] **Step 3: Construct the panel and add refresh hooks in `src/main.ts`**

Add the import (next to the other `./ui/*` imports):

```ts
import { Outline } from "./ui/outline";
```

Add module-level state (next to `let statusBar`):

```ts
let outline: Outline | null = null;
let outlineVisible = true;
```

Construct it right after the `StatusBar` is created in `DOMContentLoaded`:

```ts
  const docStats = document.querySelector<HTMLElement>("#docstats");
  if (docStats) statusBar = new StatusBar(docStats, editor, editorRoot);
  const outlineEl = document.querySelector<HTMLElement>("#outline");
  if (outlineEl) outline = new Outline(outlineEl, editor, editorRoot);
```

Add `outline?.refresh();` next to each existing `statusBar?.refresh();`:
- in `onActivate` (after `statusBar?.refresh();`)
- in `onEditorChange` (after `statusBar?.refresh();`)

And in `handleWorkspaceChange`, after the reload `loadIntoEditor(...)` line, add:

```ts
    outline?.refresh();
```

- [ ] **Step 4: Add `applyOutline` / `toggleOutline` and the button listener**

Add these functions next to `applySidebar`/`toggleSidebar`:

```ts
/** Apply the outline-panel visibility to the DOM (a class on #workspace drives CSS). */
function applyOutline(): void {
  document.querySelector("#workspace")?.classList.toggle("outline-hidden", !outlineVisible);
  const btn = document.querySelector<HTMLElement>("#btn-toggle-outline");
  if (btn) btn.dataset.active = String(outlineVisible);
}

function toggleOutline(): void {
  outlineVisible = !outlineVisible;
  applyOutline();
  scheduleSessionSave();
}
```

Add the button listener next to the sidebar toggle listener:

```ts
  document.querySelector("#btn-toggle-outline")?.addEventListener("click", () => toggleOutline());
```

- [ ] **Step 5: Add the keyboard shortcut**

In `installShortcuts`, replace the `"\\"` case so Shift toggles the outline:

```ts
      case "\\":
        e.preventDefault();
        if (e.shiftKey) toggleOutline();
        else toggleSidebar();
        break;
```

- [ ] **Step 6: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: no type errors; Vite build succeeds.

- [ ] **Step 7: Run the full frontend suite**

Run: `pnpm test`
Expected: all suites pass (outline + existing).

- [ ] **Step 8: Commit**

```bash
git add app.html src/styles.css src/main.ts
git commit -m "feat(outline): mount panel, wire refresh + toggle (Ctrl+Shift+\\)"
```

---

### Task 4: Persist outline visibility in Settings

**Files:**
- Modify: `src/ipc.ts:154` (the `Settings` interface)
- Modify: `src-tauri/src/settings.rs:37` (the `Settings` struct)
- Modify: `src/main.ts` (`scheduleSessionSave` + `restoreSession`)

**Interfaces:**
- Consumes: `outlineVisible`, `applyOutline` from Task 3.
- Produces: round-tripped `outline_visible` setting.

- [ ] **Step 1: Add the field to the TS `Settings` interface (`src/ipc.ts`)**

Next to `sidebar_visible: boolean | null;` add:

```ts
  outline_visible: boolean | null;
```

- [ ] **Step 2: Add the field to the Rust struct (`src-tauri/src/settings.rs`)**

Next to `pub sidebar_visible: Option<bool>,` add (additive — keep it `Option` with a serde default so existing files still load):

```rust
    #[serde(default)]
    pub outline_visible: Option<bool>,
```

> If `sidebar_visible` already relies on a struct-level `#[serde(default)]` or
> `Default` derive rather than a per-field attribute, match that existing pattern
> instead of adding the per-field attribute — the requirement is only that an old
> settings file without the key still deserializes.

- [ ] **Step 3: Write the field on save (`src/main.ts`)**

In the `settings` object literal inside `scheduleSessionSave`, add after `sidebar_visible: sidebarVisible,`:

```ts
      outline_visible: outlineVisible,
```

- [ ] **Step 4: Restore the field on load (`src/main.ts`)**

In `restoreSession`, right after the `if (settings.sidebar_visible !== null) { ... }` block, add:

```ts
  if (settings.outline_visible !== null) {
    outlineVisible = settings.outline_visible;
    applyOutline();
  }
```

- [ ] **Step 5: Typecheck the frontend**

Run: `pnpm typecheck`
Expected: no errors (the `Settings` literal now satisfies the interface).

- [ ] **Step 6: Verify the Rust settings crate still compiles + tests pass**

Run: `cd src-tauri && cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset && cd ..`
Expected: PASS. (The `settings.rs` change lives in the app crate, which can't link here — §0; this confirms the logic crates are unaffected. The settings struct is verified on-device.)

> If `settings.rs` has a unit test reachable without the webview (e.g. a serde
> round-trip test in the crate), run it too and add an assertion that a JSON blob
> *without* `outline_visible` deserializes to `None`.

- [ ] **Step 7: Run the full frontend suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/ipc.ts src-tauri/src/settings.rs src/main.ts
git commit -m "feat(outline): persist panel visibility in Settings"
```

---

### Task 5 (optional): Native menu item — View → Toggle Outline

> Optional parity with "Toggle Sidebar". The app crate can't link here (§0), so
> this is **verified on-device only** — keep it out if you want every task gate-green
> in this environment. Include it for feature completeness.

**Files:**
- Modify: `src-tauri/src/menu.rs`
- Modify: `src/main.ts` (`handleMenuAction`)

**Interfaces:**
- Consumes: `toggleOutline` from Task 3; the `menu` event channel (§5).
- Produces: a `menu_toggle_outline` menu id routed to `toggleOutline`.

- [ ] **Step 1: Add the menu item in `src-tauri/src/menu.rs`**

Find where the `menu_toggle_sidebar` View item is built and add a sibling item with id `menu_toggle_outline`, label `"Toggle Outline"`, accelerator `"CmdOrCtrl+Shift+\\"` (match the exact builder pattern already used for `menu_toggle_sidebar`).

- [ ] **Step 2: Route it in `src/main.ts`**

In `handleMenuAction`, add a case next to `menu_toggle_sidebar`:

```ts
    case "menu_toggle_outline":
      toggleOutline();
      break;
```

- [ ] **Step 3: Typecheck + format the Rust**

Run: `pnpm typecheck && cd src-tauri && cargo fmt --all && cd ..`
Expected: typecheck clean; `cargo fmt` leaves `menu.rs` formatted.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/menu.rs src/main.ts
git commit -m "feat(outline): add View menu toggle for the outline panel"
```

---

### Task 6: Final verification sweep + ROADMAP tick

**Files:**
- Modify: `ROADMAP.md` (tick branch 11)

- [ ] **Step 1: Run every gate that runs here**

Run:
```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset && cargo fmt --all -- --check && cd ..
```
Expected: all green; `cargo fmt --check` reports no diffs.

- [ ] **Step 2: Tick the roadmap**

In `ROADMAP.md`, change branch 11 from:

```
- [ ] **11. `feat/outline-panel`** — heading outline
```
to:
```
- [x] **11. `feat/outline-panel`** — heading outline
```

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): tick outline-panel (Movement II #11)"
```

- [ ] **Step 4: On-device verification checklist (cannot run here — §0)**

Record these for a webview-capable build (`pnpm tauri dev`):
- Panel lists headings for a `.md` and an `.html` doc; updates as you type.
- Clicking an entry scrolls to and places the caret in that heading.
- The active entry highlights and follows as you scroll / move the caret.
- `Ctrl+Shift+\` and the `≣` button toggle the panel; the choice survives a restart.
- The native View → Toggle Outline item works (if Task 5 was done).

---

## Self-Review

**Spec coverage:**
- Pure helpers `extractHeadings` / `activeHeadingIndex` → Task 1. ✓
- `Outline` class (render, navigate, scroll-spy, two position sources) → Task 2. ✓
- DOM panel + composable-grid CSS + toggle + shortcut → Task 3. ✓
- Refresh hooks (onActivate / onEditorChange / reload) → Task 3 Step 3. ✓
- `outline_visible` persistence (Rust + TS + save/restore) → Task 4. ✓
- Optional menu route → Task 5. ✓
- Gate `tests/outline.test.ts` (extract, active-index, render, click, empty-state) → Tasks 1–2. ✓
- Edge cases: no-headings empty-state (Task 2), HTML tabs (same nodes, free), `posAtCoords` null guard (Task 2 `updateActive`), long-title ellipsis (Task 3 CSS). ✓
- On-device verification note → Task 6 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The two `>` notes (serde-default pattern; `--muted` reuse) are conditional instructions with a concrete default, not placeholders.

**Type consistency:** `Heading { level; text; pos }`, `extractHeadings(doc): Heading[]`, `activeHeadingIndex(headings, pos): number`, `Outline(el, editor, editorRoot)` with `refresh()`/`destroy()` — used identically across Tasks 1–4. Settings field is `outline_visible` (TS `boolean | null`, Rust `Option<bool>`) consistently. CSS class names (`.outline-list`/`.outline-entry`/`.outline-empty`, `data-level`/`data-active`) match between Task 2 (DOM) and Task 3 (CSS).
