# UI/UX Chrome Rework — Design

**Date:** 2026-08-12
**Branch:** `feat/chrome-ux`
**Status:** approved, in implementation

---

## 1. Problem

Toril's editing surface is good; the chrome around it has never had a pass. Concretely,
found by driving the running app rather than by reading the source:

1. **Collapse/expand has no animation, and cannot have one.** Panes hide with
   `display: none` alongside a zeroed width variable. `display: none` cancels
   transitions, so every toggle is a hard snap. This is absent behavior, not broken
   behavior.
2. **Panes cannot be resized.** Widths are fixed (`240px` / `220px` / `240px`).
3. **Hover and selection are the same color.** `.file-entry:hover` and
   `.file-entry[data-active="true"]` both resolve to `--active-bg`, so the pointer's
   position is indistinguishable from the selection. Separately, `--hover-bg` is
   referenced by the outline and history panes but never defined, silently falling
   back to a hardcoded grey.
4. **Four rails can be open at once.** Sidebar 240 + outline 220 + history 240 = 700px
   of chrome. On a Surface Pro at ~1280 logical px that leaves 580px for an editor
   whose measure is 720px. (This is the "right-rail coexistence undecided" question.)
5. **The toolbar duplicates the native menu.** All eleven command buttons already exist
   as menu items. Three stacked bars cost ~110px above the first line of text.
6. **Menu accelerators are fake.** `menu.rs` bakes shortcuts into label *text*
   (`"New (Ctrl+N)"`) rather than registering accelerators, because the frontend
   keydown handler would otherwise double-fire. Windows renders real accelerators
   right-aligned in grey; Toril shows a literal parenthetical, left-aligned.
7. **The font stack is an accident.** `Inter, Avenir, Helvetica, Arial, sans-serif`
   names Inter, but Inter is not a dependency and there is no `@font-face`. Verified by
   probe: Inter ✗, Avenir ✗, Helvetica ✓. Windows aliases Helvetica to Arial, so
   **Toril renders its UI in Arial on its primary target platform** and never reaches
   Segoe UI.
8. **Task-list checkboxes do not render.** `- [x]` shows as a plain bullet. The document
   model is intact (`data-item-type="task"`, `data-checked="true"`), so this is a
   missing CSS rule, *not* a round-trip or data-safety defect.

## 2. Decisions

| Question | Decision |
|---|---|
| Scope | Full chrome rework — layout, motion, and visual language |
| Right rail | **One tabbed rail.** Outline and History are alternatives, never simultaneous |
| Toolbar | **Two bars.** Drop the eleven duplicate command buttons; pane toggles flank the tab row |
| Touch | **Adaptive.** Compact by default; ≥40px targets under `pointer: coarse` |
| Pen | **Explicitly out of scope** (user decision) — which is why the rule keys on `pointer`, not `any-pointer` |
| Motion | **Restrained:** 140–180ms, ease-out, user-initiated changes only |
| Reduced motion | Non-negotiable; a single token override, not per-rule guards |

## 3. Architecture

### 3.1 Style layer

`styles.css` is 730 lines doing five jobs. Split it, keeping `src/styles.css` as the
entry point so the §4 path in CLAUDE.md stays valid:

```
src/styles/tokens.css    palettes, space/size/motion/type scales
src/styles/chrome.css    toolbar, tab row, rails, statusbar
src/styles/editor.css    Milkdown surface, prose, task lists
src/styles.css           @imports the three
```

Typography becomes two tokens, deliberately separate — an editor's UI type and its
prose type have different jobs, and splitting them now makes changing the writing
face later a one-line edit:

```css
--font-ui:    system-ui, "Segoe UI", -apple-system, "Noto Sans", sans-serif;
--font-prose: var(--font-ui);
```

`system-ui` resolves to Segoe UI Variable on Win11, San Francisco on macOS, and the
desktop default on Linux — with no bundled webfont, no new dependency (§2), and no
network fetch (this is an offline app).

Sizing is one token with a pointer-aware override, so touch adaptation is a single
rule rather than a decision repeated per component:

```css
--target: 28px;
@media (pointer: coarse) { :root { --target: 40px; } }
```

`pointer: coarse` (primary pointer) rather than `any-pointer: coarse`: a Surface Pro
with the keyboard attached reports a coarse pointer as *available* while the primary
input is precise. Keying on the primary pointer keeps the docked experience dense and
expands targets only in tablet mode.

Motion likewise, with reduced-motion as one override:

```css
--dur-fast: 140ms;  --dur-base: 180ms;  --ease: cubic-bezier(0.2, 0, 0, 1);
@media (prefers-reduced-motion: reduce) { :root { --dur-fast: 0ms; --dur-base: 0ms; } }
```

### 3.2 Layout

```
#workspace  grid: var(--sidebar-w) 1fr var(--rail-w)
├─ #sidebar          file tree
├─ #main             tab row (☰ · tabs · ≡ ⟲) / format bar / search / conflict / editor
└─ #rail             tab strip → one panel host
   ├─ #outline       existing module, unchanged
   └─ #history       existing module, unchanged
```

Four grid columns become three. `outline.ts` and `history.ts` are **not rewritten** —
the rail owns *which panel is visible*, the panels own *their content*. That boundary
is what keeps this a chrome change rather than a panel rewrite.

### 3.3 New modules

| Module | Purpose | Headless gate |
|---|---|---|
| `src/ui/panes.ts` *new* | Pure pane state: visibility, widths, active rail tab, restore clamping. No DOM, no IPC. | `tests/panes.test.ts` |
| `src/ui/resizer.ts` *new* | Drag-to-resize: pure clamp/snap geometry + thin DOM binding | `tests/resizer.test.ts` |
| `src/ui/rail.ts` *new* | Tab strip, panel host, activation | jsdom |
| `src/ui/tabs.ts` *mod* | Flanking toggle slots | existing suite |
| `src/ui/toolbar.ts` *mod* | Restyle + grouping; **command layer untouched** | existing §8 gate |

This mirrors the project's established split — `sync.ts`, `paths.ts`, `mergemd` — where
decision logic is pure and gated, and only the glue is verified on-device.

### 3.4 Data flow

`panes.ts` holds truth in memory → `main.ts` writes CSS custom properties on
`#workspace` → debounced persist into `Settings` → restored at boot **with a clamp**, so
a width saved on a 4K monitor cannot exceed a Surface Pro's viewport.

### 3.5 The `display: none` fix

`display: none` is there for a correct reason: a hidden pane must not be focusable or
reachable by a screen reader. The fix is not to delete it but to replace it with
something that keeps that property while remaining animatable:

```css
#sidebar { transition: width var(--dur-base) var(--ease); overflow: hidden; }
#workspace.sidebar-hidden { --sidebar-w: 0; }
/* collapsed pane carries `inert` → out of tab order and the a11y tree */
```

**Verified before adoption** (2026-08-12, Chromium = WebView2 = the Windows target):
`inert` exists on `HTMLElement.prototype`, blocks focus, and reflects to an attribute;
`grid-template-columns` is transitionable. WebKitGTK to be confirmed on-device.
Fallback if it fails there: toggle `visibility: hidden` on `transitionend`.

## 4. Backend and contract changes

- `settings.rs` — add `sidebar_width`, `rail_width`, `rail_tab` as `Option<T>`. The
  struct is already `#[serde(default)]`, so an existing `session.json` loads unchanged.
- `outline_visible` / `history_visible` collapse into `rail_visible` + `rail_tab`.
  Legacy fields are read once on migration, then no longer written.
- `menu.rs` — register real accelerators and strip the parentheticals from labels. The
  double-fire the old comment guards against is resolved by keeping menu events as the
  single command path and having the frontend keydown handler defer to them.
- CLAUDE.md §4 (file list) and §5 (Settings shape) updated in the same commits.

## 5. Error handling and edge cases

| Case | Behavior |
|---|---|
| Drag below minimum width | Snap to collapsed and persist *collapsed*, not `width: 0` |
| Persisted width wider than viewport | Clamp on restore (max 40vw) |
| Rail tab whose panel has no data (history on an unsaved doc) | Tab disabled with a reason, not hidden — position stays stable |
| `prefers-reduced-motion` | All durations resolve to 0ms via one token override |
| Old `session.json` without the new fields | `#[serde(default)]` yields `None` → frontend defaults |
| Legacy `outline_visible` + `history_visible` both true | Rail opens on Outline (deterministic, documented) |

## 6. Testing

### Headless — runnable here, no human needed

1. `panes.ts` state transitions and restore clamping — vitest
2. `resizer.ts` clamp / snap / collapse geometry — vitest
3. All ten existing suites plus the nine Rust crates stay green
4. Visual sweep: light + dark × 1440/1280/1024/800 wide × pane combinations
5. Touch targets reach ≥40px under emulated coarse pointer — computed styles
6. `prefers-reduced-motion` genuinely zeroes `transition-duration`
7. Focus-visible ring on every interactive element; hover ≠ active color
8. Collapsed panes unreachable by Tab (the `inert` contract) — keyboard traversal
9. Editor measure never drops below 720px until the window truly cannot fit it; no
   horizontal overflow at any tested width
10. Menu accelerator path does not double-fire — TS-level test

Items 4–9 became possible only with the browser harness (§7).

### On-device — requires a human

Tracked in **[`docs/ON-DEVICE-VERIFICATION.md`](../../ON-DEVICE-VERIFICATION.md)**,
which also consolidates the pre-existing interactive checks that CLAUDE.md §0 and §8
refer to without ever listing.

## 7. The harness

`dev-harness.html` (repo root) is `app.html` plus a fake Tauri IPC bridge that answers
every `invoke` from in-memory fixtures. It boots the real `main.ts`, real Milkdown, real
stylesheet — with no disk access, so it can never write a note. It exists because all
disk I/O already sits behind `invoke()` (§5/§10): one choke point is one seam to fake.

Chromium against the harness is a *closer* proxy for the shipping target than the Linux
app itself: Windows renders in WebView2 (Chromium); Linux renders in WebKitGTK.

Not part of the build — Vite's input is `app.html` (§4).

## 8. Out of scope

- Pen input (explicit user decision)
- Command palette, global search, sidebar file operations (Movement II)
- Any change to the serializer, schema, or save path — this branch must not touch §3
