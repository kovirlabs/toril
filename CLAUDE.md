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
- **Front-matter format conversion** (YAML ⇄ TOML ⇄ JSON) — deliberately *never* automatic; converting
  on save would be exactly the unrequested rewrite the branch exists to stop. An explicit action, later.
  Also outstanding: **on-device verification** of the properties strip (design step 6).
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

**Front matter is no longer corrupted — `feat/frontmatter-properties`, steps 1–2 of
`docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`.** It used to be: with no
front-matter plugin, an Obsidian block parsed as thematic break → paragraph → bullet list → thematic
break, and a key *after* a list value was absorbed as a lazy continuation inside the previous list item
(`draft: true` nested under `- beta`) — invalid YAML, so the property vanished when the note was
reopened in Obsidian. A §3 data-safety bug, not the "not yet lossless" caveat this file used to carry,
and no fixture covered it.

Front matter is **not markdown**, so it is split off at the load/serialize boundary rather than modelled
as a Milkdown node: `src/editor/frontmatter.ts` (YAML `---`, TOML `+++`, JSON `{`) hands the editor only
the body, and `serializeEditor` rejoins the block **byte-exact**. It is edited in a collapsible strip
above the writing surface (`src/ui/properties.ts` + `#properties` in `app.html`), which shows **typed
rows** for a block that survives parse → re-serialize → compare and **raw text plus the reason** for
anything else — `src/editor/frontmatter-values.ts`, the only place a parser runs. All three formats get
typed rows, each written in **its own** spelling: `yaml` with options tuned (`nullStr: ""` so an
unfilled `key:` survives, `lineWidth: 0` so a long value is not folded), TOML through a hand-written
emitter (`smol-toml` parses, but its `stringify` pads arrays as `[ "a", "b" ]`, which no real Hugo file
matches), and JSON as `JSON.stringify(…, null, 2)`. Empty text is format-dependent: YAML's `key:`,
`""` for TOML (which has no null) and JSON. One exclusion the check itself would have allowed is
deliberate: a **multi-line value** re-serializes exactly, but a single-line row would eat the newlines.
Editing yaml's `parseDocument` AST was rejected — it preserves comments and quoting, but mutating one
value *relocates* a standalone comment, an unrequested rewrite of untouched bytes. `tab.content` stays the whole file, so
merge, snapshots, recovery, session and export are untouched — the split lives inside `loadIntoEditor`
/ `serializeEditor` and a module-level `liveSplit` mirroring the single shared editor. Two rules carry
the safety: `join(split(x)) === x` for every input including unparseable blocks, and typed editing (step
4) will only be offered for a block that survives parse → re-serialize → compare, which fails *closed*
for comments, anchors and block scalars without enumerating them. Consequences worth knowing: the block
keeps its own line endings, so a CRLF note ends up mixed (block CRLF, body LF — pinned as
`frontMatterNormalized.crlfNote`); a BOM is now held out of the document instead of entering it as
content; word count no longer includes front matter; and export gets the body directly rather than
relying on comrak's `opens_with_front_matter` to strip it — that guard is now the splitter's **parity
partner**, so the TS and Rust rules must change together (probed, not assumed: comrak also requires a
closing `---` and rejects `...`; both pinned in `mdhtml` *and* `mdrtf`).

Implementation notes for whoever resumes (learned the hard way): Milkdown `$markSchema`/`$nodeSchema`
*require* `toMarkdown`+`parseMarkdown`; `SerializerState` renders children via `state.next(node.content)`
(there is no `renderContent`); callout `kind` must be **class**-encoded (`callout-<kind>`) because
`sanitize.ts` runs with `ALLOW_DATA_ATTR:false`; and marks with no markdown form must degrade with a
**no-op** runner (an empty-type `withMark` produces an mdast node remark cannot stringify — and Export
HTML/RTF always serialize via `docToMarkdown`).

**Self-update, window state and code-signing wiring — `feat/release-readiness`
(ROADMAP Movement I.5).** `v1.0.0` shipped with no update path, so every installed copy
was stranded on the version it was installed with; that is now closed. Details and the
two-signatures distinction are in §5 (Self-update) and `docs/RELEASE-SIGNING.md`.
**One manual step remains before it does anything:** generate the minisign keypair, paste
the public half into `plugins.updater.pubkey`, and add the private half as a repository
secret. Until then `plugins.updater.pubkey` is empty, so a check degrades to a reported
error rather than a crash, and `release.yml` refuses to cut a tag with a one-line
explanation instead of failing deep in a Rust build.

The **QoL half of the same branch** has also landed: editor zoom, open-links-in-browser,
drag-and-drop open, a recent-files list in File → Open Recent, and a real first-run
welcome note distinct from the empty state. See §5 (Quality-of-life batch).

**Sidebar file operations — `feat/sidebar-file-ops` (ROADMAP Movement II.12).** New note,
new folder, rename and delete, from a context menu in the files pane. This closes two
pieces of already-built, already-tested Rust that had **no caller at all**: `trashbin`
(shipped in v1.0.0 with no UI) and `snapshots::rekey` (written for exactly this rename).
New crate `crates/fileops` holds the rules; `commands/entries.rs` wraps it; the UX is
`src/ui/sidebar.ts` on a new `src/ui/contextmenu.ts`. Details and the rename-ordering
argument are in §5 (Sidebar file operations). Still open from the branch: drag-to-move in
the tree, multi-select, and a trash browser (`list_trash` has a command and a wrapper but
no UI, so Undo reaches only the most recent delete).

**Vault search — `feat/vault-search` (ROADMAP Movement II.6).** Find text across every note in
the open folder, from a third tab in the rail. The largest remaining gap between Toril and a
notes system, and branch 7 (command palette) depends on it for file ranking. New crate
`crates/vaultsearch` holds an **in-memory** index — there is no index file, by design;
`commands/search.rs` wraps it; the UX is `src/ui/searchpanel.ts`. Details and the
`tantivy`-vs-hand-rolled argument are in §5 (Vault search). Still open from the branch:
search-and-replace across files (a write path — it needs snapshots and a preview first),
filters by folder or extension, and on-device verification.

**Next:** finish Phase 4 — remaining is Azure Trusted Signing once an account exists, and
on-device verification. A backlog of further QoL features is in §13. The
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
# logic crates — the same eleven CI runs (plain `cargo test` also builds the app crate)
cd src-tauri && cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset -p trashbin -p snapshots -p mergemd -p keystore -p fileops -p vaultsearch
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
| Front-matter parsing (TS) | **`yaml`** (eemeli), **`smol-toml`** | Reading a block into typed properties; both zero-dependency, both vetted per the healthy-dependency rule. JSON needs nothing |

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
│   │   ├── sidebar.ts         # file tree + file operations UX (§5, ROADMAP II.12)
│   │   ├── contextmenu.ts     # the one in-app context menu (DOM, not native — §8)
│   │   ├── panes.ts           # PURE pane state: visibility, widths, rail tab (§13)
│   │   ├── rail.ts            # the single tabbed right rail (outline | history)
│   │   ├── resizer.ts         # drag-to-resize: pure geometry + thin DOM binding
│   │   ├── tabs.ts            # open-document tabs (one shared editor + per-tab buffer)
│   │   ├── toolbar.ts         # formatting toolbar (commands + active state, §6)
│   │   ├── theme.ts           # theme preference controller (System/Light/Dark)
│   │   ├── statusbar.ts       # word/char count + reading time + cursor
│   │   ├── search.ts          # Find & Replace (decoration plugin + bar)
│   │   ├── searchpanel.ts     # vault search: the rail's third tab (§5, ROADMAP II.6)
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
    │   ├── keystore/          # OS-keychain API key storage (§3, ROADMAP IV.20)
    │   ├── fileops/           # create/rename: name rules, containment, no clobber (ROADMAP II.12)
    │   └── vaultsearch/       # in-memory full-text index over the vault (ROADMAP II.6)
    └── src/
        ├── main.rs            # bin entry → lib::run()
        ├── lib.rs             # Tauri builder + menu + command registration
        ├── menu.rs            # native app menu → `menu` events (§8)
        ├── commands/
        │   ├── files.rs       # open / save (ATOMIC) / save_as
        │   ├── entries.rs     # create note/folder, rename (+ history rekey) — ROADMAP II.12
        │   ├── workspace.rs   # open folder, list tree, watch (notify crate)
        │   ├── export.rs      # markdown_to_html + export_html; export_rtf (all-Rust)
        │   ├── images.rs      # save_clipboard_image (imgasset)
        │   ├── search.rs      # index_vault / search_vault / index_paths — ROADMAP II.6
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
| `load_settings` / `save_settings` | — / `Settings` | `Settings` / `()` | JSON in app config dir; includes `theme`, `sidebar_visible`/`sidebar_width`, `rail_visible`/`rail_width`/`rail_tab`, `properties_expanded` (the front-matter strip's collapse state; `null` ⇒ expanded), and the update trio `update_check`/`update_last_checked`/`update_skipped_version` (§Self-update). The legacy `outline_visible`/`history_visible` pair is **read once to migrate** into the rail fields and then never written again — that one-directionality is what stops a stale flag from overriding the migrated state |
| `save_recovery` | `entries` | `()` | **atomic** write of `recovery.json` in the app config dir — crash-recovery journal (§3) |
| `load_recovery` | — | `RecoveryEntry[]` | empty on missing/corrupt (never bricks startup) |
| `clear_recovery` | — | `()` | delete `recovery.json` — the clean-shutdown sentinel |
| `create_note` | `vault_root, dir, name` | `path` | Create an **empty** note in `dir` (`crates/fileops`). `name` may omit the extension (`.md` added). `create_new`, so the existence check and the creation are one operation — two racing creates cannot both win |
| `create_folder` | `vault_root, parent, name` | `path` | `create_dir`, not `create_dir_all`: an existing folder is an error, not a silent success |
| `suggest_note_name` | `vault_root, dir, stem` | `name` | `Untitled.md`, else `Untitled 2.md`… A **suggestion** for the inline field only; `create_note` still refuses a collision. Takes `vault_root` although it only reads: it answers "does this file exist?" for any path handed to it, and the webview is untrusted (§3.3) |
| `rename_entry` | `vault_root, path, new_name` | `path` | Rename within the same parent, refusing to clobber a *different* entry (a **case-only** rename is allowed — resolved via `canonicalize`, since on a case-insensitive filesystem the destination "exists" as the source itself). Carries version history through `snapshots::rekey` — for a folder, every note in the subtree — **best-effort and additive**: the rename already happened, and history failing to follow must not report it as a failure |
| `move_to_trash` | `vault_root, path` | `TrashEntry` | soft-delete into workspace `.trash/` via `trashbin` — **atomic** move (§3) |
| `list_trash` | `vault_root` | `TrashEntry[]` | newest first; empty when no `.trash/` |
| `restore_from_trash` | `vault_root, id` | `path` | restore to original path; errors **without clobbering** an existing file |
| `list_history` | `path` | `SnapshotMeta[]` | version list for a note, newest first; empty if none (`crates/snapshots`, ROADMAP I.3) |
| `read_snapshot` | `path, hash` | `content` | exact stored content of one version (for the diff view) |
| `restore_snapshot` | `path, hash` | `()` | snapshots current on-disk content **first**, then atomically writes the chosen version — restore is undoable (§3) |
| `merge_external` | `path, base, mine` | `{ outcome, content?, theirs? }` | Reads the file and 3-way merges via `mergemd`. **Never writes.** `outcome` is one of `unchanged` / `theirsOnly` / `merged` / `conflict` / `missing` — `missing` is a deleted file (`io::ErrorKind::NotFound`), distinct from an unreadable one, so a gone file can be recreated by an explicit save rather than blocked forever. `content` is set only for `merged`; `theirs` (the bytes now on disk) is set for every outcome **except `unchanged` and `missing`** — nothing to park in either case — so the caller can set its new merge base and park the losing side without a second read that would race the writer (ROADMAP I.4) |
| `write_conflict_copy` | `path, content` | `conflict_path` | Parks the losing side as `note (conflict 2026-07-25 14-32-05).md` beside the original — **atomic** via `fsatomic`, and `-2`/`-3`… suffixed rather than overwritten on a timestamp collision (§3) |
| `set_recent_files` | `paths` | `()` | Rebuild the native menu so File → Open Recent lists `paths`. The **whole** menu is replaced — muda submenus are built, not mutated — so this is called only when the list changes. Items carry an **index** (`menu_recent_3`), never a path: a path is arbitrary user data and menu ids are matched as strings, so the frontend resolves the index against its own list (`src/recent.ts`) |
| `take_launch_path` | — | `path?` | file the app was launched with (double-click / "Open with"); returns it **once**, then `null` (§file-open) |
| `set_api_key` | `provider, key` | `()` | Validate and store an API key in the **OS keychain** (`keystore`) — Credential Manager / Keychain / Secret Service. Replaces any existing key for that provider (ROADMAP IV.20) |
| `clear_api_key` | `provider` | `()` | Remove a stored key. **Idempotent** — clearing an absent key succeeds, so pressing Clear twice is not an error |
| `has_api_key` | `provider` | `bool` | Whether a key is stored. The **only** read the webview is permitted |
| `list_api_keys` | — | `[{provider, configured}]` | Status of every provider in one round trip; never carries a key |
| `index_vault` | `path` | `IndexStats` | Read every note in `path` into the **in-memory** search index, replacing what was there (`crates/vaultsearch`, ROADMAP II.6). The one slow call in this group — it reads the whole vault — so the frontend runs it after the first paint, not in front of it. Returns `{ files, bytes, skipped }`: `bytes` is what the in-memory design costs, and `skipped` names every file deliberately not indexed (too large, not UTF-8, unreadable) rather than dropping it silently |
| `search_vault` | `args` | `SearchResults` | Search the indexed folder. `args` carries the pattern and three flags (`caseSensitive`, `wholeWord`, `regex`) and **nothing else — the result caps are the backend's**, so a search box cannot ask for a million rows. A malformed regular expression is an ordinary error carrying the engine's message. Lines come back **pre-split into matched/unmatched runs, never as offsets**: Rust counts bytes and JS counts UTF-16 code units, so an offset crossing this boundary is a chance to highlight half a character |
| `index_paths` | `paths` | `IndexStats` | Bring `paths` up to date after a `workspace:change`. Each is resolved against **disk**, not trusted from the event: a file is re-read, a directory is walked (the landing half of a folder rename arrives as one event naming the folder and nothing inside it), and a path that is gone takes its **whole subtree** out — a vanished path gives no way to tell whether it was one note or the folder that held a hundred |

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
> Backed by `crates/trashbin`, and wired to the sidebar as of Movement II.12.
>
> **Vault search (Movement II.6). The index lives in memory and nowhere else** —
> a §3 position, not a performance one. A persistent index is a second copy of the
> user's notes: it drifts, it corrupts, it needs invalidating, and it has to live
> somewhere. Holding the text in RAM and rebuilding it from the vault leaves the
> files on disk as the only source of truth — the same instinct that put `history/`
> outside the vault and made snapshots additive. The scale allows it: a personal
> vault is single-digit megabytes of text, and Toril already reads the whole tree to
> draw the sidebar. So there is no index structure at all in `crates/vaultsearch` —
> just the documents and a `regex`. If a vault ever arrives that this cannot hold,
> the answer is a real inverted index, **not a cache of this one**. `tantivy` was
> weighed and rejected the way `gix` was for snapshots (§8 of `ROADMAP.md`): 42
> dependencies, C code via `zstd-sys` unless feature-gated off, and a stemmed BM25
> index that answers the wrong question — find-in-files is literal and line-oriented,
> and `regex`/`memchr`/`aho-corasick` were **already in the lockfile**.
>
> Three rules carry the safety, all inside the crate so they are gated without Tauri:
> what counts as a note is **`vaultscan`'s** answer (shared walk, not a second one —
> which is what keeps `.trash/` out of the results, so a deleted note is never offered
> back); every disk read is confined to the open folder, checked with `canonicalize`
> and **never** built from it (the `fileops` `\\?\C:\…` trap); and an index with **no**
> root reads nothing at all, which is the state the app holds before a folder is open
> and the one a crafted `invoke` would reach first. Without that last rule the feature
> is a file-disclosure hole wearing a search box as a disguise (§3.3).
>
> A result opens its note and hands the **query** to the in-document find bar
> (`SearchBar.openWith`), never a line number: there is no line to jump to in a
> WYSIWYG surface, and mapping a line of markdown source onto a ProseMirror position
> would be a second, divergent parse of the same file (§3.2).
>
> **Sidebar file operations (Movement II.12).** `crates/fileops` holds the rules —
> name validation, vault containment, refusing to clobber — and `commands/entries.rs`
> is a thin wrapper plus the history rekey. The UX is `src/ui/sidebar.ts` (context menu,
> inline name field) on `src/ui/contextmenu.ts`. **The menu is a DOM menu, not a native
> one**, and deliberately: a native popup cannot be driven by the headless gates, and
> native dialogs are the one thing documented to hang the app on the Linux dev box. The
> single native dialog left is the unsaved-changes confirm on delete (`confirmDiscard`),
> which is the close guard's prompt and the same judgement call.
>
> **Delete offers Undo instead of asking first.** The move is into `.trash/`, so it is
> reversible by construction; a confirmation would be friction in front of a reversible
> act. `restore_from_trash` — dead code until this branch — is what the Undo calls. What
> trash cannot restore is an **unsaved buffer**, so that case does stop and ask.
>
> **A rename is the §3 surface of this feature, and the ordering in `doRenameEntry` is
> the fix.** The watcher reports a rename as delete-then-create, which is exactly the
> shape `removedOnDisk` exists to catch — left alone, an open tab would decide its file
> had vanished and offer to recreate it, resurrecting the old note beside its new name.
> So, in one synchronous block after the rename resolves: re-point every affected tab
> (including tabs *under* a renamed folder), bump `removalEpoch` for each old path (a
> `reconcile` may be in flight against it and would apply a `missing` verdict to a tab
> that has moved), and clear `removedOnDisk` in case the delete event already landed.
> `base` is deliberately **not** reset — a rename changes no bytes, so the merge base is
> still exactly right and re-reading would only invite a race.
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
> **Self-update (`feat/release-readiness`, ROADMAP Movement I.5).** Three official Tauri
> plugins — `updater`, `process`, `window-state` — so there are no new `invoke` commands;
> they ship their own JS API, wrapped in `ipc.ts` (`checkForUpdate`, `relaunchApp`) so
> nothing else in the app reaches past that seam. **Toril notifies and never installs on
> its own.** The plugin can download-and-replace silently; we deliberately never call it
> that way, because this is an editor holding unsaved buffers and §3 outranks saving
> someone two clicks. The policy — check at most daily at launch, silent when there is
> nothing to say, loud for every outcome when the user asks via Help → Check for
> Updates — lives in `src/update.ts`, pure and gated by `tests/update.test.ts`; the
> network call and the toast are separate so the rules need no release server to test.
> **The restart is the one path that could destroy a buffer, so it is the one path that
> refuses**: `restartForUpdate` will not relaunch over a dirty tab, and says the update
> applies next launch instead (the install is already on disk, so waiting is free).
> No telemetry — the check is a plain GET for a static manifest.
>
> **Two unrelated signatures, both documented in `docs/RELEASE-SIGNING.md`.** Minisign
> signs the *update artifacts* and is **required**: `createUpdaterArtifacts` is on, the
> bundler refuses to emit an unsigned update, and `release.yml` fails fast with an
> explanation rather than deep in a Rust build. Losing that private key strands every
> installed copy permanently — there is no rotation, because installed builds verify
> against the public key they shipped with. Authenticode (Azure Trusted Signing) is
> what stops SmartScreen warning, is **optional**, and needs an account that takes days
> to provision — so its `signCommand` lives in `tauri.signing.conf.json`, an overlay
> applied in CI only when the `AZURE_*` secrets exist. That split is deliberate: a fork
> or a local `pnpm tauri build` must not need an Azure subscription to produce a working
> installer.
>
> **Quality-of-life batch (`feat/release-readiness`, second half).** Editor zoom
> (`src/zoom.ts` — a **fixed ladder**, not `× 1.1`, so five steps in and five out land
> exactly back on 100% and a persisted value can't drift; a stored `0` snaps to the
> default rather than being clamped, because it would otherwise render the editor
> unreadable *and* unfixable). Zoom scales the writing surface only, never the chrome —
> so `editor.css` heading sizes and the measure are `em`, not `rem`. **Open links in the
> browser** on Ctrl/Cmd-click, gated by `src/links.ts`: a **three-scheme allowlist**
> (http/https/mailto) parsed via `URL`, not string-matched, because the OS normalizes
> case and control characters before acting. This is a §3.3 boundary, not a convenience
> filter — `sanitize.ts` stops a hostile link executing *in* the webview, this stops it
> executing *outside* it, which is strictly worse since the shell is not sandboxed.
> **Drag-and-drop open** via Tauri's native drag-drop (HTML5 drops carry no real paths),
> filtered by `paths.selectOpenable` — an allowlist, because a drop is the one open path
> with no file-type filter in front of it. **Recent files** (`src/recent.ts` +
> `set_recent_files`). **First-run vs. empty state**: `src/welcome.ts` holds both, and
> `firstRun` comes from `settings.version === 0` (never written) rather than "nothing
> was restored", which is also true when an existing user closes their last tab.
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
| Front matter | **Not a Milkdown plugin, by design** — `src/editor/frontmatter.ts` splits the block off at the load/serialize boundary so it never enters the ProseMirror doc (§3). Edited in `src/ui/properties.ts`, a collapsible strip above the writing surface: typed rows for a block that provably re-serializes byte-exact, raw text for anything else |
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
  rewritten), `normalized` (what we do rewrite, pinned to exact output), and
  `frontMatter` (**whole-file** trip — split, round-trip the body, rejoin — the class
  that pins the §3 front-matter fix, including blocks no serializer could reproduce).
  Add math fixtures if math ever lands (§3.2). Plus `tests/frontmatter.test.ts`, the
  splitter's own gate: `join(split(x)) === x` over fixtures *and* 2000 randomized
  documents, detection per format, and the Rust-parity cases mirrored in
  `mdhtml`/`mdrtf`.
- **Front-matter properties:** `tests/frontmatter-values.test.ts` — Obsidian's own
  writes come back as typed rows (the feature is useless otherwise), and everything
  we would *reformat* lands in raw mode instead: comments, anchors, flow sequences,
  quoting styles, mixed-type lists. `tests/properties.test.ts` — the strip reports a
  complete block, refuses a duplicate-key rename (which would delete a property),
  keeps a CRLF or padded fence byte-exact, restores focus across the re-render an
  edit causes, and never reports a change for merely being shown.
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
- **File operations:** `cargo test -p fileops` — the name rules (the Windows-forbidden character
  set, control characters, trailing dot/space, reserved device names *with* an extension, and the
  near-misses that must still be **accepted**: `console.md`, `com10.md`), containment against a
  traversal dressed up as a subdirectory, every create/rename refusing to clobber while a
  **case-only** rename still succeeds, and that a returned path keeps the *caller's* spelling —
  the regression that pins it: containment is checked with `canonicalize`, which on Windows
  returns `\\?\C:\…`, and building the result from that hands back a path matching neither the
  sidebar tree, nor an open tab, nor the note's history key. Plus `tests/sidebar.test.ts` (the menu
  offers only what is wired, a rejected name keeps the field open with the message, blur cancels
  rather than commits, and a background refresh cannot delete what is being typed) and
  `tests/contextmenu.test.ts` (one menu at a time; dismissal actually removes its document
  listeners; the menu closes *before* its handler runs, since handlers take focus).
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
- **Zoom / links / recents:** `tests/zoom.test.ts` (the ladder round-trips exactly, and a
  stored `0` cannot make the editor unusable), `tests/links.test.ts` (the §3.3 allowlist —
  `jAvAsCrIpT:`, `java\tscript:`, `file://`, `ms-msdt:`; the cases a blocklist gets wrong),
  `tests/recent.test.ts` (dedupe-and-move, no in-place mutation, junk in `session.json`
  degrading to empty rather than throwing during bootstrap), and the `paths` suite's
  drop allowlist. Plus the shipped **welcome note is itself a round-trip fixture** in
  `tests/roundtrip.test.ts`: it claims in its own text that Toril doesn't rewrite your
  files, so it has to survive a save. That gate immediately caught two real defects in
  the copy (unpadded table pipes, and `**Ctrl+\**` escaping its own closing marker).
- **Update policy:** `tests/update.test.ts` — the startup/manual asymmetry (a background
  check is rate-limited, skippable and silent; a direct question always gets an answer),
  the interval boundary itself rather than either side of it, and that a `lastCheckedAt`
  in the **future** fails *open* — a corrected clock must not disable update checks
  forever with no symptom. What it cannot cover is anything downstream of the network:
  see §D of `docs/ON-DEVICE-VERIFICATION.md`.
- **Vault search:** `cargo test -p vaultsearch` — the query semantics that are easy to get
  subtly wrong and impossible to notice: `^TODO:` finding every line rather than only the
  first (multi-line mode), `C++` and `a.b` being literal rather than a regex that happens to
  parse or fail, `(?:foo|bar)` binding the alternation as a group (`foo|bar` matches
  inside `sandbar` — a **wrong answer**, not an error), a zero-width pattern not reporting a
  hit at every byte in the vault *and* on every filename, CRLF not returning a stray ``,
  clipping a long line of Japanese not splitting a character, and the caps truncating while
  still reporting the **true** totals. Plus the three safety rules: a note in `.trash/` is
  not searchable, a path outside the vault is never read (directly or via `..`), and a
  rootless index reads nothing at all. And `tests/searchpanel.test.ts` — the debounce, the
  length floor that counts *characters* so `眼鏡` is not refused, Enter overruling it, a slow
  answer never overwriting a newer one, a bad pattern rendering in place of results, and that
  a note's own text can never become markup (§3.3 — this is the one place vault content
  reaches the DOM outside the editor's sanitize path).
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
eleven logic crates — each on **Ubuntu and Windows**, plus `cargo fmt --all --check` on Ubuntu. The
Windows leg is not ceremony: `pnpm install --frozen-lockfile` is what applies the Milkdown patch,
`fsatomic` is the §3.1 gate whose replace-over-existing semantics differ from POSIX there, and
`fileops` encodes *Windows* naming rules (reserved devices, trailing dots, case-only renames) that
the Linux leg alone cannot see.

**What CI cannot cover — still yours to run:** interactive GUI flows (`pnpm tauri dev` — dialogs,
menus, the reload prompt), macOS, the Tauri app crate, and `cargo clippy` (§10; excluded from CI
because it lints the vendored `glib`, a path dependency that gets no `--cap-lints allow`). A green PR
means the headless gates passed, not that the app was driven. **The sync-coexistence *wiring* in
`main.ts` (`reconcile`, `recheckBeforeWrite`, autosave/Save-All gating, the conflict banner) has no
test harness — it needs a live Milkdown editor and Tauri IPC.** `crates/mergemd`, `src/sync.ts`,
`src/paths.ts`, and the tab bookkeeping in `src/ui/tabs.ts` are gated in isolation; the glue that
calls them in the right order, at the right time, is verified on-device only.

**Remaining for Phase 4:** Azure Trusted Signing
(removes the SmartScreen warning — the wiring is in place and inert, `docs/RELEASE-SIGNING.md`);
and on-device verification of GUI/Rust flows that can't be tested here, now including the
update flow (§D of `docs/ON-DEVICE-VERIFICATION.md` — nothing headless can prove a signed
artifact downloads, verifies, and replaces a running binary).
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

> **MSI is included as of `v1.0.0`, and NSIS remains the recommended installer.** MSI was excluded
> through the alpha/beta series for a hard reason: Windows Installer versions are 4-part numeric and
> accept only a *numeric* pre-release field, so `1.0.0-beta.1` could not be bundled at all (it fails
> with `optional pre-release identifier in app version must be numeric-only …`). A final numeric
> version removes that block, which is why this was the release to revisit it.
>
> **The two installers do not install the same way, and the README must keep saying so.** NSIS is
> configured `installMode: "currentUser"` — per-user, into `%LOCALAPPDATA%\Toril`, no UAC prompt. Tauri's
> WiX bundler has no per-user equivalent: the MSI installs **per-machine** and therefore **does** prompt
> for administrator. So the per-user, no-admin-prompt guarantee is a statement about the NSIS installer
> specifically, not about "installing Toril". MSI exists for the case it is actually good at — deploying
> to several machines with Group Policy / Intune, where per-machine is what you want.
>
> **Any tag carrying a pre-release suffix must drop `msi` from `targets` again**, or the Windows leg of
> the release build fails outright on the version-parse error above.

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

## 12b. Layout rules — earned, not preferences

Toril renders in **two different engines**: WebView2 (Chromium) on Windows, WebKitGTK on
Linux. `feat/chrome-ux` produced two overlap bugs that reproduced *only* in WebKitGTK and
never in Chromium, plus one that silently destroyed persisted state. All three had the same
shape, so these are rules rather than style notes.

**When two engines can disagree, the layout is under-specified — remove the ambiguity, do
not tune around it.** Cross-engine bugs cluster wherever the spec permits more than one
resolution. Chasing the quirk requires an engine you can inspect; removing the freedom does
not, which matters because the Linux webview here cannot be inspected (§0).

1. **One-dimensional layout uses flex, not grid.** A single-row or single-column grid is a
   flex line with extra degrees of freedom. Both overlap bugs were grids doing flex's job —
   `#workspace` (one row of three) and `#main` (one column of five).
2. **Never leave an implicit track.** A grid declaring only `grid-template-rows` gets an
   implicit column sized `auto` = `minmax(min-content, max-content)`; engines may resolve
   that against the container's definite width *or* the content's max-content. A ProseMirror
   contenteditable has a large max-content, so the second reading grows the column and its
   children paint over the neighbouring pane.
3. **`min-width: 0` on anything that must shrink** (`min-height: 0` in a column). A flex or
   grid item's *automatic minimum size is its content* — without this it refuses to shrink
   and pushes out over its neighbour. The most common overflow cause by a distance.
4. **Contain overflow at the scroll container, never the page.** Wide content (tables, code
   lines) scrolls inside its own pane. Prose carries `overflow-wrap: anywhere` — one pasted
   URL with no spaces otherwise sets the min-content width of the whole document.
5. **Never animate around `display: none`** — it cancels transitions. Animate width or
   transform, and delay `visibility: hidden` by exactly the duration
   (`visibility 0s linear var(--dur-base)`) to keep the element out of the tab order. Treat
   `inert` as a semantic bonus, never the only guard, unless verified in *both* engines.
6. **Derived, never stored.** What *fits* is a function of (the user's choice × the current
   viewport), recomputed per render — never written back into persisted state. Narrowing the
   window once used to shrink stored pane widths, widening never restored them, and the next
   session save wrote the shrunken value over the user's preference. Same discipline governs
   pane visibility.
7. **Responsive means dropping content, not shrinking everything.** Below a threshold
   *derived from the same constants as the pane minimums* (`EXCLUSIVE_BELOW` in `panes.ts`,
   never a hardcoded breakpoint), show one side pane rather than squeezing both into
   uselessness. The hidden pane stays open in state and returns when there is room.

**Verifying layout** (§8's harness is what makes this possible):

- **Measure rectangles; do not look at screenshots.** Assert non-overlap
  (`a.right > b.left`), containment, and that widths sum to the viewport.
  `scrollWidth > clientWidth` **misses an element painting over another** — it passed green
  while the overlap bug was live.
- Sweep widths **including exactly at the threshold and ±1**.
- Use **adversarial content**: `Wide.md` in the harness (long unbroken URL, wide table, long
  code line) exists for this. Normal prose proves nothing.
- **Ask which parts *don't* misbehave.** "The editor menu obeys the boundaries, the text area
  doesn't" was the entire diagnosis — short chrome rows never exceed the width, so only a
  large-max-content row could escape. The asymmetry names the cause faster than staring does.

---

## 13. Quality-of-life backlog (unscheduled, but fair game)

Concrete QoL features to pull from when polishing — **in scope** (unlike §12), just not yet scheduled.
Keep the project's rules: testable logic in `crates/*` or pure TS helpers, all disk I/O in Rust
(§5/§10), one canonical serializer (§3.2), no unhealthy deps (§2).

**Easy (pure frontend, fully testable here):**
- ~~**Editor zoom**~~ — *shipped* (`feat/release-readiness`).
- **Spellcheck** — ensure the ProseMirror editable carries `spellcheck="true"`. Verify on-device.
- **Tab niceties** — middle-click to close, "Close others / Close all".

**Easy–medium (small Rust / Tauri, needs on-device verify):**
- ~~**Auto-save**~~ — *shipped* (Movement I.1).
- ~~**Remember window size/position**~~, ~~**Recent files**~~, ~~**Open links in browser**~~,
  ~~**Drag-and-drop to open**~~ — all *shipped* (`feat/release-readiness`). **Recent
  folders** was not done: reopening a folder is a heavier action than reopening a file
  and the sidebar already remembers the last one.

**Medium (more UI / a new command, but high value):**
- ~~**Global workspace search ("find in files")**~~ — *shipped* (ROADMAP Movement II.6). Still
  open from that branch: **search-and-replace across files** (a write path, so it needs snapshots
  and a preview before it is offered), and **filters** by folder or extension.
- ~~**Sidebar file operations**~~ — *shipped* (ROADMAP Movement II.12). Still open from that
  branch: **drag-to-move** within the tree, **multi-select**, and a **trash browser**
  (`list_trash` has a command and an `ipc.ts` wrapper but no UI — Undo is currently the only
  way back, and it only reaches the most recent delete).
- ~~**Document outline / TOC panel**~~ — *shipped* (Movement II.11).
