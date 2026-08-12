# CLAUDE.md — Toril

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Toril** — a MarkText-style WYSIWYG markdown editor built on **Tauri + TypeScript + Milkdown**.
>
> *The name:* in Spanish bullfighting, *el toril* is the pen where the bull waits before it charges
> into the ring — a nod to **Tauri** (the bull) and to writing (the pen), with the bull-in-a-china-shop
> joke built in: the editor is the bull, safely penned, doing delicate work.

> The stack is **decided** (§2); do not re-litigate it. Treat §3 (Data Safety) as hard rules, not
> suggestions. The detailed per-feature shipped history lives in `CHANGELOG.md` and git — this file
> keeps the durable decisions, the contract, and what's still open.

---

## 0. Current State

**Phases 0–3 complete; Phase 4 (polish) in progress. All gates green.** Tauri 2 + Vite + TypeScript,
§4 split (frontend at repo root, Rust in `src-tauri/`).

Built today: Milkdown WYSIWYG (CommonMark + GFM + emoji) with `serializer.ts` as the single canonical
converter (§3.2); atomic file I/O (`fsatomic`); workspace sidebar + multi-document tabs + file watcher
(`vaultscan`, `notify`); session memory; themes (System/Light/Dark); HTML + RTF export (`mdhtml`,
`mdrtf`); clipboard image paste (`imgasset`); formatting toolbar; status bar; native menu; and a QoL
batch (Find & Replace, Save All, toggle sidebar, unsaved-changes close guard). See `CHANGELOG.md` for
the feature-by-feature record.

**Deferred / not done:**
- **Math (KaTeX)** — the only Milkdown math plugin (`@milkdown/plugin-math`) is npm-**deprecated**, so
  it's omitted per the healthy-dependency rule (§2). Revisit when a maintained option appears. The
  round-trip gate stays CommonMark + GFM + emoji until then.
- **YAML front matter** — not yet guaranteed lossless; comrak handles it on export only. Add its
  fixtures to `roundtrip.test.ts` when in-editor handling lands.
- **PDF export** — deferred (§7); HTML export → browser "Save as PDF" is the manual path.
- **Source / Typewriter / Focus edit modes** — *dropped as low-value* (user decision, 2026-05-26), not
  deferred-pending. Revisit only on explicit demand.
- **Interactive GUI verification** — what is genuinely unverified is *interactive* behavior: dialogs,
  menus, and webview flows that need a human driving a window (`pnpm tauri dev`). The **build is not
  the obstacle** — the dev box has the WebKitGTK deps, so `cargo test --workspace` (app crate
  included, it links and its tests run) and `cargo clippy --workspace --all-targets` are available
  and **should be run**, not skipped. Don't assume the Rust side can't be compiled here; check before
  concluding that. (On a box genuinely missing the webview deps, the fallback in §Commands applies.)
- Tab switching does **not** preserve per-tab undo history (single shared editor, content swapped).
  Acceptable for now.
- **An unused link reference definition is deleted on save.** `[ex]: https://example.com` with no
  `[…][ex]` referencing it does not survive a round-trip: nothing in the ProseMirror doc records an
  unreferenced definition, so remark cannot re-emit it. Pre-existing remark/Milkdown behavior, not
  introduced by the canonical form. Pinned as `normalized.unusedLinkDefinition` in
  `tests/roundtrip.test.ts` so it can't drift silently; not being fixed (it would mean carrying
  unreferenced-definition state through the doc, §11).

**Known trade-off:** Toril's canonical form (`src/editor/canonical.ts`) is `-` bullets and `---`
thematic breaks, matching Obsidian — so most notes survive open→save untouched. Some constructs
still reformat (setext headings, indented code blocks, `~~~` fences, two-space hard breaks, link
reference definitions, `*`/`+`-authored bullets, `1)` ordered markers, over-indented nesting, bare
URLs, and **CRLF line endings → LF**, which rewrites every line of a Windows-authored note); the
`normalized` class in `tests/roundtrip.test.ts` is the authoritative list — each entry pinned to its
exact output. The reformatting is idempotent and never drops *rendered* content; the one known
exception is that an **unused link reference definition is deleted outright** (see the deferred list
above). Relevant to Obsidian-vault diffs (§1).

**HTML as a first-class editable format — shipped in v0.1.1-alpha.1.** Open/edit/save `.html`
WYSIWYG alongside `.md`, motivated by AI assistants emitting rich HTML instead of Markdown. The editor
engine is unchanged — HTML is the native shape of a ProseMirror doc, so it is a second canonical
serializer (`src/editor/html-serializer.ts`, §3.2) on the existing Milkdown schema, with sanitize-on-load
(§3.3) and format-aware tabs (`DocFormat` in `tabs.ts`; open/save/Save As/reload branch on `tab.format`;
export stays Markdown→comrak). Richer constructs (`src/editor/html-constructs.ts`): `<mark>`/`<sub>`/`<sup>`
marks and `<div class="callout">`, `<details>`/`<summary>`, `<dl>`/`<dt>`/`<dd>` blocks, as Milkdown
`$node`/`$mark` with safe markdown degraders. Gate: `tests/html-roundtrip.test.ts`.

**HTML format — remaining follow-ups** (not yet done):
- **Figure/figcaption** — deferred (image is inline; the figure content model is awkward).
- **Toolbar / menu affordances** for the new constructs — they currently only enter the doc via HTML
  parsing, not via buttons. A UX increment.
- **"Save As .html" dialog filter** — Rust `save_file_as` is currently Markdown-oriented.
- **Interactive GUI verification** of the HTML flows (needs a human driving a window, §0) — open a real
  AI `.html` artifact, edit, save, reopen; confirm the supported subset survives and unsupported markup
  is cleanly normalized.
- **Identity note:** HTML as first-class is a deliberate expansion of the "plain `.md`,
  Obsidian-compatible" pitch (§1) — keep that trade-off in mind.

Implementation notes for whoever resumes (learned the hard way): Milkdown `$markSchema`/`$nodeSchema`
*require* `toMarkdown`+`parseMarkdown`; `SerializerState` renders children via `state.next(node.content)`
(there is no `renderContent`); callout `kind` must be **class**-encoded (`callout-<kind>`) because
`sanitize.ts` runs with `ALLOW_DATA_ATTR:false`; and marks with no markdown form must degrade with a
**no-op** runner (an empty-type `withMark` produces an mdast node remark cannot stringify — and Export
HTML/RTF always serialize via `docToMarkdown`).

**Next:** finish Phase 4 — remaining is shippable-quality work: optional code-signing (removes the
SmartScreen warning) and on-device verification. A backlog of further QoL features is in §13. The
**forward plan beyond Phase 4** — turning the editor into a notes *system* (search, links, version
history, sync coexistence, the AI wedge) branch-by-branch, with per-stage publicity guidance — lives in
**`ROADMAP.md`**.

### Commands
```bash
pnpm install          # first time (pnpm via `corepack enable pnpm`)
pnpm tauri dev        # run the app (opens the window)
pnpm tauri build      # production .exe + installer (Windows; see §9)

pnpm test             # vitest — round-trip + toolbar + theme + export + tabs + security (jsdom)
pnpm typecheck        # tsc --noEmit (TS strict)
pnpm build            # tsc + vite build (frontend only)
# logic crates — the same nine CI runs (plain `cargo test` also builds the app crate)
cd src-tauri && cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset -p trashbin -p snapshots -p mergemd -p keystore
cd src-tauri && cargo fmt --all && cargo clippy   # clean before commit (§10)
```

**Build environment note.** The Rust **app** crate links against the system webview (Windows: WebView2;
Linux: WebKitGTK-4.1 + `pkg-config`). On a box without those, the frontend (`pnpm build`/`test`/
`typecheck`), the logic-crate tests, and `cargo generate-lockfile` all work, but a full `cargo build`/
`tauri dev` will not link. Launch the window on a machine with the platform webview deps. `fsatomic`
and the other logic crates are split out so their gates stay runnable everywhere.

**Typecheck landmine.** Do not verify types with `npx tsc` — `npx` resolves a bogus, unrelated
`tsc@2.0.4` package from npm (not TypeScript's `tsc`) that **exits 0 without checking anything**, so
it reports success on code that does not typecheck. Use `pnpm typecheck` or `node_modules/.bin/tsc`.

---

## 1. Goal

**Toril** is a desktop markdown editor with the look and feel of **MarkText**:

- **Inline WYSIWYG** editing — type `# ` and the line becomes a heading *in place*; the editing surface
  *is* the rendered surface (no separate preview pane).
- CommonMark + GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks, footnotes).
- Math (KaTeX), YAML front matter, emoji shortcodes.
- Export to HTML and PDF.
- Multiple themes; paste image from clipboard; file/folder sidebar + multi-document tabs.

**Files are plain `.md` in ordinary folders — stay Obsidian-vault compatible.** No proprietary
container, no sidecar lock-in. The folder a user opens may also be a live Obsidian vault.

Primary target: **Windows `.exe`**. macOS/Linux come free from the stack but are not the focus.

---

## 2. Stack (decided — do not change without explicit instruction)

| Layer | Choice | Role |
|---|---|---|
| App shell / packaging | **Tauri 2.x** | Native window, menus, Rust commands, small `.exe`, NSIS/MSI installers |
| Core (backend) | **Rust** | All filesystem I/O, exports, file watching, app logic |
| WYSIWYG editor | **Milkdown** (ProseMirror-based) | Markdown-first inline WYSIWYG; plugin-driven |
| Source-mode editor | **CodeMirror 6** | (Only if Source mode returns — currently dropped, §0/§8) |
| Frontend build | **Vite + TypeScript** (strict) | Dev server + bundling |
| MD parsing (Rust) | **comrak** | CommonMark + GFM for HTML/RTF export and any backend parsing |

**Pin every dependency** (Cargo.lock committed; exact versions in package.json). Upgrade deliberately.

**Only depend on healthy packages.** Never add a dependency that is deprecated, unmaintained, or
low-reputation. Before adding one, confirm it isn't flagged `deprecated` (npm / crates.io), has recent
publish history, and comes from a reputable publisher. If a feature's *only* viable dependency is
unhealthy, **defer the feature** (note it in §0) rather than ship the bad dep.

**Two patched dependencies — both recorded here, both with a removal condition.** Patching an
upstream package is allowed only as a documented exception; each one must say what it changes, why,
and when it goes away.

**1. Security-patched `glib` (vendored).** `src-tauri/third-party/glib/` is gtk-rs `glib`
0.18.5 vendored verbatim except a one-line fix for **GHSA-wrw7-89jp-8q8g** (a `VariantStrIter`
NULL-deref), wired in via `[patch.crates-io]` in `src-tauri/Cargo.toml`. It exists only because Tauri's
frozen gtk3 stack pins a vulnerable glib with no 0.18.x backport (glib 0.20 is incompatible). It is
`exclude`d from the workspace (we never fmt/clippy/test upstream code), and CodeQL findings inside it
are false positives. Don't edit it beyond the security patch; **remove the whole vendored crate** once
Tauri moves off gtk3. Full rationale is in the `Cargo.toml` patch comment.

**2. Correctness-patched `@milkdown/preset-commonmark` (pnpm patch).**
`patches/@milkdown__preset-commonmark@7.21.1.patch`, wired in via `patchedDependencies` in
`pnpm-workspace.yaml`. Two `toMarkdown` runners forward the list `spread` attribute to mdast as the
**string** `"false"`, which is truthy — so every bullet list serialized *loose*, reformatting whole
Obsidian vaults on save (a §3.2 round-trip defect, not a style preference). The patch coerces with
`=== "true"`, matching what `ordered_list` and preset-gfm's task item already do. A local
`extendSchema` override was tried first and rejected: it could not chain to the GFM-extended
`list_item` and dropped task-list checkboxes. **Remove the patch** once Milkdown ships the fix
upstream (the issue is drafted, not yet filed); the `preserved` fixtures in `tests/roundtrip.test.ts`
keep the behavior honest either way. `patches/**` is `-text` in `.gitattributes` so the file is
checked out byte-exact — CRLF-ifying it makes `pnpm install` fail to apply it on Windows.

### Why this stack (so it isn't second-guessed later)
Inline WYSIWYG is the hard part of any markdown editor, and the mature engines for it live in the
browser DOM (ProseMirror/Milkdown). Tauri gives a Rust core + system webview, so we get that mature
editor **and** a small native binary — memory-safe (Rust core + GC'd webview), with no C/C++ in our code.

### Build-machine prerequisites (Windows)
Rust stable (`rustup`); Node.js LTS + **pnpm**; **Microsoft C++ Build Tools** (MSVC); **WebView2
runtime** (preinstalled on Win11, bootstrapped on Win10).

---

## 3. Data Safety — NON-NEGOTIABLE

This is a notes app. The user's writing is the only thing that truly matters. These three rules outrank
features.

1. **Atomic saves.** Never write a file in place. Write to a temp file in the same directory,
   flush/fsync, then atomically rename over the target. A crash mid-save must never corrupt an existing
   note. (Implemented in `fsatomic`.)
2. **Lossless round-tripping.** Source ⇄ WYSIWYG must not lose or mangle content. Maintain **one**
   canonical markdown representation; never keep two diverging buffers. All serialization goes through a
   single module (`serializer.ts`) so the conversion has exactly one source of truth.
3. **Treat opened files as untrusted.** A `.md` file (or pasted content) can carry hostile HTML.
   Sanitize anything rendered in the webview (`sanitize.ts`) so embedded markup cannot execute script.

If a feature would compromise any of these three, the feature loses.

---

## 4. Project Structure

```
toril/
├── CLAUDE.md                  # this file
├── package.json               # frontend deps + scripts (pinned)
├── vite.config.ts             # build input = app.html (not index.html)
├── app.html                   # the app's HTML entry (Tauri window loads this)
├── dev-harness.html           # app.html + a fake Tauri IPC bridge, for headless UI work
│                              #   (see §8; not part of the build — vite's input is app.html)
├── index.html                 # RESERVED for the GitHub Pages landing page — NOT part of the app build
├── src/                       # FRONTEND (TypeScript, strict)
│   ├── main.ts                # bootstrap / app controller
│   ├── editor/
│   │   ├── milkdown.ts        # WYSIWYG setup + plugins (incl. clipboard-image paste, §6)
│   │   ├── serializer.ts      # the ONE markdown <-> doc converter (§3.2)
│   │   ├── html-serializer.ts # the ONE HTML <-> doc converter (§3.2/§3.3)
│   │   └── html-constructs.ts # richer HTML-only schema: callout/details/dl/mark/sub/sup (§6)
│   ├── ui/
│   │   ├── sidebar.ts         # file tree
│   │   ├── panes.ts           # PURE pane state: visibility, widths, rail tab (§13)
│   │   ├── rail.ts            # the single tabbed right rail (outline | history)
│   │   ├── resizer.ts         # drag-to-resize: pure geometry + thin DOM binding
│   │   ├── tabs.ts            # open-document tabs (one shared editor + per-tab buffer)
│   │   ├── toolbar.ts         # formatting toolbar (commands + active state, §6)
│   │   ├── theme.ts           # theme preference controller (System/Light/Dark)
│   │   ├── statusbar.ts       # word/char count + reading time + cursor
│   │   ├── search.ts          # Find & Replace (decoration plugin + bar)
│   │   ├── conflictbar.ts     # non-blocking per-tab conflict banner (§5)
│   │   └── secrets.ts         # API key dialog — write-only, cannot display a key (§5)
│   ├── export/html.ts         # standalone HTML-document builder (§7)
│   ├── actions.ts             # named actions + double-fire guard (menu ∪ keyboard)
│   ├── styles.css             # entry point only — @imports the three layers below
│   ├── styles/
│   │   ├── tokens.css         # colour/space/size/motion/type — the ONLY place values live
│   │   ├── chrome.css         # everything around the writing surface
│   │   └── editor.css         # the writing surface itself
│   ├── sanitize.ts            # HTML sanitization (§3.3)
│   ├── sync.ts                # pure external-change policy (no DOM/IPC, §5)
│   ├── paths.ts               # path containment, for directory-level removal (§5)
│   └── ipc.ts                 # thin wrappers around Tauri invoke(); installCloseGuard
└── src-tauri/                 # BACKEND (Rust)
    ├── Cargo.toml             # pinned; workspace = app + crates/*
    ├── crates/                # dependency-light, webview-free, unit-tested cores
    │   ├── fsatomic/          # atomic writes (§3.1)
    │   ├── vaultscan/         # markdown-tree scanner (§5 open_folder)
    │   ├── mdhtml/            # comrak markdown→HTML for export (§7)
    │   ├── mdrtf/             # comrak markdown→RTF for export (§7)
    │   ├── imgasset/          # save pasted clipboard images beside the doc (§6)
    │   ├── trashbin/          # soft-delete to workspace .trash/ + restore (§3)
    │   ├── snapshots/         # content-addressed local version history (§3, ROADMAP I.3)
    │   ├── mergemd/           # line-based 3-way merge + conflict filenames (§3, ROADMAP I.4)
    │   └── keystore/          # OS-keychain API key storage (§3, ROADMAP IV.20)
    └── src/
        ├── main.rs            # bin entry → lib::run()
        ├── lib.rs             # Tauri builder + menu + command registration
        ├── menu.rs            # native app menu → `menu` events (§8)
        ├── commands/
        │   ├── files.rs       # open / save (ATOMIC) / save_as
        │   ├── workspace.rs   # open folder, list tree, watch (notify crate)
        │   ├── export.rs      # markdown_to_html + export_html; export_rtf (all-Rust)
        │   ├── images.rs      # save_clipboard_image (imgasset)
        │   ├── sync.rs        # merge_external / write_conflict_copy (§5)
        │   └── secrets.rs     # API key commands — no getter, by design (§5)
        └── settings.rs        # persisted prefs (theme, last folder, open files, sidebar_visible)
```
> comrak lives in `crates/mdhtml`/`mdrtf` (not the app crate) so its render config is unit-testable
> without the webview. Source/Typewriter/Focus modes are dropped (§0/§8), so no `codemirror.ts`/`modes.ts`.

---

## 5. Backend ↔ Frontend Contract (Tauri commands)

Authoritative list. Update it here whenever a command changes. **All disk access lives in Rust** — the
frontend never touches the filesystem directly; it asks via `invoke()`.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `open_file` | `path` | `{ path, content }` | UTF-8 read |
| `save_file` | `path, content` | `()` | **atomic** (temp + fsync + rename) — §3.1; also records version-history snapshots of the pre-existing *and* new content (best-effort, additive) |
| `save_file_as` | `content` | `path` | native dialog |
| `open_folder` | `path` | `FileNode[]` | recursive `.md` tree |
| `watch_folder` | `path` | event stream | external-change events (`notify` crate) |
| `markdown_to_html` | `content` | `html` | comrak (`mdhtml`) → **untrusted** HTML; caller sanitizes (§3.3, §7) |
| `export_html` | `html, defaultName` | `path?` | native dialog + **atomic** write of already-sanitized doc; `null` if cancelled |
| `export_rtf` | `content, defaultName` | `path?` | renders (comrak via `mdrtf`) **and** writes, all in Rust; inert output, no sanitize (§7) |
| `export_pdf` | `content, theme` | `path` | *(deferred — §7)* |
| `save_clipboard_image` | `bytes, docPath` | `relative_path` | writes pasted image to `./assets/` (`imgasset`), returns MD-relative path (§6) |
| `load_settings` / `save_settings` | — / `Settings` | `Settings` / `()` | JSON in app config dir; includes `theme`, `sidebar_visible`/`sidebar_width`, and `rail_visible`/`rail_width`/`rail_tab`. The legacy `outline_visible`/`history_visible` pair is **read once to migrate** into the rail fields and then never written again — that one-directionality is what stops a stale flag from overriding the migrated state |
| `save_recovery` | `entries` | `()` | **atomic** write of `recovery.json` in the app config dir — crash-recovery journal (§3) |
| `load_recovery` | — | `RecoveryEntry[]` | empty on missing/corrupt (never bricks startup) |
| `clear_recovery` | — | `()` | delete `recovery.json` — the clean-shutdown sentinel |
| `move_to_trash` | `vault_root, path` | `TrashEntry` | soft-delete into workspace `.trash/` via `trashbin` — **atomic** move (§3) |
| `list_trash` | `vault_root` | `TrashEntry[]` | newest first; empty when no `.trash/` |
| `restore_from_trash` | `vault_root, id` | `path` | restore to original path; errors **without clobbering** an existing file |
| `list_history` | `path` | `SnapshotMeta[]` | version list for a note, newest first; empty if none (`crates/snapshots`, ROADMAP I.3) |
| `read_snapshot` | `path, hash` | `content` | exact stored content of one version (for the diff view) |
| `restore_snapshot` | `path, hash` | `()` | snapshots current on-disk content **first**, then atomically writes the chosen version — restore is undoable (§3) |
| `merge_external` | `path, base, mine` | `{ outcome, content?, theirs? }` | Reads the file and 3-way merges via `mergemd`. **Never writes.** `outcome` is one of `unchanged` / `theirsOnly` / `merged` / `conflict` / `missing` — `missing` is a deleted file (`io::ErrorKind::NotFound`), distinct from an unreadable one, so a gone file can be recreated by an explicit save rather than blocked forever. `content` is set only for `merged`; `theirs` (the bytes now on disk) is set for every outcome **except `unchanged` and `missing`** — nothing to park in either case — so the caller can set its new merge base and park the losing side without a second read that would race the writer (ROADMAP I.4) |
| `write_conflict_copy` | `path, content` | `conflict_path` | Parks the losing side as `note (conflict 2026-07-25 14-32-05).md` beside the original — **atomic** via `fsatomic`, and `-2`/`-3`… suffixed rather than overwritten on a timestamp collision (§3) |
| `take_launch_path` | — | `path?` | file the app was launched with (double-click / "Open with"); returns it **once**, then `null` (§file-open) |
| `set_api_key` | `provider, key` | `()` | Validate and store an API key in the **OS keychain** (`keystore`) — Credential Manager / Keychain / Secret Service. Replaces any existing key for that provider (ROADMAP IV.20) |
| `clear_api_key` | `provider` | `()` | Remove a stored key. **Idempotent** — clearing an absent key succeeds, so pressing Clear twice is not an error |
| `has_api_key` | `provider` | `bool` | Whether a key is stored. The **only** read the webview is permitted |
| `list_api_keys` | — | `[{provider, configured}]` | Status of every provider in one round trip; never carries a key |

> **There is deliberately no `get_api_key`, and there must never be one.**
> `keystore::SecretStore::get` exists so Rust-side provider calls (Movement IV) can use a key;
> it is never registered with `invoke_handler`. §3.3 already treats webview content as untrusted,
> so a key that never crosses the IPC boundary turns a future sanitizer bypass into a rendering
> bug rather than a stolen credential — **the security property comes from the API shape, not the
> storage backend.** A "show key" toggle is not worth reversing that. `provider` is a closed set
> (`"anthropic" | "openai"`), mirroring the Rust enum, so a typo cannot create an orphaned entry.
> Secrets never enter `session.json`, `recovery.json`, `history/`, or any vault file, and no
> error string embeds one.
>
> **These four commands are registered but deliberately unsurfaced.** `crates/keystore`, the
> commands, `src/ui/secrets.ts` and its gates all exist and are green, but **no menu item, button
> or keybinding reaches the dialog** — `SecretsDialog` is constructed nowhere. Nothing in the app
> consumes a stored key until the AI panel lands (ROADMAP branch 20), and a live "API Keys…" item
> would promise a feature that does not exist — a user could save a key and get nothing. It was
> briefly wired on `main` (PR #33) and unwired again for exactly that reason. This is also the
> §7 *trust-before-reach* ordering: a Movement IV component may sit dormant ahead of the Movement I
> floor, but it must not be *reachable* ahead of it. **Branch 20 re-adds the menu item** — the
> storage layer is already built and tested, so that branch wires the UI rather than starting over.
> Note that branch 20's provider set is still an **open decision** (ROADMAP §8 leans Anthropic +
> Ollama); the shipped enum is `anthropic | openai`, so revisit it there rather than treating it
> as settled.

> **HTML export is split** across two commands to hold the single sanitization path (§3.3):
> `markdown_to_html` renders (raw HTML passed through), the **frontend** runs it through `sanitize.ts`
> and builds the standalone document, then `export_html` writes that finished HTML atomically. comrak
> never writes files; sanitize never moves to Rust.
>
> **Recovery journal.** `recovery.json` (app config dir, beside `session.json`) is the
> one deliberate exception to session.json's "paths only, never contents" rule (§3.2):
> crash recovery requires buffer contents. It is written debounced, cleared on clean
> exit, and never lives in the user's vault (§1).
>
> **Trash.** Soft-delete moves a file into `<vault>/.trash/<id>/` (own container +
> `manifest.json`) rather than `rm`; restore reads the manifest and atomically renames
> it back, refusing to clobber a file that reappeared at the path. `.trash/` starts with
> `.`, so `vaultscan` already hides it from the sidebar (§1) and Obsidian hides it too.
> Backed by `crates/trashbin`; commands are not yet called by any UI (the sidebar file-ops
> branch wires them).
>
> **Version history.** Every save records a content-addressed snapshot (`crates/snapshots`):
> per-note dir under `<app-config>/history/<hash(path)>/` — a `manifest.json` + gzip,
> sha256-addressed blobs. It lives **outside the vault** (like recovery/session, §1) so it
> never pollutes plain files or rides folder-sync. Capture is a **best-effort, additive**
> side-effect of `save_file`/`save_file_as` (a failure never blocks a save, §3), taken on **both
> sides** of the write — `snapshot_existing` records the bytes already on disk before they are
> overwritten, so the first Toril save of an externally-authored note (the moment canonical-form
> normalization lands) is itself undoable; content-dedup; **time-decay thinning** (keep-all <24h → hourly <7d → daily <30d → weekly,
> always keeping oldest+newest). Byte-exact (raw-bytes addressing, §3.2). `rekey` carries a
> note's history across a rename copy-then-delete (≥1 intact dir on power loss); the in-app
> rename that calls it is Movement II.12. Restore snapshots the current state first, so it is
> undoable. Frontend: `src/ui/history.ts` panel + `src/ui/linediff.ts`.
>
> **Events (Rust → frontend):** `workspace:change` (file watcher), `menu` (native menu item id
> `menu_*` → mapped to the same handlers as toolbar buttons), and `open-file` (a *second* launch's
> file path, forwarded by the single-instance plugin while Toril is already running). Subscribe via
> `onWorkspaceChange` / `onMenuAction` / `onOpenFile` in `ipc.ts`. The window **close guard** uses the
> frontend window API (`onCloseRequested`, `installCloseGuard`), not a command — see §3.
>
> **File-association open (double-click / "Open with").** Three parts: (1) `bundle.fileAssociations`
> in `tauri.conf.json` registers Toril as a `.md`/`.markdown`/`.html`/`.htm` handler so the installer
> writes the OS registry entries; (2) on **first** launch the path arrives as `argv[1]` —
> `lib.rs` captures it into `LaunchPath` and the bootstrap pulls it via `take_launch_path` (after
> session restore, so it becomes the active tab); (3) `tauri-plugin-single-instance` forwards a
> *subsequent* launch's argv to the running window as the `open-file` event instead of spawning a
> duplicate. **macOS** delivers file-opens via `RunEvent::Opened`, not argv — not yet wired (Windows
> is the focus, §1); add that handler when macOS becomes a target. All flows need interactive GUI
> verification — a human driving a window, not a missing toolchain (§0).
>
> **External changes: the save path is the guarantee, the watcher is an optimization.**
> `workspace:change` reconciles every open tab whose file changed, not just the active one. But
> watchers drop and coalesce events on network shares, some FUSE mounts, and a few sync clients — so
> **every save re-checks disk first** (`merge_external`, then proceed only on `unchanged`). A tab
> that has diverged blocks Save, Save All, and autosave until the user resolves it via the banner
> (`conflictbar.ts`); whichever way they resolve it, `write_conflict_copy` parks the losing side
> first, so no path through the feature discards bytes. A file that vanishes from disk mid-edit is
> not a conflict — `TabState.removedOnDisk` marks it and only an *explicit* save (File → Save, Save
> As, Save All) recreates it; autosave deliberately leaves it alone, because an Obsidian rename is a
> delete followed by a create, and an unattended recreate would duplicate the note beside its new
> name. The old 2-second `isSelfWrite` window is gone: after Toril saves, disk equals the tab's
> `base`, so a self-triggered watcher event reports `unchanged` and stops.
>
> **Known limit of the guarantee: a residual TOCTOU between `merge_external`'s read and `save_file`'s
> write.** `merge_external` only reads; the frontend then calls `save_file` separately, and nothing
> re-verifies disk in between. An external write landing in that window is silently clobbered, and
> the subsequent `tabs.setBase()` then makes every later reconcile compare against the new (just
> overwritten) bytes and report `unchanged` — so the loss isn't just possible, it stops being
> detectable *by reconciliation*. It is still **recoverable**: `save_file` calls
> `snapshot_before_write` → `snapshots::store::snapshot_existing` (`commands/files.rs`), which
> records the bytes already on disk *before* the overwrite — so the clobbered external write is a
> version in the history panel, and restoring it is one click. Closing the window properly needs a
> compare-and-swap inside `save_file` itself (refuse the write unless the on-disk bytes still equal
> `base`); that has not been built. Treat this as the honest edge of "never silently overwrite" —
> undetected at the moment it happens, but not unrecoverable.

---

## 6. Feature ↔ Milkdown Plugin Mapping

| Feature | Implementation |
|---|---|
| WYSIWYG core | `@milkdown/core` + `@milkdown/preset-commonmark` |
| GFM (tables, task lists, strikethrough) | `@milkdown/preset-gfm` |
| Math (KaTeX) | **Deferred** — `@milkdown/plugin-math` is deprecated; omitted until a maintained option exists (§0/§8) |
| Emoji shortcodes | `@milkdown/plugin-emoji` |
| Inline / slash shortcuts | `@milkdown/plugin-slash` + keymap config |
| Formatting toolbar | `toolbar.ts` → Milkdown commands via `callCommand` (the few command-less items use a plain ProseMirror transaction); **never inserts raw markdown text** (§3.2). Buttons reflect active state via `activeState()`. The pure command layer is exported separately from the DOM so the gate tests it headlessly. *Underline omitted by design* (no markdown form). *Front-matter button deferred* (not lossless yet). |
| Front matter | comrak handles on export; in-editor handling deferred |
| Source / Typewriter / Focus modes | **Dropped as low-value** (§0/§8); Source mode would use CodeMirror 6, both backed by `serializer.ts` |
| Themes | `theme.ts` writes `html[data-theme]`; colors are CSS variables in `styles.css`; persisted in settings |
| Clipboard image paste | `$prose` `handlePaste` in `milkdown.ts` → `save_clipboard_image` writes to `assets/` (`imgasset`, content-hashed for dedup) → inserted as a canonical image node (not raw text, §3.2). Requires a saved doc. |

---

## 7. Export Strategy

**HTML — implemented.** Three-stage pipeline preserving the single sanitization chokepoint (§3.3):
1. **Render (Rust):** `markdown_to_html` → `mdhtml` (comrak, GFM + front matter, `render.unsafe_` so
   raw HTML passes through). Output is **untrusted**.
2. **Sanitize + template (frontend):** `main.ts` runs the body through `sanitize.ts` (DOMPurify), then
   `export/html.ts` wraps it in a self-contained document with the active theme's CSS inlined.
3. **Write (Rust):** `export_html` opens the native save dialog and **atomically** writes (§3.1).

   Add the KaTeX stylesheet to the template when math lands.

**RTF — implemented.** Single-step, all in Rust: `export_rtf` walks comrak's AST and emits RTF control
words, then writes atomically. **No sanitization step** — RTF is inert (opened by a word processor, not
the webview), and `mdrtf` escapes all text. Images become a labelled placeholder. Opens in Word/
LibreOffice/WordPad/TextEdit.

**PDF — deferred** (decided not worth it at current maturity). The HTML export gives a faithful manual
path (open `.html` → browser Print → "Save as PDF"). Programmatic PDF in Tauri 2 has no core API; it
needs per-platform `with_webview` FFI (Windows `PrintToPdf`, macOS `WKWebView.createPDF`, Linux
`WebKitPrintOperation`) — unsafe, unverifiable without each webview, disproportionate for an alpha.
`headless_chrome` and pure-Rust HTML→PDF (weak CSS fidelity) remain rejected under §2.

---

## 8. Milestones & Gates

Phases 0–3 are complete and Phase 4 (polish) is in progress; the shipped detail is in §0 and
`CHANGELOG.md`. One milestone per branch; each ends runnable + committed.

**Gates (all green) — keep them green:**
- **Atomic save:** `cargo test -p fsatomic` — interrupting a save leaves the original intact (§3.1).
- **Round-trip:** `tests/roundtrip.test.ts` — real Milkdown in jsdom, built through
  `canonical.ts` so the gate tests the canon that ships. Three classes: `fixtures`
  (canonical input is stable), `preserved` (human/Obsidian-authored input is **not**
  rewritten), `normalized` (what we do rewrite, pinned to exact output). Add math +
  front-matter fixtures when those land (§3.2).
- **Toolbar round-trip:** `tests/toolbar.test.ts` — each command yields the same canonical markdown as
  typing the syntax, and asserts **no raw-markdown-text insertion** (§3.2).
- **Export:** `cargo test -p mdhtml -p mdrtf` (render configs) + `tests/export.test.ts` (builder + the
  §3.3 sanitization chokepoint).
- **Merge core:** `cargo test -p mergemd` — the crate's four `Divergence` outcomes (`Unchanged`,
  `TheirsOnly`, `Merged`, `Conflict`), convergent edits, CRLF line-terminator preservation,
  conflict-filename collisions, and a property test (500 randomized cases) that a clean merge
  never drops a line. The wire protocol's fifth outcome, `missing`, is produced one layer up in
  `src-tauri/src/commands/sync.rs` (an `io::ErrorKind::NotFound` on the read, before `mergemd` is
  even called) — that file has **no tests of its own**, so `missing` is exercised on-device only.
- **External-change policy:** `tests/sync.test.ts` — `decideAction`'s outcome→action mapping is total
  and fails closed, HTML never auto-merges, and `selectSavable` excludes a diverged tab from every
  bulk write path (§5).
- **Secret storage:** `cargo test -p keystore` — key-shape validation (empty, control characters
  that would corrupt an HTTP header, length bounds), the `SecretStore` contract against the
  in-memory double, provider isolation, idempotent `clear`, and that **no error string can contain
  the secret** (they reach the UI, so one could otherwise leak a key into a screenshot). Plus
  `tests/secrets.test.ts` — the field is `type=password`, is blanked after a successful save, and
  configured state comes from the backend rather than a cached key. **`OsKeychain` itself is not
  covered**: it needs a logged-in desktop session and CI's Linux runners have no Secret Service, so
  a test there could only fail or silently skip — and a silently-skipping test reads as coverage
  without being coverage. On-device only.
- **Pane layout:** `tests/panes.test.ts` + `tests/resizer.test.ts` — the tabbed rail's
  toggle semantics, the migration off the two-rail era, drag direction per edge, and the
  rule that no persisted width can make a pane unusable on a smaller screen than the one
  it was saved on. Note the split that makes this testable: `sidebarWidth`/`railWidth` are
  the width the user *chose*; what currently fits is derived per render by
  `effectiveWidths`. Collapsing the two lost the preference the first time a window was
  briefly narrowed.
- **Action double-fire:** `tests/actions.test.ts` — `menu.rs` carries real accelerators, so
  one Ctrl+S arrives twice (menu *and* webview keydown). One dispatcher collapses the pair.
- Plus `vaultscan`, `imgasset`, `theme`, `statusbar`, `search`, `security`, `tabs` suites.

> **The browser harness.** `dev-harness.html` is `app.html` plus a fake Tauri IPC bridge
> answering every `invoke` from in-memory fixtures. It boots the real frontend — real
> `main.ts`, real Milkdown, real stylesheet — in an ordinary browser with **no disk
> access**, so it can never write a note. Run `pnpm dev` and open
> `localhost:1420/dev-harness.html`.
>
> It exists because all disk I/O already sits behind `invoke()` (§5/§10): one choke point
> is one seam to fake. It makes a class of check possible that CI never covered — computed
> touch-target sizes under a coarse pointer, `prefers-reduced-motion` actually zeroing
> durations, focus rings, keyboard traversal of collapsed panes, layout at four viewport
> widths. Two real defects were found this way that no unit test would have caught.
>
> **Chromium against the harness is a closer proxy for the shipping target than the Linux
> app is:** Windows renders in WebView2 (Chromium); Linux renders in WebKitGTK.
> Human-only checks are listed in `docs/ON-DEVICE-VERIFICATION.md`.

**CI runs these automatically** on every pull request and on pushes to `main`
(`.github/workflows/ci.yml`): `pnpm typecheck` + `pnpm test` + `pnpm build`, and `cargo test` over the
nine logic crates — each on **Ubuntu and Windows**, plus `cargo fmt --all --check` on Ubuntu. The
Windows leg is not ceremony: `pnpm install --frozen-lockfile` is what applies the Milkdown patch, and
`fsatomic` is the §3.1 gate whose replace-over-existing semantics differ from POSIX there.

**What CI cannot cover — still yours to run:** interactive GUI flows (`pnpm tauri dev` — dialogs,
menus, the reload prompt), macOS, the Tauri app crate, and `cargo clippy` (§10; excluded from CI
because it lints the vendored `glib`, a path dependency that gets no `--cap-lints allow`). A green PR
means the headless gates passed, not that the app was driven. **The sync-coexistence *wiring* in
`main.ts` (`reconcile`, `recheckBeforeWrite`, autosave/Save-All gating, the conflict banner) has no
test harness — it needs a live Milkdown editor and Tauri IPC.** `crates/mergemd`, `src/sync.ts`,
`src/paths.ts`, and the tab bookkeeping in `src/ui/tabs.ts` are gated in isolation; the glue that
calls them in the right order, at the right time, is verified on-device only.

**Remaining for Phase 4:** optional code-signing (removes the SmartScreen warning — see the
code-signing memory) and on-device verification of GUI/Rust flows that can't be tested here.
Shortcut-reference panel deferred (the menu lists shortcuts).

---

## 9. Windows Packaging

```bash
pnpm tauri dev          # development
pnpm tauri build        # production -> .exe + installer
```

> **Two workflows.** `.github/workflows/ci.yml` runs the headless gates on every PR and on pushes to
> `main` (§8). `.github/workflows/release.yml` fires only on a `v*` tag and builds the installers —
> it does **not** run tests, which is why CI exists separately.

Output: `src-tauri/target/release/` (raw `.exe`) and `…/bundle/` (NSIS installer). In
`tauri.conf.json`: `bundle.targets` is an explicit list (`nsis` on Windows; `app`/`dmg` on macOS;
`deb`/`rpm`/`appimage` on Linux); `bundle.windows.webviewInstallMode = "downloadBootstrapper"`
(handles Win10 WebView2) and `bundle.windows.nsis.installMode = "currentUser"` (per-user install into
`%LOCALAPPDATA%\Toril`, no UAC prompt); set icon, product name, version, publisher.

> **Both Windows keys are set explicitly on purpose**, even though they match Tauri's current
> defaults. `README.md` documents them as user-facing guarantees ("installs per-user, so there is no
> administrator prompt"), and a claim that rests on an inherited default has no failure signal — a
> Tauri minor bump that flipped `installMode` to `both` would make the README false with nothing in
> the repo going red. Writing them down converts an assumption into a contract. Verified on-device
> (bundling is outside every headless gate).

> **MSI is intentionally excluded.** Windows Installer versions are 4-part numeric and only accept a
> *numeric* pre-release field, so a semver tag like `1.0.0-beta.1` cannot be bundled as MSI — it fails
> with `optional pre-release identifier in app version must be numeric-only …`. NSIS handles
> pre-release versions (and file associations + the WebView2 bootstrapper) fine, so it is the sole
> Windows installer. Revisit MSI only for a final numeric release (`x.y.z`, no `-beta`/`-rc`).

Code signing is optional for personal use; without it, Windows SmartScreen warns on first run —
expected, not a bug.

**Releases** are cut by pushing a `v*` git tag (e.g. `v0.1.0-alpha.5`), which triggers
`.github/workflows/release.yml` (cross-platform `tauri-action` build → GitHub prerelease). **Always add
the release's notes to `CHANGELOG.md` before pushing the tag** — the changelog is the source of truth
for the GitHub Release body.

---

## 10. Conventions for Claude Code

- **Read this file first every session.** §3 (Data Safety), §5 (command contract), and §8 (milestones)
  are the source of truth — update them here when they change.
- All disk I/O stays in Rust commands. The frontend never bypasses with web file APIs.
- All markdown conversion goes through `serializer.ts`. Never introduce a second conversion path.
- Saves are always atomic (temp + fsync + rename).
- Everything rendered in the webview passes through `sanitize.ts`.
- Rust: edition 2024; `cargo fmt` + `cargo clippy` clean before any commit.
- TS: `strict` on; no `any`.
- One milestone per branch; conventional commits (`feat:`, `fix:`, `chore:`).
- **Before a release (pushing a `v*` tag, §9), add that version's notes to `CHANGELOG.md`.**
- When two designs compete, prefer the one that keeps `.md` files plain and portable (Obsidian-compatible).

---

## 11. Known Hard Parts / Risks

- **Round-trip fidelity** (§3.2) is where most bugs hide — nested lists, table editing, code-fence
  boundaries. Lean on Milkdown's tested behavior; minimize custom schema.
- **External file changes** — the watcher + reload prompt matters more than it looks when the folder is
  also an Obsidian vault.
- **WYSIWYG edge cases** generally — prefer configuring Milkdown over hand-rolling ProseMirror nodes.

---

## 12. Future Ideas (out of scope — do not build into current milestones)

- **Multi-format structured editing (JSON / XML / YAML / TOML).** Deferred to keep the markdown editor
  whole; revisit only after it ships, possibly as a *separate* app. If pursued, the shape is **one app
  with pluggable editor surfaces** — an `EditorProvider` registry keyed by file type, each honoring the
  §3.2 single-canonical-serializer contract (not Milkdown plugins; data formats need a structure-tree /
  typed-form engine, likely CodeMirror 6 + schema). The hard part is lossless round-trip, which is
  *worse* than markdown here (YAML comments/anchors/Norway-problem, JSON key order, XML namespaces).

*Pure-Rust (egui) split-pane alternative was considered and rejected: it would trade away the inline
WYSIWYG feel that is the whole point. Decision is closed.*

---

## 13. Quality-of-life backlog (unscheduled, but fair game)

Concrete QoL features to pull from when polishing — **in scope** (unlike §12), just not yet scheduled.
Keep the project's rules: testable logic in `crates/*` or pure TS helpers, all disk I/O in Rust
(§5/§10), one canonical serializer (§3.2), no unhealthy deps (§2).

**Easy (pure frontend, fully testable here):**
- **Editor zoom** — `Ctrl +`/`-`/`0` adjusts an editor font-size CSS variable; persist in `Settings`.
- **Spellcheck** — ensure the ProseMirror editable carries `spellcheck="true"`. Verify on-device.
- **Tab niceties** — middle-click to close, "Close others / Close all".

**Easy–medium (small Rust / Tauri, needs on-device verify):**
- **Auto-save** — debounced save of dirty *saved* files; reuse atomic `saveFile`; toggle in `Settings`.
- **Remember window size/position** — add the maintained `tauri-plugin-window-state` (vet per §2).
- **Recent files / recent folders** — extend the persisted session with an MRU list; surface in File menu.
- **Open links in browser** (`Ctrl/Cmd`-click) — route through Tauri's shell-open.
- **Drag-and-drop a `.md` onto the window to open it** — Tauri drag-drop event → existing `openPath`.

**Medium (more UI / a new command, but high value):**
- **Global workspace search ("find in files")** — a Rust command scanning the vault (sibling to
  `vaultscan`, keeping scan logic unit-testable) + a results panel. Distinct from in-document Find.
- **Sidebar file operations** — new / rename / delete / new-folder via context menu, backed by new
  **atomic** Rust commands; mind the watcher interplay.
- **Document outline / TOC panel** — list headings from the doc, click to scroll.
