# Changelog

All notable changes to **Toril** are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); each version is the `v*` git
tag that triggered its release build (see CLAUDE.md §9). Every entry carries the
GitHub Release notes plus the commits that shipped in it.

> **Process:** add the new version's notes to this file **before** pushing the
> release tag (CLAUDE.md §10). This changelog is the source of truth for the
> GitHub Release body.

## [Unreleased]

### Added
- **Manage your notes from the files pane.** New note, new folder, rename and delete,
  from a right-click on any file or folder — or the `＋` button beside the folder name.
  Until now Toril could open and save notes but not *organize* them: renaming a note
  meant leaving for the file manager and coming back.

  **Deleting moves the note to a `.trash` folder inside your workspace, and offers you
  Undo.** Nothing is unlinked, so a delete is recoverable long after the message has
  gone — and because it is recoverable, Toril does not interrupt you to confirm it. The
  one thing trash cannot bring back is a buffer you never saved, so that is the one case
  that stops and asks.

  **A rename takes the note's version history with it**, and moves any open tab —
  including every tab inside a renamed folder — to the new path. Renaming does not
  rewrite a single byte of the file.

  Names are checked before anything touches disk, against the rules Windows actually
  enforces: no `< > : " / \ | ? *`, nothing ending in a space or a dot, and none of the
  reserved device names (`CON`, `NUL`, `COM1`…) that appear to work and then behave like
  hardware. Renaming `notes.md` to `Notes.md` — a change of case only — works. Nothing
  can be created or renamed outside the folder you opened, and no operation will ever
  overwrite a file that is already there.

- **Toril can update itself.** `v1.0.0` had no update path at all, so every copy was
  stranded on the version it was installed with — the only way forward was to notice a
  new release and download the installer by hand. Toril now checks for a newer build
  once a day at launch, and whenever you ask via **Help → Check for Updates…**.

  **It tells you; it never installs behind your back.** You choose when to download, and
  a restart is refused while anything is unsaved — the update is already on disk by then
  and applies the next time you start, so waiting costs nothing. Automatic checks can be
  turned off in **View → Check for Updates on Launch**.

  The check is a plain request for a static file. Nothing about you, your vault or your
  session is sent with it, and there is no telemetry in Toril.

- **The window remembers where it was.** Size, position and maximized state come back
  the way you left them.

- **Zoom the writing surface** with `Ctrl` and `+` / `-` / `0`. It scales the text and
  the measure, not the tab bar — your display scaling already handles the whole UI, and
  a bigger tab bar is not what anyone wants at 11pm.

- **File → Open Recent** lists the last ten notes you opened. An entry that no longer
  resolves removes itself rather than failing twice.

- **Ctrl-click a link** to open it in your browser. Only web and email links are handed
  to the system — a note can come from anywhere, and the rest of what a URL can name is
  not something an editor should hand to your operating system on a click.

- **Drop notes on the window to open them.** `.md`, `.markdown`, `.html` and `.htm`;
  anything else in the same drop is skipped and counted.

- **A real welcome note on first run**, and a blank page on every later launch with
  nothing to restore — the two used to be the same two-line stub. With no folder open,
  the files pane now offers to open one instead of only saying that none is.

### Notes
- Updates are cryptographically signed, and an installed Toril refuses one that does not
  verify. Setting that up is a one-time step for whoever cuts releases — see
  `docs/RELEASE-SIGNING.md`.
- Windows installers are still unsigned, so SmartScreen still warns on first run. The
  wiring for Azure Trusted Signing is in place but inert until an account exists.

## [v1.0.0] — 2026-08-17

**Toril leaves beta.** Same promise as always: your notes are plain `.md` (and
`.html`) files in ordinary folders, and nothing here changes that. This release is
mostly about the two ways Toril could still touch a file you had not edited — front
matter, and merely *opening* a note — both of which are now closed.

> **Known unverified:** the properties strip has not yet been driven in a real
> window. Its logic is covered by the test suite, but its rendered layout and the
> save path behind it are on the open checklist in
> `docs/ON-DEVICE-VERIFICATION.md` (section C). The MSI below has likewise never
> been built — it was impossible to bundle before this version.

### Packaging
- **A Windows `.msi` is published alongside the `.exe`.** Windows Installer only
  accepts numeric versions, so a beta tag literally could not be bundled as MSI;
  `1.0.0` can. **Take the `.exe` unless you are deploying centrally** — the two
  install differently on purpose. The `.exe` (NSIS) installs per-user with no
  administrator prompt; the `.msi` installs per-machine into `Program Files`, so it
  prompts for administrator and serves every account on the PC, which is what Group
  Policy and Intune deployments want.

### Fixed
- **Front matter is no longer corrupted.** A note that opens with a `---` properties
  block — every Obsidian note with properties — used to be damaged by open→edit→save.
  With no front-matter support in the editor, the block was read as ordinary markdown
  (a rule, a paragraph, a bullet list), and a key written *after* a list value was
  absorbed into that list: `draft: true` ended up nested under `- beta`, which is not
  valid YAML, so the property silently disappeared when the note was reopened in
  Obsidian. Front matter is now split off before the editor ever sees it and written
  back **byte-for-byte**, including blocks Toril cannot parse.

  A block keeps its own line endings, so a Windows-authored note's properties are no
  longer rewritten. A UTF-8 byte-order mark is preserved instead of becoming part of
  the document. Word count no longer counts front matter.

### Added
- **A properties strip above the editor.** Front matter is shown and edited in a
  collapsible band at the top of the document, in Obsidian's shape: one row per
  property, with the right control for its type (text, list, number, checkbox, date).
  YAML (`---`), TOML (`+++`) and JSON are all supported, and each is written back in
  **its own** syntax — Toril never converts a document's format behind your back.

  **Typed rows are only offered for a block Toril can prove it can put back**: it
  parses the block, writes it out again, and compares. If the two differ by so much
  as a byte — a comment, an anchor, an unusual quoting style — the strip shows the
  block as **text** instead, with the reason, and every byte stays editable. So a
  hand-tuned block is never quietly reformatted to make it fit a form.
- **Opening a note no longer marks it as edited.** Every document — an opened file,
  a restored session tab, even a brand-new empty one — was flagged unsaved the
  moment it loaded, without a keystroke. Milkdown's change listener is debounced by
  200ms upstream, so the "we are loading" guard around a programmatic load had
  already closed by the time the notification arrived.

  This was not cosmetic. It made the close prompt ask about files nobody had
  touched, filled the crash-recovery journal with unedited buffers, and — **with
  autosave on — rewrote every note you merely opened**, applying canonical
  formatting (line endings, list style, front matter) to files you never edited.
  Loads are now told apart from edits by comparing content rather than racing a
  timer. Found by driving the app on Windows for the first time; the gate that
  would have caught it (`tests/loadecho.test.ts`) now exists, and it waits past the
  debounce, which no previous test did.

### Changed
- **Canonical markdown now matches Obsidian.** Toril writes `-` bullets and `---`
  thematic breaks, and no longer converts tight lists to loose ones — a Milkdown
  bug that forwarded the list `spread` attribute as a truthy string, carried here
  as a pinned dependency patch until it is fixed upstream. Notes written by
  Obsidian or by hand now generally survive an open→save cycle untouched, which
  matters when the folder is a live vault or is synced by iCloud/OneDrive/Dropbox.

  **Existing notes re-normalize lazily** — only when you next save a note anyway,
  never in bulk, so nothing rewrites files you did not choose to write. Because
  every save records a version-history snapshot first, that re-normalization is
  undoable per note from the history panel.

### Added
- **Sync coexistence** (ROADMAP Movement I.4). Toril now handles a file changing
  underneath it while you have it open — the case that matters when a folder is a
  live Obsidian vault or is synced by iCloud Drive, OneDrive, Dropbox, Syncthing,
  or git. Non-overlapping edits are merged into your buffer automatically and left
  for you to review before saving; overlapping edits raise a non-blocking banner
  on that tab, with the other tabs still usable.

  **Whichever way you resolve it, the other version is kept** — parked beside the
  original as `note (conflict 2026-07-25 14-32-05).md` before either choice is
  applied. No path through this feature deletes bytes. A diverged file blocks
  saving, Save All, and autosave until you decide, and **every save re-checks the
  file on disk first**, so a change the file watcher missed still cannot be
  overwritten. If the file itself is deleted from under an open tab, autosave
  leaves it alone (an Obsidian rename is a delete-then-create, and an unattended
  recreate would duplicate the note); an explicit Save brings it back.

  New `crates/mergemd`: a line-based 3-way merge on `similar`, with each line's
  own terminator preserved so a CRLF file does not get rewritten end-to-end for a
  one-line change. HTML documents are never auto-merged — a line-level merge can
  produce unbalanced tags — so an HTML tab always gets the conflict banner instead.

  **Known limit:** there is a narrow window, between the disk check and the write
  that follows it, where a change landing in that instant can still be overwritten
  without being flagged. It is not lost, though: every save records the bytes
  already on disk as a version *before* overwriting them, so the overwritten
  change is in the history panel and one click away. Closing the window properly
  needs a compare-and-swap inside the save itself; that part isn't built yet.
  Gates: `cargo test -p mergemd` +
  `tests/sync.test.ts`; the `main.ts` wiring that drives autosave/Save All gating
  and the conflict banner is on-device only (no test harness for it yet).
- **Local version history** (ROADMAP Movement I.3). Every save now records a
  restorable version of the note, browsable in a new history panel (toggle in the
  toolbar / View menu; hidden by default) with a read-only line diff against the
  current text and one-click restore. Storage is a content-addressed store
  (`crates/snapshots`): gzip, sha256-addressed blobs + a JSON manifest, kept in the
  app config dir **outside the vault** — so it never pollutes the plain-files vault
  or rides folder-sync. Capture is a best-effort, **additive** side-effect of saving
  (it can never block or fail a save, §3), deduped on identical content, and thinned
  by a time-decay policy (keep-all <24h → hourly <7d → daily <30d → weekly beyond,
  always keeping the oldest draft and newest state). Restore snapshots the current
  state first, so it is undoable and cannot lose work. History follows a note across
  renames via a crash-safe copy-then-delete `rekey` (the sidebar rename that calls it
  lands later). Gates: `cargo test -p snapshots` + `tests/history.test.ts`; GUI
  toggle/restore is on-device (§0).
- **Autosave + crash recovery** (ROADMAP Movement I.1). Opt-in debounced atomic
  autosave of dirty, already-saved files (View → Toggle Autosave; off by default).
  An always-on recovery journal snapshots every dirty buffer — Untitled drafts
  included — to the app config dir, so a crash or kill can't lose unsaved work;
  recovered buffers reopen as dirty tabs on next launch. Journal lives outside the
  vault and is cleared on clean exit.
- **Safe delete (trash)** (ROADMAP Movement I.2). Deletes now soft-delete into a
  per-workspace `.trash/` (each item in its own container beside a manifest) instead of
  a destructive remove, with atomic restore that refuses to overwrite a file that
  reappeared at the original path. Backed by the `trashbin` crate; the sidebar delete UI
  that surfaces it lands in a later branch.

## [v1.0.0-beta.1] — 2026-06-21

**First beta — Toril opens your files the way you expect, and ships a patched
sanitizer.**

- **Double-click to open.** Set Toril as the default app for `.md` (or
  `.markdown`/`.html`/`.htm`) and double-clicking a file — or "Open with →
  Toril" — now opens it directly. If Toril is already running, the file opens in
  the existing window instead of launching a second copy.
- **Security:** the bundled HTML sanitizer (DOMPurify) is updated to 3.4.11,
  clearing a batch of sanitization-bypass / config-pollution advisories; the
  test-only `undici` dependency is patched to 7.28.0.

_Still pre-1.0 in spirit — a beta. Back up your notes. On Windows, SmartScreen
warns on first run because the build is unsigned; that is expected._

### Added
- **File-association open** (CLAUDE.md §5). `bundle.fileAssociations` in
  `tauri.conf.json` registers Toril as a handler for `md`/`markdown`/`html`/`htm`
  so the installer writes the OS registry entries. On first launch the file path
  arrives as `argv[1]`; `lib.rs` captures it into `LaunchPath` and the frontend
  pulls it once via the new `take_launch_path` command (after session restore, so
  it becomes the active tab). `tauri-plugin-single-instance` forwards a second
  launch's path to the running window as an `open-file` event and focuses it.

### Security
- DOMPurify 3.4.5 → 3.4.11 (shipped in `sanitize.ts`); `undici` → 7.28.0
  (transitive dev dependency of jsdom). pnpm overrides live in
  `pnpm-workspace.yaml`.

### Notes
- macOS file-opens (via `RunEvent::Opened`, not argv) are not yet wired — Windows
  is the focus (§1).
- The file-open GUI flow needs on-device verification on a webview-capable build
  (§0); the logic layers are gated (`launch_path_from_args` unit test, frontend
  typecheck + 97 tests).

## [v0.1.1-alpha.1] — 2026-05-30

**Release notes — edit HTML, not just Markdown:**

- **HTML is now a first-class editable format.** Open, edit, and save `.html`
  files in the same WYSIWYG editor you use for Markdown — handy now that AI
  assistants increasingly hand you rich HTML instead of Markdown. The format is
  chosen automatically from the file extension.
- **Rich document constructs round-trip losslessly** — callouts/admonitions,
  collapsible `<details>`, highlight (`<mark>`), subscript/superscript, and
  definition lists, on top of the usual headings, lists, tables, code, and links.
- **Safe by default** — HTML is sanitized as it loads, so scripts, inline event
  handlers, and embedded frames can never run in the editor.

_Still an early alpha — back up your notes. On Windows, SmartScreen warns on
first run because the build is unsigned; that is expected._

### Added
- HTML editable format: `src/editor/html-serializer.ts` (the single canonical
  HTML⇄document converter, mirroring `serializer.ts`) on the existing
  Milkdown/ProseMirror engine — no second editor, no new dependencies. Loads are
  sanitized through `sanitize.ts` before reaching the editable surface.
- Format-aware tabs (`DocFormat` on `TabState`): open/save/Save As/reload pick the
  matching serializer per file; export stays Markdown→comrak.
- Richer HTML constructs (`src/editor/html-constructs.ts`): `<mark>`/`<sub>`/`<sup>`
  marks and `<div class="callout">`, `<details>`/`<summary>`, `<dl>`/`<dt>`/`<dd>`
  blocks, as Milkdown `$node`/`$mark` with safe markdown degraders.
- Gate: `tests/html-roundtrip.test.ts` (21) — per-construct round-trip, load
  sanitization, and the export degrade-to-markdown path. Suite 76→97.

### Commits
- `8e4a0ab` feat(editor): HTML as a first-class editable format

## [v0.1.0-alpha.9] — 2026-05-29

**Release notes — bug fix:**

- **The window close button (✕) works again.** Closing the window from the
  title bar had stopped working: it did nothing, and the only way to quit was
  the **File → Quit** menu item. The ✕ button now closes the window as expected
  — immediately when there's nothing unsaved, and after the save-or-discard
  prompt when there is.

_Still an early alpha — back up your notes. On Windows, SmartScreen warns on
first run because the build is unsigned; that is expected._

### Fixed
- Window close (✕) was a no-op because closing goes through `window.destroy()`,
  which needs the `core:window:allow-destroy` permission that `core:default`
  does not grant (its window permissions are read-only). Granted it in the main
  window's capability (`src-tauri/capabilities/default.json`). The unsaved-changes
  close guard (`installCloseGuard`) was already correct; it just couldn't destroy
  the window. `File → Quit` was unaffected (native app-quit path).

### Commits
- `7306e55` fix(window): grant window destroy permission so the X button closes

## [v0.1.0-alpha.8] — 2026-05-27

**Release notes — quality-of-life improvements:**

- **Find & Replace** — press `Ctrl+F` to search the document, jump between
  matches, and replace one or all. (`Esc` closes; matching is case-insensitive.)
- **Save All** (`Ctrl+Alt+S`) — save every open file at once.
- **Toggle the sidebar** (`Ctrl+\` or the ☰ button) — collapse the file pane for
  distraction-free writing; the choice is remembered.
- **Won't lose your work** — closing the window with unsaved changes now asks
  before discarding them.
- **Reading time** — the status bar now shows an estimated reading time alongside
  the word/character count.

_Still an early alpha — back up your notes. On Windows, SmartScreen warns on
first run because the build is unsigned; that is expected._

### Added
- Find & Replace (`src/ui/search.ts`): a ProseMirror decoration plugin +
  search bar, hand-rolled to avoid a second ProseMirror copy. Gate:
  `tests/search.test.ts`.
- Save All; toggle sidebar (persisted via `Settings.sidebar_visible`); reading
  time in the status bar; an unsaved-changes guard on window close.
- Menu: File → Save All and a View → Toggle Sidebar item.

### Commits
- `e775e68` feat(ui): QoL batch — find/replace, save-all, sidebar toggle, close guard, reading time

## [v0.1.0-alpha.7] — 2026-05-27

**Release notes — new in this build:**

- **Paste images from the clipboard** — paste a screenshot or copied image
  straight into a (saved) note; it's written to an `assets/` folder beside the
  file and linked inline. Re-pasting the same image reuses one file.
- **Status bar** — live word & character count and cursor line/column at the
  bottom of the window (with a selection it shows "N of M words").
- **Native menu bar** — File / Edit / Help menus for New, Open, Save, Export
  HTML/RTF, the standard edit actions, and About. Keyboard shortcuts still work
  as before; the menu lists them.

_Still an early alpha — back up your notes. On Windows, SmartScreen warns on
first run because the build is unsigned; that is expected._

### Added
- Clipboard image paste: `save_clipboard_image` + the testable `imgasset` crate;
  a `milkdown.ts` paste plugin inserts a canonical image node (blocked on unsaved
  docs, which have no location for the relative link).
- Status bar (`src/ui/statusbar.ts`): word/char count + cursor `Ln/Col`.
- Native app menu (`src-tauri/src/menu.rs`): File/Edit/Help, routed to the
  existing actions via a `menu` event.

### Commits
- `3e63342` feat(ui): status-bar word count/cursor + native app menu (Phase 4)
- `8d89aef` feat(editor): paste clipboard images into assets beside the doc

## [v0.1.0-alpha.6] — 2026-05-27

**Release notes — new in this build:**

- **Export to RTF** — export the current note to a Rich Text Format document
  (the *Export RTF* button) that opens in Word, LibreOffice, WordPad, or
  TextEdit. Headings, bold/italic/strikethrough/inline code, code blocks, links,
  bullet/ordered/task lists, blockquotes, tables, and horizontal rules all carry
  over.

_Note: programmatic PDF export was evaluated and deferred for now — the HTML
export already gives a faithful PDF via your browser's “Save as PDF”, and a
native PDF path needs per-platform webview work not worth it at this stage.
Still an early alpha; back up your notes. On Windows, SmartScreen warns on first
run because the build is unsigned — that is expected._

### Added
- RTF export: `mdrtf` crate (comrak AST → RTF) + the `export_rtf` command and
  *Export RTF* button. All-Rust, no sanitization step (RTF is inert).

### Changed
- PDF export deferred (see §7) in favour of RTF; the HTML export covers manual
  "Save as PDF" via a browser.

### Docs / Process
- Added `CHANGELOG.md` and a rule to record release notes before tagging a release.

### Commits
- `8b82db0` feat(export): add RTF export via testable mdrtf crate
- `85cdd72` docs: add CHANGELOG.md and require release notes before tagging

## [v0.1.0-alpha.5] — 2026-05-26

**Release notes — new in this build:**

- **Formatting toolbar** above the editor: headings H1–H6 + paragraph,
  bold/italic/strikethrough/inline code, bullet/ordered/task lists, blockquote,
  code block, table, horizontal rule, link, image, an emoji picker, and
  clear-formatting. Every button drives the editor directly (never inserts raw
  markdown text), so notes stay clean, portable `.md`.
- **Themes** — System / Light / Dark, switchable from the header and remembered
  between launches.
- **Export to HTML** — export the current note to a self-contained, styled HTML
  file (the *Export HTML* button or `Ctrl+E`). Output is sanitized before it is
  written.

_Still an early alpha — expect rough edges, and back up your notes. On Windows,
SmartScreen warns on first run because the build is unsigned; that is expected._

### Added
- Formatting toolbar component (`src/ui/toolbar.ts`) with active-state highlighting.
- Theme controller (`src/ui/theme.ts`) + persisted `theme` preference.
- HTML export: `mdhtml` crate (comrak), `markdown_to_html`/`export_html`
  commands, and the standalone-document builder (`src/export/html.ts`).

### Changed / Removed
- Source / Typewriter / Focus edit modes dropped from the plan as low-value.

### Commits
- `5540525` feat(themes,export): add theme switching + HTML export; drop edit modes
- `8612a27` feat(toolbar): add formatting toolbar with round-trip gate (Phase 3)
- `b944306` docs(claude): add formatting-toolbar stage with full component coverage

## [v0.1.0-alpha.4] — 2026-05-26

**Release notes:** the editor now remembers your session — the last opened
folder, the set of open file tabs, and the active tab are restored on launch.

### Added
- Session memory: restore last folder + open files/active tab on launch (paths only).

### Commits
- `b5d9378` feat(session): remember last folder and open files across launches

## [v0.1.0-alpha.3] — 2026-05-26

**Release notes:** a visual fix for emoji sizing, plus contributor/docs polish.

### Fixed
- Emoji rendered at a towering intrinsic size; now constrained to `1em` so they
  sit inline with surrounding text.

### Docs
- Added `CONTRIBUTING.md`; documented the vendored security-patched `glib` and
  the deferred multi-format-editing idea; pointed URLs at `kovirlabs/toril`
  after the org transfer; landing-page download-button tweaks.

### Commits
- `dab1ba5` fix(editor): size emoji to 1em so they match surrounding text
- `ed1b317` docs: add CONTRIBUTING.md
- `44c5427` docs(claude): add §12 Future Ideas — deferred multi-format editing
- `bd9fd6a` docs(claude): note the vendored security-patched glib in §2
- `5b95b1d` docs: point GitHub URLs at kovirlabs/toril after org transfer
- `0c6b4e8` docs(site): relabel hero CTA "Download for Windows" → "Download"
- `99ccfb3` docs(site): point download button at the releases page, not a pinned asset

## [v0.1.0-alpha.2] — 2026-05-25

**Release notes:** emoji shortcodes in the editor, the HTML-sanitization
chokepoint that backs safe rendering/export, and a security patch for a
transitive `glib` NULL-deref.

### Added
- Emoji shortcodes (`@milkdown/plugin-emoji`); codified the healthy-dependency
  rule and deferred math (deprecated plugin).
- `sanitize.ts` — the DOMPurify HTML-sanitization chokepoint (§3.3).
- `SECURITY.md` security policy.

### Security
- Patched `glib` `VariantStrIter` NULL-deref (GHSA-wrw7-89jp-8q8g) via a
  vendored, fixed `glib` 0.18.5.

### Commits
- `738ee87` feat(security): add sanitize.ts HTML chokepoint (§3.3)
- `ab3cc1c` feat(editor): emoji shortcodes; add healthy-dependency rule; defer math
- `58797f4` fix(deps): patch glib VariantStrIter NULL-deref (GHSA-wrw7-89jp-8q8g)
- `b6a9d94` docs(site): add SEO essentials and point download at v0.1.0-alpha.1
- `356dc31` Create SECURITY.md for security policy

## [v0.1.0-alpha.1] — 2026-05-25

**Release notes:** branding and download/install documentation.

### Added
- Toril brand icon as the app icon; code-signing TODO noted.

### Docs
- README download/install steps; landing-page download buttons wired to the release.

### Commits
- `1009553` chore: use Toril brand icon as the app icon + add code-signing TODO
- `3f675b3` docs(readme): document v0.1.0-alpha downloads and install steps
- `d990e0f` docs(site): wire download buttons to v0.1.0-alpha release
- `afdfe4a` Create CNAME
- `c735ba2` Delete CNAME

## [v0.1.0-alpha] — 2026-05-25

**Release notes:** first public alpha. A working WYSIWYG markdown editor on
Tauri + Rust with atomic file I/O, a folder sidebar, multi-document tabs, a file
watcher, and the cross-platform release pipeline.

### Added
- Phase 0 — Tauri 2 + Vite + TypeScript scaffold.
- Phase 1 — Milkdown WYSIWYG editor, atomic file I/O, round-trip + atomic-save gates.
- Phase 2 — workspace: folder sidebar, multi-document tabs, external-change watcher.
- `tauri-action` release workflow for tagged builds; brand assets; GitHub Pages site.

### Commits
- `fcf8ba1` ci: add tauri-action release workflow for tagged builds
- `71172e0` Added updates to the github page and readme
- `97b88a1` chore: rename app entry to app.html, free index.html for GitHub Pages
- `8378dec` chore: add brand assets (icon + brand/theme guide)
- `969201d` feat: Phase 2 workspace — folder sidebar, tabs, file watcher
- `c649027` feat: Phase 1 MVP — Milkdown editor, atomic file I/O, both gates
- `7085a66` feat: scaffold Tauri 2 + Vite + TS app (Phase 0)
- `0d5b7f5` initial commit
- `24d2c42` Initial commit

[Unreleased]: https://github.com/kovirlabs/toril/compare/v1.0.0-beta.1...HEAD
[v1.0.0-beta.1]: https://github.com/kovirlabs/toril/compare/v0.1.1-alpha.1...v1.0.0-beta.1
[v0.1.1-alpha.1]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.8...v0.1.1-alpha.1
[v0.1.0-alpha.8]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[v0.1.0-alpha.7]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[v0.1.0-alpha.6]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[v0.1.0-alpha.5]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[v0.1.0-alpha.4]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[v0.1.0-alpha.3]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[v0.1.0-alpha.2]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[v0.1.0-alpha.1]: https://github.com/kovirlabs/toril/compare/v0.1.0-alpha...v0.1.0-alpha.1
[v0.1.0-alpha]: https://github.com/kovirlabs/toril/releases/tag/v0.1.0-alpha
