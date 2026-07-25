# Toril — Roadmap: The Next Horizon

> The forward plan: how Toril goes from a single-document editor to a notes system.

This document is the source of truth for **what we build next and in what order**.
The shipped past lives in [`CHANGELOG.md`](./CHANGELOG.md); the durable contract
and data-safety rules live in [`CLAUDE.md`](./CLAUDE.md). When a branch ships,
move its story to the changelog and tick it here.

---

## 0. The thesis (why this roadmap looks the way it does)

Toril is not trying to replace Apple Notes on its own terms. A solo project can't
match preinstalled ubiquity, invisible iCloud sync, Apple Pencil, or the system
share sheet, and chasing them would cost the thing that makes Toril worth using.

The useful comparison set is Obsidian, Typora, iA Writer, Bear, Logseq, and Zettlr
— plus MarkText, which is unmaintained, so people who liked it need somewhere to
go. Toril's position within that set: real markdown, plain files on your own disk,
no cloud and no lock-in, and eventually an AI layer that runs on your own key or a
local model.

Two facts drive everything below:

1. **Sync is what most people mean by "does it work everywhere"** — and a
   plain-files app gets most of it by living in a synced folder (iCloud Drive / OneDrive /
   Dropbox / Syncthing / Git). We don't build sync infrastructure; we become
   *flawless at coexisting with folder-sync*. That is a §3 data-safety problem, not
   a server problem.
2. **AI is the clearest point of difference** — neither Apple Notes nor stock
   Obsidian does it well, and it is why the HTML-as-first-class work (v0.1.1)
   already exists. It ships *last* among the pillars, because every AI edit writes
   to a file and therefore needs the data-safety floor underneath it first.

---

## 1. Where this picks up

Phases 0–4 gave us a clean, well-tested **single-document** Markdown/HTML editor:
Milkdown WYSIWYG (CommonMark + GFM + emoji + rich HTML constructs), atomic I/O,
workspace sidebar, multi-doc tabs, file watcher, themes, HTML/RTF export, image
paste, in-document find & replace. ~2,400 LOC TS + ~1,360 LOC Rust, all gates green.

It is a fine **editor**. It is not yet a **notes system** — no global search, no
quick switcher, no links, no tags, no version history, no sync conflict handling,
no AI. That gap is this roadmap.

> **Status (2026-07-25).** The foundation above — plus file-association / double-click
> open — shipped through **`v1.0.0-beta.1`** (see `CHANGELOG.md`). **Movement I,
> branches 1–3 are complete** (autosave + crash-recovery journal; safe-delete-to-trash;
> local version history). Branches 4–5 and Movements II–V are unstarted.
> **▶ Pick up at Movement I, branch 4 — `feat/sync-coexistence`.** It has an approved
> design spec and no implementation code; its §7 still needs correcting after the
> precursor below. The spec lives **on that branch**, not on `main`:
> `docs/superpowers/specs/2026-07-24-sync-coexistence-design.md`.
>
> *Landed since, outside the movement ladder:* a serializer-normalization precursor
> (canonical markdown now matches Obsidian — `-` bullets, `---` rules, tight lists
> preserved), which exists to keep branch 4's 3-way merge from drowning in
> reformatting noise; CI running the headless gates on Ubuntu and Windows for every
> pull request; and the GitHub community-standards docs.
>
> *Version note:* the `v1.0.0-beta.1` tag ran **ahead** of the indicative ladder in §2
> (that ladder is guidance, not gospel). Movement I is not finished, so the project is
> functionally pre-`v0.2` despite the tag — keep §3's trust-before-reach rule in mind
> before leaning on the version number.

---

## 2. How we work (recap — these don't change)

- **One milestone per branch.** Each branch ends runnable + committed, gates green.
  Conventional commits (`feat:` / `fix:` / `chore:` / `perf:` / `docs:`).
- **Gates stay green.** Every branch that adds logic adds its gate (a `crates/*`
  cargo test or a `tests/*.test.ts` suite). Never ship a feature its gate can't see.
- **§3 is non-negotiable.** Atomic saves; one canonical serializer per format;
  sanitize everything rendered. A feature that threatens any of these loses.
- **Healthy deps only (§2).** Every dependency named below is checked for active
  maintenance and a reputable publisher; ones to re-vet at adoption time are flagged.
  Prefer **pure-Rust** crates so we keep "no C/C++ in our code" (the vendored `glib`
  is the one grandfathered exception).
- **Releases** are cut by pushing a `v*` tag → `release.yml` builds the cross-platform
  prerelease. **Add the notes to `CHANGELOG.md` before tagging.** Not every branch
  cuts a release; release points are marked **⬢ RELEASE** below.

**Indicative version ladder** (guidance, not gospel):

| Stage | Versions | Meaning |
|---|---|---|
| Now | `v0.1.x-alpha` | Editor, gates green |
| Movement I | `v0.2.x-alpha` | Safe to live in (data-safety floor) |
| Movement II | `v0.3–0.5.x` → **`-beta`** | A real notes system; first beta |
| Movement III | `v0.6.x-beta` | Premium writing craft |
| Movement IV | `v0.7–0.9.x-beta` | The AI wedge lands |
| Movement V | `v0.9.x-rc` → **`v1.0.0`** | Reach: perf, a11y, mobile |

---

## 3. Adoption principle: trust before reach

**Exposure must lag stability.** Toril is a *notes* app, so the data-safety floor
(Movement I) is what makes it recommendable for daily use, and it's the floor the AI
wedge (Movement IV) stands on. We don't ask anyone to rely on it until it provably
won't lose a note and coexists cleanly with folder-sync. Features ship in that order
for that reason: trust first, the differentiators second.

The detailed go-to-market plan (channels, cadence, launch timing) is kept as a
private working note, not in this repo.

---

## 4. Reconciliation with previous plans (scraped clean)

This horizon **pulls forward** several things earlier plans deferred or dropped:

- **Math (KaTeX)** — *un-deferred.* The deprecated `@milkdown/plugin-math` was the
  blocker, but `katex` itself is healthy. We write a **bespoke** Milkdown node on
  `katex` directly (Movement III), satisfying §2 and clearing the §0 deferral.
- **YAML front matter** — *resolved.* A properties UI + round-trip fixtures land in
  Movement II, closing the deferred gate item.
- **Focus / Typewriter modes** — *un-dropped.* Dropped as "low-value" under the
  editor framing; under the **writing-tool** framing they're identity features and
  cheap (CSS/ProseMirror). Reinstated in Movement III. (Source mode stays dropped.)
- **HTML follow-ups** (toolbar affordances for callout/details/etc., "Save As .html"
  dialog filter, figure/figcaption) — folded into Movement III's craft work.
- **Windows code-signing** (was `TODO.md`) — folded into Movement I release-readiness.

**Stays out of scope / deferred** (unchanged):

- **PDF export** — still deferred (§7); HTML → browser "Save as PDF" remains the path.
- **Source-mode editor (CodeMirror)** — still dropped unless explicitly demanded.
- **Multi-format structured editing (JSON/XML/YAML/TOML)** — still §12 future; a
  *separate* app at most. Do not absorb it here.

---

## 5. The plan, movement by movement

Each branch lists: **goal · touches · gate · §3 note (if any) · release**.
New crates follow the `crates/*` pattern — webview-free, unit-tested, dependency-light.

---

### Movement I — Trust Foundation · *make it safe to live in*

**Why first:** §3 says the user's writing is the only thing that truly matters. You
cannot recommend a notes app — even to a tester — until it won't lose notes and plays
nice in a synced folder. This movement is also the prerequisite for the AI wedge
(Movement IV writes to files; it must be able to snapshot-before-edit).

**Branches**

- [x] **1. `feat/autosave-recovery`** — debounced atomic autosave of dirty *saved* files +
   a crash-recovery journal for unsaved buffers; toggle in `Settings`.
   - *Touches:* `src/main.ts`, `src/ipc.ts`, `settings.rs` (add `autosave`,
     `autosave_debounce_ms`); reuses `fsatomic`.
   - *Gate:* `tests/autosave.test.ts` (debounce + dirty-only) + recovery-journal
     round-trip.
   - *§3:* every write still goes through atomic save + `serializer.ts`. Never write
     a file the user didn't intend.

- [x] **2. `feat/safe-delete-trash`** — soft-delete to a workspace `.trash/` with restore,
   instead of hard `rm`; backs the future sidebar delete op.
   - *Touches:* new `crates/trashbin` (move-to-trash + restore, atomic) +
     `commands/files.rs`; contract row in §5.
   - *Gate:* `cargo test -p trashbin`.

- [x] **3. `feat/local-version-history`** — content-addressed snapshots of each note
   on save + a diff/restore panel. *Store decision (§8) resolved: hand-rolled CAS,
   not `gix`.*
   - *New crate:* `crates/snapshots` — hand-rolled content-addressed blob store
     (sha2 + flate2/miniz_oxide + serde; pure-Rust, C-free); on-save dedup +
     time-decay thinning + crash-safe `rekey`.
   - *Touches:* `commands/snapshots.rs` (new contract rows), a `src/ui/history.ts`
     panel + `src/ui/linediff.ts`.
   - *Gate:* `cargo test -p snapshots` (snapshot → mutate → restore is lossless) +
     `tests/history.test.ts`.
   - *§3:* snapshots are *additive* and never block a save; restore goes through the
     atomic path. Design spec: `docs/superpowers/specs/2026-07-08-local-version-history-design.md`.

- [ ] **4. `feat/sync-coexistence`** — make folder-sync bulletproof: detect external edits
   to open files, 3-way merge where safe, write Obsidian-style `…(conflict).md`
   otherwise, and a clear "changed on disk — reload / keep mine / merge" UX. **This is
   our entire sync story.**
   - *New crate:* `crates/mergemd` — line/block 3-way merge built on **`similar`**
     (healthy); conflict-file naming.
   - *Touches:* extend the `notify` watcher in `commands/workspace.rs`; reload UX in
     `main.ts`/`tabs.ts`.
   - *Gate:* `cargo test -p mergemd` (clean merge, conflicting merge, no content
     loss) + a `tests/` watcher-reaction suite.
   - *§3:* a conflict must **never** silently overwrite either side.

- [ ] **5. `feat/release-readiness`** — auto-update + signing + first-run, so the floor is
   *shippable to strangers*.
   - *Scope:* wire **`tauri-plugin-updater`** (official) and **`tauri-plugin-window-state`**
     (vet versions per §2); editor zoom (`Ctrl +/-/0`); recent-files MRU; open-links-in-
     browser; drag-drop `.md` to open; a real **first-run / empty-state** (welcome note +
     "open a folder"). Adopt **Azure Trusted Signing** for Windows (the old `TODO.md`
     item: `bundle.windows.signCommand` → `trusted-signing-cli`; `AZURE_*` CI secrets;
     soften the SmartScreen note in `README.md` + `docs/index.html`).
   - *Touches:* `tauri.conf.json`, `.github/workflows/release.yml`, `settings.rs`,
     `menu.rs`, `main.ts`.
   - *Gate:* settings round-trip for the new prefs; manual on-device verify of update +
     first-run (no webview here).
   - [ ] **⬢ RELEASE `v0.2.0-alpha`** — *"Safe to live in."* First build you can hand to
     someone without an asterisk on their data.

---

### Movement II — From Editor to Notes System · *the daily-driver core*

**Why:** a folder of files only becomes a notes system once you can find things in
it and move between them. Search, a quick switcher, and links are what make an
editor something you keep using rather than something you tried.

**Branches**

- [ ] **6. `feat/vault-search`** — global find-in-files with a results panel. The largest
   gap between Toril and a notes system today. Incremental index updated on watcher events.
   - *New crate:* `crates/vaultsearch` — full-text index on **`tantivy`** (pure-Rust,
     Quickwit-maintained); sibling to `vaultscan` so scan/index logic stays
     unit-testable.
   - *Touches:* `commands/search.rs` (new contract rows: `index_vault`, `search_vault`),
     `src/ui/searchpanel.ts`.
   - *Gate:* `cargo test -p vaultsearch` (index → query → rank) + a panel test.

- [ ] **7. `feat/command-palette`** — quick switcher (fuzzy-open any note) + command palette
   (`Ctrl/Cmd-P` / `Ctrl-K`) running every editor/menu action. Anyone coming from
   VS Code, Obsidian, or Sublime reaches for this within minutes.
   - *Touches:* `src/ui/palette.ts`; fuzzy ranking via **`nucleo`** (Helix team) exposed
     through a tiny command, or a pure-TS matcher for the file list.
   - *Gate:* `tests/palette.test.ts` (fuzzy rank + command dispatch parity with menu).
   - *Depends on:* `vaultsearch` for file ranking.

- [ ] **8. `feat/wikilinks-backlinks`** — `[[wikilink]]` with `[[`-autocomplete + a backlinks
   panel. The main thing that makes a folder of notes navigable, and it is the syntax
   Obsidian already uses, so vaults stay readable in both.
   - *New crate:* `crates/linkgraph` — parse `[[links]]`, resolve to files, maintain a
     backlink index; updates on watcher events.
   - *Touches:* a Milkdown `$node`/`$inputRule` for the link + autocomplete (canonical,
     never raw-text insertion — §3.2); `commands/links.rs`; `src/ui/backlinks.ts`.
   - *Gate:* `cargo test -p linkgraph` + a round-trip fixture (wikilink survives
     save/load) added to `roundtrip.test.ts`.
   - *§3:* links serialize through `serializer.ts`; stays plain-text and
     Obsidian-readable.

- [ ] **9. `feat/tags`** — `#inline-tags` + frontmatter `tags:`; a tag browser pane.
   - *Touches:* extend `linkgraph` (tag index reuses the same crate); a Milkdown mark
     for `#tag`; `src/ui/tags.ts`.
   - *Gate:* tag-index test in `linkgraph` + round-trip fixture.

- [ ] **10. `feat/frontmatter-properties`** — edit YAML front matter as a friendly key/value
    panel; **closes the deferred front-matter round-trip gate.**
    - *Touches:* `serializer.ts` (front-matter handling), `src/ui/properties.ts`.
    - *Gate:* front-matter fixtures **added to `roundtrip.test.ts`** (the §0 to-do).

- [x] **11. `feat/outline-panel`** — heading outline / TOC; click to scroll. Cheap, pure
    frontend (was §13 backlog).
    - *Touches:* `src/ui/outline.ts`. *Gate:* `tests/outline.test.ts`.

- [ ] **12. `feat/sidebar-file-ops`** — new / rename / delete / new-folder via context menu,
    backed by **atomic** Rust commands; delete routes through `trashbin`.
    - *Touches:* `commands/files.rs` (new atomic ops + contract rows), `src/ui/sidebar.ts`;
      mind the watcher interplay.
    - *Gate:* extend `fsatomic` / a new ops suite.
    - [ ] **⬢ RELEASE `v0.5.0-beta.1`** — *"A real notes system."* First **beta**.

---

### Movement III — Writing Craft · *the editing surface itself*

**Why:** this is the iA Writer / Typora lane — syntax highlighting, math, diagrams,
and the focus modes. Mostly frontend, comparatively cheap, and it is the difference
between an editor that works and one that is pleasant to spend hours in.

**Branches**

- [ ] **13. `feat/code-highlighting`** — syntax-highlighted code blocks (a gray code block
    looks *broken* to a developer).
    - *New crate (or JS):* `crates/highlight` on **`syntect`** (use its `fancy-regex`
      backend to stay C-free) returning spans → ProseMirror decorations; *or* CodeMirror
      6 as a code-block nodeview.
    - *Gate:* `cargo test -p highlight` (token spans for a few languages) or a nodeview
      test.

- [ ] **14. `feat/math-katex`** — inline `$…$` / block `$$…$$`, **bespoke Milkdown node on the
    healthy `katex` package** (not the deprecated plugin). *Un-defers the long-standing
    §0 item.*
    - *Touches:* `src/editor/math.ts`; template gets the KaTeX stylesheet for HTML export
      (§7 note).
    - *Gate:* **math fixtures added to `roundtrip.test.ts`** (the §3.2 to-do) + export test.

- [ ] **15. `feat/mermaid-diagrams`** — fenced ` ```mermaid ` rendered via the healthy
    `mermaid` package as a nodeview.
    - *Gate:* render-smoke + round-trip (fence survives).

- [ ] **16. `feat/focus-typewriter`** — Focus mode (dim non-active paragraph), Typewriter mode
    (caret-centered scroll), distraction-free fullscreen. *Un-drops the dropped modes.*
    - *Touches:* `src/ui/` + CSS; toggles in menu + palette + `Settings`.
    - *Gate:* `tests/focusmode.test.ts` (state toggles; no content mutation).

- [ ] **17. `feat/writing-stats-goals`** — session word-count, daily goals, streaks, a small
    stats panel; extends the existing statusbar.
    - *Gate:* extend `statusbar.test.ts`.

- [ ] **18. `feat/daily-notes-templates`** — daily-note creation + a template system (variables
    like `{{date}}`, `{{title}}`).
    - *Touches:* `src/ui/templates.ts`; a tiny TS template engine (no heavy dep).
    - *Gate:* `tests/templates.test.ts`.

- [ ] **19. `feat/editor-polish`** — themes + sanitized **custom user CSS**, spellcheck
    (`spellcheck="true"` on the editable; verify on-device), smart-paste (URL→link,
    pasted HTML table→markdown table), **toolbar/menu affordances for the HTML constructs**
    (callout/details/mark/sub/sup — the §0 HTML follow-up), and the **"Save As .html"
    dialog filter** (the other HTML follow-up).
    - *Touches:* `toolbar.ts`, `menu.rs`, `commands/files.rs` (save-as filter),
      `styles.css`, `sanitize.ts` (scoped user CSS).
    - *Gate:* extend `toolbar.test.ts` + `security.test.ts` (user CSS can't break the
      sanitize boundary).
    - [ ] **⬢ RELEASE `v0.6.0-beta`** — the writing surface is finished.

---

### Movement IV — The AI Layer · *assistance that writes to your files*

**Why:** the clearest point of difference against the incumbents, and the reason
HTML-as-first-class already exists. It ships after the trust floor (Movement I) for
a concrete reason: **every AI edit takes a snapshot first** and writes through the
canonical serializer. Without that, an assistant editing your notes is a liability.

**Branches**

- [ ] **20. `feat/ai-assist-panel`** — side panel + inline commands: continue, rewrite,
    summarize, change tone, fix grammar, translate, outline. **BYO key** (Anthropic /
    OpenAI over HTTP) **and** local via **Ollama** — so it stays free and private.
    - *Touches:* `src/ui/ai.ts`; key storage via the **`keyring`** crate (OS keychain,
      healthy) behind a Rust command; provider calls from Rust to keep secrets off the
      webview.
    - *Gate:* `tests/ai.test.ts` against a mocked provider (prompt assembly, streaming,
      and that every applied edit is atomic + snapshotted).
    - *§3:* **snapshot-before-edit** (depends on `feat/local-version-history`); all writes
      via `serializer.ts` + atomic save. AI may *propose*; the user accepts; the file is
      protected. No telemetry.

- [ ] **21. `feat/vault-rag-chat`** — chat-with-your-vault: local embeddings + semantic search
    + Q&A over the user's notes — free, and local if you point it at Ollama.
    - *New crate:* `crates/embedindex` — embeddings via Ollama (no bundled model, keeps
      §2 clean) + a small vector store (**`instant-distance`** HNSW, or brute-force cosine
      for small vaults; keep it pluggable).
    - *Gate:* `cargo test -p embedindex` (index → nearest-neighbor recall on a fixture).

- [ ] **22. `feat/ai-organization`** — AI-suggested tags, titles, `[[links]]` (feeds
    `linkgraph`), and frontmatter summaries — all opt-in, all reviewable before write.
    - *Gate:* mocked-provider suite; writes go through serializer + snapshot.

- [ ] **23. `feat/mcp-bridge`** — expose the vault over **MCP** (and/or host MCP tools
    in-editor) so Claude/agents can read & write notes safely. The natural endpoint of
    "AI assistants emit rich content into my editor."
    - *§3:* agent writes are sandboxed to the vault, atomic, snapshotted, and surfaced in
      version history.
    - [ ] **⬢ RELEASE `v0.8.0-beta`** — AI assistance, on your own key or a local model.

---

### Movement V — Reach · *scale, polish, and the mobile bet*

**Why:** the long-horizon work — performance at scale, accessibility, and mobile —
that has to land before a `v1.0` means anything.

**Branches**

- [ ] **24. `feat/per-tab-undo`** — give each tab its own editor state / undo history (today a
    single shared editor swaps content). Structural debt that heavy users — and mobile —
    will demand.
    - *Touches:* `tabs.ts`, `milkdown.ts`. *Gate:* extend `tabs.test.ts`.

- [ ] **25. `perf/large-vault`** — lazy/incremental `vaultscan`, sidebar virtualization,
    large-file editing guard (ProseMirror chokes on huge docs).
    - *Gate:* `vaultscan` benchmark/fixture at thousands of files; a large-file guard test.

- [ ] **26. `feat/a11y-i18n`** — accessibility pass (keyboard nav, ARIA, screen-reader) +
    localization scaffolding.

- [ ] **27. `feat/encryption-locked-notes`** — opt-in per-note encryption via the **`age`**
    crate (pure-Rust) for "locked notes" parity. *Eyes open:* `.md.age` breaks
    Obsidian-compat for those notes — offer it, never default it.
    - *Gate:* `cargo test -p` (encrypt → decrypt round-trip; wrong-key fails closed).

- [ ] **28. `feat/mobile-ios-android`** — the largest single increment here, on Tauri 2 mobile (the
    `tauri::mobile_entry_point` hook is already latent). Touch UI, mobile Milkdown UX,
    and the iOS file-sandbox reality (lean on the Files app / iCloud Drive container;
    "plain files anywhere" is harder there — be honest about it). A quarter of work, not
    a weekend.
    - [ ] **⬢ RELEASE `v1.0.0`**

---

### Parallel track — Toril-TUI follow-ups · *parked 2026-07-08*

Not part of the desktop Movement ladder. **Toril-TUI** is a second, webview-free
front-end on the same core (`ratatui` + `edtui`, reusing `fsatomic`/`vaultscan`);
its MVP shipped under `[Unreleased]` in `CHANGELOG.md` (design spec + plan in
`docs/superpowers/`). Parked by owner decision to keep focus on the desktop notes
system — pull from here when the TUI comes back into scope. Its defining invariant to
**preserve in every follow-up**: it edits markdown *source* directly, so saves are
**byte-exact** (stronger §3.2 fidelity than the WYSIWYG app) — never introduce
normalization here.

- [ ] **On-device interactive verification** — the one verification *uniquely closeable
  on a webview-free box* (the TUI's whole reason to exist). Drive open→edit→`Ctrl-S`→
  byte-exact in a real terminal; tick the MVP plan's manual smoke tests (lines
  1459–1462 of `docs/superpowers/plans/2026-07-05-toril-tui-mvp.md`, which lives on
  the **`feat/toril-tui`** branch, not on `main`). No new feature code — do this
  **first** when the track resumes.
- [ ] **Delete → trash key** — wire a delete keybinding to the existing (tested but
  UI-less) `trashbin` crate. Small, high-value; makes the TUI the *first* surface for
  soft-delete. Refresh the tree after; keep the unsaved-changes guard.
- [ ] **In-document find** — search-within-open-file (highlight + `n`/`N` cycle, e.g.
  `Ctrl-F`). Self-contained, fully headlessly testable; mirrors the desktop Find.
- [ ] **Multi-file tabs** — per-tab buffers + a tab strip, matching the desktop app's
  multi-document model. Larger increment: touches app state, keymap, and layout.
- [ ] **RTF / HTML export** — reuse the existing `mdrtf` / `mdhtml` crates from the TUI
  (both already webview-free), so export parity comes nearly for free.

---

## 6. New crates at a glance

All follow the `crates/*` pattern: webview-free, unit-tested, healthy pure-Rust deps.

| Crate | Job | Key dep (healthy) | Branch |
|---|---|---|---|
| `trashbin` | Soft-delete + restore (atomic) | — | `feat/safe-delete-trash` |
| `snapshots` | Content-addressed local version history | hand-rolled (`sha2` + `flate2`); see §8 | `feat/local-version-history` |
| `mergemd` | 3-way markdown merge + conflict files | `similar` | `feat/sync-coexistence` |
| `vaultsearch` | Incremental full-text vault index | `tantivy` | `feat/vault-search` |
| `linkgraph` | `[[link]]`/`#tag` parse + backlink index | hand-rolled / `pulldown-cmark` | `feat/wikilinks-backlinks` |
| `highlight` | Code → highlighted spans | `syntect` (`fancy-regex`) | `feat/code-highlighting` |
| `embedindex` | Local embeddings + vector search | Ollama + `instant-distance` | `feat/vault-rag-chat` |

Frontend-only (healthy npm, bespoke Milkdown nodes — no crate): **KaTeX**, **Mermaid**.
Secrets: **`keyring`** crate (OS keychain) for AI provider keys.

---

## 7. The single most important sequencing rule

**Trust before reach.** Movement I gates everything. It is what makes the app
recommendable for daily use, and it is the floor the AI layer stands on — an
assistant that edits your files is only safe on top of snapshots and atomic writes.
Build the floor before the differentiators, and don't promote the app past what the
floor supports. Everything else is execution.

---

## 8. Open decisions (resolve as we reach them)

- ~~**Snapshot store:** `gix` vs. a hand-rolled content-addressed store?~~ **Resolved
  (2026-07-08): hand-rolled CAS** (`crates/snapshots`). We only need blob-by-hash + a
  manifest + custom time-decay thinning, not git semantics; a ~200-LOC pure-Rust crate
  fits the house ethos and avoids `gix`'s large surface.
- **AI providers at launch:** Anthropic + Ollama only, or also OpenAI? (Lean Anthropic +
  Ollama first — on-brand and covers free/local.)
- **Beta graduation bar:** which exact branches must be green to drop `-alpha`? (Proposed:
  all of Movements I–II.)
- **Mobile scope for v1.0:** full edit parity, or read + light-edit first? (Lean
  light-edit first; the sandbox makes full parity expensive.)
