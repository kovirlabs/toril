# Design — Outline / TOC Panel

**Branch:** `feat/outline-panel`
**Date:** 2026-06-23
**Roadmap:** Movement II, branch 11 (`feat/outline-panel`) — see `ROADMAP.md`.

## Goal

A heading-outline side panel: list the active document's headings (nested by
level), click an entry to scroll the editor to it, and highlight the heading the
reader is currently in as the caret moves or the editor scrolls ("scroll-spy").
Self-contained, pure-frontend, fully gateable headlessly. Works for `.md` and
`.html` tabs alike because both are the same ProseMirror heading nodes.

Non-negotiables it respects: §3.2 (one canonical doc — the outline reads the live
ProseMirror doc, never a second parse of the text; navigation is a pure selection
move, never text insertion).

## Approach (chosen: A)

A dedicated `Outline` class mirroring `StatusBar` — pure, unit-tested helpers plus
a thin wiring class that reads the live editor doc. Consistent with the codebase,
testable in jsdom, and free for both document formats.

Rejected alternatives:
- **B — a Milkdown/ProseMirror plugin** holding outline state in plugin state.
  More "native" but couples to editor internals and is harder to unit-test in
  isolation. No benefit here.
- **C — regex the markdown text** (`^#+`). Breaks for HTML-format docs, loses the
  exact positions needed for accurate scroll + scroll-spy, and forks the source of
  truth away from the doc (against §3.2). Rejected.

## Components & files

| File | Change |
|---|---|
| `src/ui/outline.ts` | **New.** Pure helpers `extractHeadings(doc)` + `activeHeadingIndex(headings, pos)`, and the `Outline` class, constructed `(el, editor, editorRoot)` like `StatusBar`. |
| `app.html` | Add `<aside id="outline">` in `#workspace` after `#main`; add a header toggle button `#btn-toggle-outline`. |
| `src/styles.css` | `#workspace` → 3-column via composable CSS vars; `#outline` panel + entry + empty-state styling. |
| `src/main.ts` | Construct `Outline`; `toggleOutline()`; refresh hooks; settings wiring; shortcut; optional menu route. |
| `src/ipc.ts` | Add `outline_visible: boolean \| null` to `Settings`. |
| `src-tauri/src/settings.rs` | Add `outline_visible: Option<bool>` with `#[serde(default)]`. |
| `src-tauri/src/menu.rs` + `handleMenuAction` | Optional `menu_toggle_outline` (parity with Toggle Sidebar). |
| `tests/outline.test.ts` | **New gate** (jsdom + real Milkdown, like `roundtrip`/`statusbar`). |

## Pure core (the unit-tested part)

```ts
interface Heading {
  level: number; // 1–6
  text: string;  // node.textContent
  pos: number;   // position *before* the heading node
}

// Walk heading nodes in document order.
function extractHeadings(doc: Node): Heading[];

// Index of the last heading whose pos <= the given position; -1 if the position
// is above the first heading. Drives scroll-spy and is fully pure.
function activeHeadingIndex(headings: Heading[], pos: number): number;
```

## The `Outline` class

- Constructor `(el: HTMLElement, editor: Editor, editorRoot: HTMLElement)` — same
  shape as `StatusBar`.
- `refresh()`: extract headings, render the list (buttons indented by `level`),
  then update the active highlight. Called by the controller on structural change
  (edit / tab switch / reload).
- `updateActive()`: compute a position, run `activeHeadingIndex`, toggle a
  `data-active` attribute on entries. No re-extraction; `requestAnimationFrame`-
  debounced exactly like `StatusBar`.
- Listeners (for scroll-spy only): `editorRoot` `scroll`, plus `keyup` / `mouseup`
  / `document` `selectionchange` — the same set `StatusBar` uses, each scheduling
  an `updateActive()`.
- Click → **navigate**:
  ```ts
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1)));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
  ```
  Pure selection move + scroll; never inserts text (§3.2-clean).
- `destroy()`: remove listeners, cancel any pending rAF.

### Scroll-spy position source

`activeHeadingIndex` is fed two position sources by the wiring, keeping the
decision logic pure:
- on `selectionchange`/`keyup`/`mouseup` → the **caret** position;
- on `scroll` → the doc position at the top of the viewport via
  `view.posAtCoords({ left, top })` (the only view-dependent line; guarded for a
  `null` result).

## Layout, toggle, persistence

- **Composable grid (small, justified refactor).** Today `#workspace` hard-codes
  `grid-template-columns: 240px 1fr` with a `.sidebar-hidden` override. Adding a
  second collapsible panel, switch to:
  ```css
  #workspace { grid-template-columns: var(--sidebar-w, 240px) 1fr var(--outline-w, 220px); }
  #workspace.sidebar-hidden { --sidebar-w: 0; }
  #workspace.outline-hidden { --outline-w: 0; }
  ```
  Two independent toggles compose without a 4-combo rule explosion. Hidden panels
  also get `overflow: hidden` (as `#sidebar` already does).
- **Toggle** `toggleOutline()` mirrors `toggleSidebar()`: header button +
  shortcut **`Ctrl/Cmd+Shift+\`** (next to the sidebar's `Ctrl+\`) + persisted.
- **Persistence:** `outline_visible` added to `Settings` in both Rust
  (`Option<bool>`, `#[serde(default)]` so existing settings files still
  deserialize — no version bump) and TS; wired into `scheduleSessionSave` and
  `restoreSession` exactly like `sidebar_visible`.

## Refresh wiring (main.ts)

Add `outline?.refresh()` wherever `statusBar?.refresh()` already fires:
`onActivate` (tab switch), `onEditorChange` (edit), and the reload branch in
`handleWorkspaceChange`. Same lifecycle, no new plumbing.

## Edge cases

- No headings → "No headings" empty-state (like the sidebar's "No folder open").
- Duplicate heading text → fine; entries are keyed by index/pos, not text.
- Long titles → CSS ellipsis (`text-overflow: ellipsis`).
- HTML-format tabs → identical behavior (same heading nodes).
- `posAtCoords` returning `null` (e.g. empty editor) → skip the scroll update.

## Gate — `tests/outline.test.ts`

jsdom + real Milkdown, like `roundtrip`/`statusbar`:
- `extractHeadings`: H1/H2/H3 doc → correct `level`/`text`/order/`pos`; empty doc → `[]`.
- `activeHeadingIndex`: above first → `-1`; inside a section → that heading;
  exactly on a heading → that heading; after the last → the last.
- Render reflects the headings; clicking an entry moves the selection to that
  heading's position; the empty-state shows when there are no headings.

## Out of scope (YAGNI)

No drag-reorder, no collapse/fold, no auto-numbering, no per-heading context menu.
Just navigate + scroll-spy.

## Verification note

Logic is gated headlessly here. The visual feel of scroll-spy (highlight follows
scroll smoothly) wants an on-device check on a webview-capable build — consistent
with the standing §0 "on-device GUI verification" caveat; not a blocker for the
gate.
