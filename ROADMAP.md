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

> **Status (2026-08-18).** Shipped through **`v1.0.0`** (see `CHANGELOG.md`).
> **Movement I, branches 1–4 are complete** (autosave + crash-recovery journal;
> safe-delete-to-trash; local version history; sync coexistence — 3-way merge, conflict
> banner, parked conflict copies). **Branch 5 has landed** on `feat/release-readiness` —
> self-update, window state and the QoL batch — leaving only Azure Trusted Signing, which
> is blocked on provisioning an account rather than on code. From Movement II,
> **branch 11 (outline panel) and branch 10 (front-matter properties)** have landed — 10
> out of order, because front matter was being *corrupted* rather than merely unsupported,
> which made it a §3 fix rather than a convenience.
>
> **This document previously pointed at branch 6 with branch 5 unstarted, and that was
> overtaken by `v1.0.0` shipping.** The ladder in §2 ties release-readiness to
> `v0.2.0-alpha`; the tag ran past it, which turned "no auto-updater" from a scheduling
> detail into a live problem — every 1.0.0 install had no way to receive anything built
> after it, so the next feature could not have reached anyone. §7's *trust before reach*
> is what settles the order. Read the pointer below as the ordering, not the ladder.
>
> **Branch 12 (sidebar file operations) has also landed** — PR #41, stacked on branch 5's
> PR #40 — taken ahead of 6 for the same kind of reason 10 was: it wired two crates —
> `trashbin` and `snapshots::rekey` — that had shipped with **no caller at all**, and until
> it landed a note could be opened and saved but not renamed or deleted without leaving the
> app. **Branch 12b (chrome rework) is ticked too**; it shipped on `main` 2026-08-12 and this
> document had simply never recorded it.
>
> **▶ In progress: Movement II, branch 6 — `feat/vault-search`.** (Branch 5 is done bar
> Azure signing, which is blocked on an account, not on code.)
> Search is the largest remaining functional gap, and branch 7
> (command palette) depends on it. Vet `tantivy` per §2 at
> adoption — it would be the project's largest new dependency, and worth weighing
> against a hand-rolled inverted index the way the snapshot store was weighed
> against `gix` (§8). Branch 4's spec lived
> **on its own branch**, not on `main`:
> `docs/superpowers/specs/2026-07-24-sync-coexistence-design.md`; branch 10's is on
> `main` at `docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`.
>
> *Landed since, outside the movement ladder:* a serializer-normalization precursor
> (canonical markdown now matches Obsidian — `-` bullets, `---` rules, tight lists
> preserved), which exists to keep branch 4's 3-way merge from drowning in
> reformatting noise; a fix for programmatic loads marking every document dirty; CI running
> the headless gates on Ubuntu and Windows for every pull request; and the GitHub
> community-standards docs. (The chrome/layout rework — CLAUDE.md §12b — used to be listed
> here as outside the ladder. It is not: it is **branch 12b**, and it is ticked below.)
>
> *Version note, and read it before leaning on the number:* `v1.0.0` says the editor and
> its data-safety floor are ready to depend on — **not** that this roadmap is finished.
> Movement I branch 5 and most of Movement II remain, so a 1.0 user still has no vault
> search, quick switcher, links, or tags. The indicative ladder in §2 is guidance, not
> gospel, and the tag has run ahead of it twice now; §3's trust-before-reach rule still
> governs what may be *reached* from the UI, regardless of version.

> **Status update (2026-11-09) — who is actually using it, and a §3 fix it surfaced.**
> Toril is seeing heavy use by **radiology / medical students**. That audience changes
> priorities: their notes are image-heavy, structured around cases, studied rather than
> just written, often live in an Obsidian vault they also read on a phone, and sometimes
> brush against patient-identifying images. Two new tracks below — **Track H
> (hardening)** and **Track M (medical & radiology students)** — and §9 (value Toril
> does not offer today) come out of that review.
>
> Reviewing for that audience found a **§3 round-trip bug**: saving an *edited* note
> backslash-escaped Obsidian syntax — `[[link]]` → `\[\[link]]`, `![[img.png]]` →
> `!\[\[img.png]]`, `> [!tip]` → `> \[!tip]` — which Obsidian renders as literal text,
> so links, embedded images and callouts broke. It also rewrote ordinary prose
> (`figure [1]`, `~3 cm`, `snake_case`). **Fixed on `fix/obsidian-syntax-escaping`**:
> `src/editor/escapes.ts` removes every escape that re-parsing *proves* unnecessary.
> Branch 8 was framed as a feature; its *preservation* half was really a data-safety
> fix, the same way front matter (branch 10) was. Rendering and navigation remain branch 8.
>
> **Recommended order from here** (audience-weighted; supersedes the numbering for
> sequencing, not the numbering itself):
> 1. Ship `fix/obsidian-syntax-escaping` as a patch release — it is a §3 fix.
> 2. Merge **branch 6 (vault search)** — already built on `origin/feat/vault-search`.
> 3. **H1** vault-wide repair of notes damaged by earlier saves, and **H2** save
>    compare-and-swap (closes the documented TOCTOU).
> 4. **H3 / H4** images in and out of notes the way Obsidian expects.
> 5. **H5** render what H0 now preserves: clickable wikilinks, image embeds, callouts.
> 6. **M1** templates → **M2** case log.
> 7. **M5** privacy kit, **M6** self-quiz, **M3** image viewing.
> 8. Branches 9 (tags) and 7 (palette); then **M7 / M8** study tools; then AI, local-first.
>
> Deprioritized for this audience: 13 (code highlighting), 16 (focus/typewriter),
> 17 (writing stats), and 28 (own mobile app — see §8: with faithful Obsidian syntax,
> Obsidian mobile on the same synced vault *is* the mobile story).

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

- [x] **4. `feat/sync-coexistence`** — make folder-sync bulletproof: detect external edits
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

- [~] **5. `feat/release-readiness`** — auto-update + signing + first-run, so the floor is
   *shippable to strangers*. **Split in two; the update half has landed.**
   - [x] *Update half (2026-08-17).* **`tauri-plugin-updater`** + **`-process`** +
     **`tauri-plugin-window-state`**, all official and pinned (2.10.1 / 2.3.1 / 2.4.1).
     Notify-only by policy — Toril offers, the user decides, and a restart is refused
     over a dirty buffer (§3). Rules in `src/update.ts`, gated by `tests/update.test.ts`;
     toast in `src/ui/updatenotice.ts`; minisign signing + the fail-fast preflight in
     `release.yml`; Authenticode wiring inert until an Azure account exists. See
     `docs/RELEASE-SIGNING.md` and CLAUDE.md §5 (Self-update).
     - **Blocked on one manual step:** generate the minisign keypair, paste the public
       half into `plugins.updater.pubkey`, add the private half as a repo secret. Until
       then the updater is present but keyless.
   - [x] *QoL half (2026-08-17).* Editor zoom (`Ctrl +/-/0`, a fixed ladder so it cannot
     drift — `src/zoom.ts`); recent-files MRU in File → Open Recent (`src/recent.ts` +
     `set_recent_files`, which rebuilds the native menu); open-links-in-browser on
     Ctrl-click behind a three-scheme allowlist (`src/links.ts` — a §3.3 boundary, since
     the OS shell is not sandboxed the way the webview is); drag-drop to open, filtered
     by `paths.selectOpenable`; and a real **first-run welcome note** distinct from the
     empty state (`src/welcome.ts`), which is itself a round-trip fixture — it claims
     Toril doesn't rewrite your files, so it has to survive its own first save.
   - [ ] *Azure Trusted Signing.* Wiring done (`tauri.signing.conf.json` overlay, applied
     in CI only when `AZURE_*` secrets exist, so a fork still builds). Needs an account and
     an identity validation that takes business days — then update the placeholder account
     names and soften the SmartScreen note in `README.md` + `docs/index.html`.
   - *Touches:* `tauri.conf.json`, `.github/workflows/release.yml`, `settings.rs`,
     `menu.rs`, `main.ts`.
   - *Gate:* `tests/update.test.ts` for the policy; §D of `docs/ON-DEVICE-VERIFICATION.md`
     for everything downstream of the network, which no headless gate can reach.
   - [~] **⬢ RELEASE `v0.2.0-alpha`** — *"Safe to live in."* **Overtaken by the `v1.0.0`
     tag**, which shipped the data-safety floor under a number this ladder never planned
     for. Kept as the record of what the release point *meant* — the first build you can
     hand to someone without an asterisk on their data — not as a version still to be cut.
     The floor itself is complete; only Azure Trusted Signing is outstanding, and it is
     blocked on provisioning, not on code.

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
   - *Preservation already done (H0, 2026-11-09):* `[[links]]` and `![[embeds]]` survive a
     save byte-for-byte. Before that fix they were escaped on save, which made this a §3
     bug and not only a missing feature. What remains here is rendering, navigation,
     autocomplete and backlinks (shared with H5).
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

- [x] **10. `feat/frontmatter-properties`** — *(shipped in `v1.0.0`, pulled forward: front
    matter was being **corrupted**, not merely unsupported.)* A collapsible properties
    strip above the editor, typed rows where the block provably re-serializes byte-exact
    and raw text otherwise; YAML, TOML and JSON. **Closed the deferred front-matter
    round-trip gate.**
    - *Built:* `src/editor/frontmatter.ts` (the splitter — front matter never enters the
      ProseMirror doc, so `serializer.ts` was left alone), `frontmatter-values.ts`,
      `src/ui/properties.ts`.
    - *Gate:* the `frontMatter` class in `roundtrip.test.ts` (the §0 to-do) +
      `frontmatter`, `frontmatter-values` and `properties` suites.
    - *Open:* on-device verification (`docs/ON-DEVICE-VERIFICATION.md` §C), and format
      conversion between the three, deliberately never automatic.

- [x] **11. `feat/outline-panel`** — heading outline / TOC; click to scroll. Cheap, pure
    frontend (was §13 backlog).
    - *Touches:* `src/ui/outline.ts`. *Gate:* `tests/outline.test.ts`.

- [x] **12. `feat/sidebar-file-ops`** — *(shipped)* new / rename / delete / new-folder via a
    context menu; delete routes through `trashbin` and offers **Undo** rather than a
    confirmation, because a move into `.trash/` is reversible by construction. Wires two
    crates that had no caller: `trashbin` and `snapshots::rekey`.
    - *New crate:* `crates/fileops` — name validation (the Windows rules, applied on every
      platform, since a vault is a folder that gets synced), vault containment, and
      create/rename that refuse to clobber. Deliberately returns paths in the **caller's**
      spelling: `canonicalize` is used to check containment and never to build a result,
      because on Windows it yields `\\?\C:\…`, which matches neither the sidebar tree nor an
      open tab nor a note's history key.
    - *Built:* `commands/entries.rs` (thin wrapper + the history rekey, best-effort so it can
      never fail a rename that already happened), `src/ui/contextmenu.ts`, file-ops UX in
      `src/ui/sidebar.ts`.
    - *§3:* the rename ordering in `main.ts`'s `doRenameEntry` — the watcher reports a rename
      as delete-then-create, so tabs are re-pointed, `removalEpoch` bumped and `removedOnDisk`
      cleared in one synchronous block, or an open tab would offer to recreate the old note
      beside its new name.
    - *Gate:* `cargo test -p fileops` + `tests/sidebar.test.ts` + `tests/contextmenu.test.ts`.
    - *Open:* drag-to-move in the tree, multi-select, and a trash browser (`list_trash` is
      wired to no UI, so Undo reaches only the most recent delete). On-device verification in
      `docs/ON-DEVICE-VERIFICATION.md` §E.
    - [ ] **⬢ RELEASE `v0.5.0-beta.1`** — *"A real notes system."* First **beta**.

---

### Movement III — Writing Craft · *the editing surface itself*

**Why:** this is the iA Writer / Typora lane — syntax highlighting, math, diagrams,
and the focus modes. Mostly frontend, comparatively cheap, and it is the difference
between an editor that works and one that is pleasant to spend hours in.

**Branches**

- [x] **12b. `feat/chrome-ux`** — *(shipped 2026-08-12)* the UI shell around the editor: a **single tabbed right
    rail** (outline and history become alternatives, not two rails), pane collapse/expand
    that actually animates, drag-to-resize with persisted widths, pointer-adaptive touch
    targets, a real design-token layer, and **real menu accelerators**. Taken out of
    numbering order because it is *infrastructure*: the search panel (Movement II) and the
    AI panel (Movement IV) both plug into the rail, and building them against four
    independent rails would mean building them twice.
    - *Motivating defects (found by driving the app, not reading it):* collapse cannot
      animate (`display:none` cancels transitions); four rails leave a Surface Pro 580px
      for a 720px measure; hover and selection share a color; `Inter` is named in the font
      stack but never bundled, so **Windows renders the UI in Arial**; menu shortcuts are
      baked into label text instead of registered as accelerators.
    - *New:* `src/ui/panes.ts` (pure state), `src/ui/resizer.ts` (pure geometry),
      `src/ui/rail.ts`; `src/styles/` split into tokens/chrome/editor.
    - *Touches:* `tabs.ts`, `toolbar.ts`, `app.html`, `menu.rs`, `settings.rs`.
    - *Gate:* `tests/panes.test.ts` + `tests/resizer.test.ts`, plus a browser-harness
      sweep (`dev-harness.html`) covering target sizes, reduced motion, focus rings, and
      keyboard traversal of collapsed panes.
    - *Design:* `docs/superpowers/specs/2026-08-12-ui-ux-chrome-rework-design.md`;
      human-only checks in `docs/ON-DEVICE-VERIFICATION.md` §A.

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

### Track H — Hardening · *make "Obsidian-compatible" and "never loses a note" fully true*

**Why:** each item below is a place where a claim in the README is weaker than it
reads. None is glamorous; all of them are what a heavy daily user hits first.

- [x] **H0. `fix/obsidian-syntax-escaping`** — *(2026-11-09)* proof-checked escape
  minimization in the canonical serializer, so wikilinks, embeds, callouts and plain
  prose survive a save byte-for-byte. See CLAUDE.md §0.
  - *Built:* `src/editor/escapes.ts`, wired in `serializer.ts`.
  - *Gate:* `tests/escapes.test.ts` (search + 200-case property over the real parser) and
    the `obsidianPreserved` / `escapesKept` classes in `roundtrip.test.ts`.
  - *Open:* serialization now costs about one extra full parse (~180 ms at 12k words in
    jsdom, paid on the debounced change listener). If very long notes feel sluggish, take
    the whole-document proof off the dirty check, which only needs to know whether the text
    differs from disk, and keep it on the write path.
  - *Pre-existing quirks found while gating, not yet fixed:* a bare URL ending in `\`
    gains a backslash on every save; remark moves a space out of a strikethrough
    boundary. Both reproduce on `main` without H0.

- [ ] **H0b. Findings from a real vault (2026-11-09).** H0 was checked against a
  179-note personal Obsidian vault: each note was split, round-tripped and rejoined
  exactly as `main.ts` does, on a copy. Results:
  - Before H0, saving broke links in 23 notes: 352 wikilinks/embeds/callout markers
    came back as 296.
  - After H0, no note lost a link, no note loads differently, and no note became
    unstable.
  - The only differences between `main` and H0 across the whole vault are 1,175 removed
    backslashes and 81 removed autolink `<…>` pairs.

  The same run surfaced rewrites and a crash that predate H0. Each one is a §3 item, in
  order of reach:
  - **A note containing `®`, `©` or `™` fails to load** in the jsdom gate
    (`RangeError: Invalid array passed to renderSpec`). It comes from `@milkdown/plugin-emoji`
    treating those characters as emoji: the same input loads fine without the plugin.
    **Confirm in WebView2/WKWebView first.** If it reproduces there, it is the most urgent
    item on this list: medical notes are full of `®` drug and contrast-agent names.
  - **An empty list item `- ` is saved as `- <br />`** in 56 of 178 notes. Obsidian users
    routinely leave a trailing empty bullet, and Toril writes raw HTML into the file.
  - Blank-line normalization, in about 130 notes.
  - Trailing whitespace stripped, in 71 notes. This is not in CLAUDE.md's
    normalization list.
  - Table re-padding, in 31 notes (already pinned as `tablePadding`).
  - Tab-indented nested lists rewritten to two spaces.
  - Emphasis split around inline code: `_Source: \`path\`_` → `_Source:_ _\`path\`_`.

  Each needs a fixture pinning today's behavior before it is changed, as with every
  `normalized` entry.

- [ ] **H1. `feat/repair-escaped-syntax`** — a vault-wide, **explicit** action that finds
  notes damaged by pre-H0 saves (`\[\[`, `!\[\[`, `> \[!`) and repairs them. It shows the
  list and per-file diff first, snapshots every file before writing, and writes atomically.
  Never automatic (§3: no unrequested rewrites). Opening and saving a note in Toril already
  repairs it, which is pinned as `repairsEscapedObsidianSyntax`. This is for the ones
  nobody reopens.
  - *Touches:* reuse `vaultsearch` for the scan; `snapshots` + `fsatomic` for the write.
  - *Gate:* repair is idempotent; a note with no damage is byte-untouched.

- [ ] **H2. `fix/save-compare-and-swap`** — close the documented TOCTOU (CLAUDE.md §5,
  "Known limit of the guarantee"): `save_file` takes the expected base hash and refuses
  the write unless the bytes on disk still match, inside the same Rust call.
  - *Gate:* `fsatomic`-level test with a write landing between check and rename.

- [ ] **H3. `feat/image-insertion`** — image input that works the way people try it:
  - Drag an image file onto the editor and it is inserted. Today a drop only *opens*
    files, and images are not on that allowlist, so they are silently dropped.
  - Paste into an **unsaved** note: stage the image, and move it into place on first save.
  - Paths with spaces, written as `<…>` or `%20`. Obsidian accepts both; CommonMark rejects
    a raw space.
  - Large-image guard: warn above a size threshold, and optionally downscale a *copy*.
  - *Gate:* `imgasset` tests + a drop-allowlist case in `tests/paths.test.ts`.

- [ ] **H4. `feat/obsidian-attachment-settings`** — read `.obsidian/app.json`
  (`attachmentFolderPath`, `newLinkFormat`, `useMarkdownLinks`), so a pasted image lands
  where Obsidian would put it and is written as `![[…]]` or `![](…)` to match the vault.
  Read-only on `.obsidian/`; never write it. With no `.obsidian/`, keep `./assets/`.

- [ ] **H5. `feat/obsidian-rendering`** — the rendering half of branch 8 plus its siblings:
  - Clickable `[[wikilinks]]` (navigation only, resolved by `linkgraph`).
  - Rendered `![[image.png]]` and `![[image.png|400]]`.
  - Callouts `> [!type] Title`, including foldable `+`/`-`.
  - The `==highlight==` mark.

  Each must stay a canonical node whose markdown form is *exactly* the Obsidian spelling,
  so the H0 fixtures double as this branch's round-trip gate.

- [ ] **H6. `feat/trash-and-purge`** — a trash browser (`list_trash` already has a command
  and an `ipc.ts` wrapper) plus **permanent delete**. Permanent delete removes the
  `.trash/` entry, the note's `history/` directory, and any `recovery.json` entry, after an
  explicit confirm. Today nothing Toril deletes is ever really gone, and §M5 explains why
  that matters.

- [ ] **H7. Small items, each a few lines but each a stated promise:**
  - `spellcheck="true"` on the editable, verified in WebView2. Also check whether the DOM
    context menu suppresses the native spelling suggestions.
  - Decide `app.security.csp` (CLAUDE.md §0, still open #3).
  - Show `.html`/`.htm` in the sidebar, since HTML is advertised as first-class.
  - Pull **branch 24 (per-tab undo)** forward. Losing undo on every tab switch is a daily
    irritation, not a Movement V concern.

- [ ] **H8. Reconsider PDF export (§7).** Students print and share study sheets, and
  HTML → browser → "Save as PDF" is friction they notice. Re-weigh the per-platform
  print APIs against the demand that now exists. Alternatively, a one-click "Print"
  that opens the exported HTML in the default browser's print dialog would reduce the
  friction without new unsafe FFI.

---

### Track M — Medical & radiology students · *the audience that showed up*

**Why:** a radiology note is a **case**: images first, a fixed structure (history →
findings → impression → differential → pearls), studied repeatedly, and sometimes
derived from material containing patient identifiers. Obsidian can approximate all of
this with five community plugins; Toril can do it out of the box, and the
local-first, no-account stance is a real fit for sensitive material. Keep every item
plain-markdown and Obsidian-readable: these users also open the vault in Obsidian,
often on a phone.

- [ ] **M1. `feat/daily-notes-templates`** (= **branch 18**, pulled forward) with
  **starter templates** shipped as ordinary `.md` files the user can edit:
  - *Case note:* front matter for `modality`, `region`, `diagnosis`, `source`,
    `rotation`, `date` and `tags`, then History / Technique / Findings / Impression /
    Differential / Teaching points.
  - *Structured report:* a Technique / Comparison / Findings / Impression skeleton in
    the familiar structured-reporting shape.
  - *Topic note:* Definition / Imaging features by modality / Mimics / Pearls / Pitfalls.
  - *Differential table:* a GFM table template.
  - *Gate:* `tests/templates.test.ts`. Every shipped template is also a round-trip
    fixture, the same discipline as the welcome note.

- [ ] **M2. `feat/case-log`** — a table view of front-matter properties across the vault,
  sortable and filterable (*every CT chest case on my IR rotation*), with **CSV
  export** for logbooks and applications. The properties strip already parses all three
  formats.
  - *Shape:* Rust returns raw front-matter blocks and the TS side parses them with the
    *existing* `frontmatter-values.ts`. Do **not** add a Rust YAML crate: `serde_yaml` is
    archived, so it fails §2.
  - *Touches:* a `vault_properties` command (sibling of `vaultscan`) and
    `src/ui/caselog.ts` in the rail or a tab.
  - *Gate:* the splitter parity cases (TS ⇄ Rust) + a pure table-model test.

- [ ] **M3. `feat/image-viewing`** — radiology is read on black:
  - Click an image to open a lightbox with zoom and pan on a black background.
  - Consecutive images in one paragraph lay out **side by side** (prior vs current,
    T1/T2/FLAIR). This needs no new syntax, so it stays Obsidian-portable.
  - Alt text shown as a caption.
  - A low-luminance "reading room" theme.
  - **Do not build a DICOM viewer**: screenshots are the medium, and DICOM parsing pulls in
    a large, risky surface.

- [ ] **M4. `feat/image-annotation`** — arrows, circles and short labels drawn on a
  **copy** (`scan.annotated.png`); the original is never modified, and the note links
  the copy. Canvas in the frontend, written through `imgasset`. Larger than it looks;
  scope to three tools and undo.

- [ ] **M5. `feat/privacy-kit`** — for material that may carry patient identifiers:
  - **Strip image metadata** on insert (JPEG APPn/EXIF, PNG text chunks), done losslessly
    in `imgasset` by dropping segments rather than re-encoding.
  - **Crop on insert**, to cut burned-in names or record numbers off a screenshot before
    it is ever written.
  - **Permanent delete** (H6). Today a deleted note survives in `.trash/`, which sits
    *inside* the synced vault, and in version history.
  - A short `docs/` page on using Toril with clinical images: de-identify first, follow
    your institution's policy, and think twice before a consumer cloud sync. **Never
    claim HIPAA or GDPR compliance**: Toril is a local editor, and compliance is about the
    whole workflow.
  - *Gate:* `imgasset` tests that stripped output decodes identically and carries no
    metadata segments.

- [ ] **M6. `feat/self-quiz`** — unknown-case practice:
  - Callouts folded with `-` (`> [!question]- What is the sign?`) render **collapsed**
    and open on click.
  - A per-note "hide answers" toggle collapses every foldable callout and `<details>`.
  - Optionally hide sections by heading (Impression, Diagnosis) until revealed.

  It is purely view state, and the file never changes. Depends on H5's callout rendering.

- [ ] **M7. `feat/flashcard-export`** — export `{{c1::cloze}}` and `Q::A` lines (the
  Obsidian_to_Anki syntax, both already pinned as preserved) to an Anki-importable
  **CSV**. An `.apkg` file needs SQLite, which means C (`rusqlite` bundles it) and fails
  §2's C-free rule, so do not build it. Media cannot ride a CSV, so say so in the dialog.
  Building spaced repetition *into* Toril is out of scope: students already use Anki, and
  the job is to feed it.

- [ ] **M8. `feat/review-queue`** — lightweight review without Anki: `review_next:` /
  `last_reviewed:` front-matter dates, a "due today" list in the rail, and a "Reviewed"
  action that updates the property. Uses typed rows, so it is only offered when the
  block re-serializes byte-exact.

- [ ] **M9. `feat/text-snippets`** — user-defined expansions (`;nlcxr` → a normal chest
  radiograph paragraph), stored as a plain `.md` file in the vault so they sync and
  stay editable. Insertion is a ProseMirror transaction, never raw text (§3.2).

- [ ] **M10. Medical spelling** — depends on H7's spellcheck. A user dictionary that
  persists, and optionally a bundled medical word list, **after a licence check** (several
  common medical dictionaries are GPL or unclear; §2 applies to data too).

- [ ] **M11. Pull forward branch 15 (Mermaid)** — decision trees and imaging algorithms
  are a staple of these notes, far more than code highlighting or math.

- [ ] **M12. AI, local-first for clinical content** — when branch 20 lands, default to
  **Ollama**, and require an explicit per-vault opt-in, with a plain warning about patient
  data, before any note goes to a cloud provider. Useful and low-risk: generate flashcards
  or quiz questions from a note, summarize, outline. **Do not** build "suggest a diagnosis"
  or differential features: the accuracy and liability profile is wrong for an editor. The
  MCP bridge (branch 23) needs the same opt-in.

- [ ] **M13. `feat/web-clip`** — paste from a reference site keeps structure, downloads
  remote images into the attachment folder (offline study, no link rot), and records
  `source:` in front matter for attribution. Sanitize as always (§3.3).

- [ ] **M14. `feat/case-presentation`** — present a note as slides (split on `---` or H2),
  image-first on black, arrow keys to advance: case conferences and teaching rounds. A
  view, not a format, so there is nothing new to round-trip.

- [ ] **M15. Portable build** — a zip that runs without installing, for locked-down
  hospital and library PCs (WebView2 is already present on Windows 11). Settings and
  history stay beside the executable when a marker file says so.

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
| `fileops` | Create/rename: name rules, containment, no clobber | — | `feat/sidebar-file-ops` |
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
- ~~**Right-rail coexistence:** should the outline and version-history panels be
  independent rails, stacked accordions, or mutually exclusive?~~ **Resolved (2026-08-12):
  one tabbed rail** (`feat/chrome-ux`). Two independent rails cost 460px, leaving a
  Surface Pro less than the editor's 720px measure; a tabbed rail bounds chrome at 240px
  and gives later panels (search, AI) a defined place to live.
- **AI providers at launch:** Anthropic + Ollama only, or also OpenAI? (Lean Anthropic +
  Ollama first — on-brand and covers free/local.)
- **Beta graduation bar:** which exact branches must be green to drop `-alpha`? (Proposed:
  all of Movements I–II.)
- **Mobile scope for v1.0:** full edit parity, or read + light-edit first? (Lean
  light-edit first; the sandbox makes full parity expensive.) **Re-opened 2026-11-09:**
  with Obsidian syntax now preserved (H0), Obsidian mobile reading the same synced
  vault may simply *be* the mobile answer — a quarter of work (branch 28) against a
  free, mature client. Decide after H5 makes the desktop side render what mobile
  writes.
- **How far to specialize for medical users?** Track M is mostly general-purpose
  features with medical *defaults* (templates, case log, quiz, privacy). Keep it that
  way: a templates system with a radiology starter pack, not a radiology app. Revisit
  if the audience broadens or narrows.
- **Learn the audience without telemetry.** Toril does not phone home, and that stays.
  Use an opt-in feedback channel (a GitHub Discussions category, or a short survey
  linked from Help) and talk to a handful of the students directly before committing
  to the larger M items (M2, M4).

---

## 9. Value Toril does not offer today (unplaced — pull from here)

Ideas that came out of the 2026-11-09 review, beyond Tracks H and M. Unscheduled and
in scope, held to the same rules: plain files, one serializer per format, all disk
I/O in Rust, healthy dependencies only.

| Idea | Why it matters | Notes / constraints |
|---|---|---|
| **Split view** — two notes side by side | Comparing cases, writing from a source note | Today one shared editor swaps content (branch 24 is the prerequisite) |
| **PDF reader pane** with page-linked notes | Lecture slides and papers are where study notes come from | `pdf.js` (Mozilla, healthy); a link format like `[[deck.pdf#page=12]]` matches Obsidian |
| **Study-packet export** — many notes → one HTML (later PDF) | Printable revision packs, sharing with a study group | Reuses `mdhtml` + the sanitize chokepoint; ordering by folder or a list note |
| **Vault health check** | Broken `[[links]]`, orphaned attachments, oversized images, H1 damage | Read-only report; any fix is a separate, explicit, snapshotted action |
| **Citations** — Pandoc `[@key]` + a Zotero (Better BibTeX) JSON file | Research-track students and residents | `[@key]` already survives a save (H0); render a reference list on export |
| **Searchable image text (OCR)** | Find a case by text inside a screenshot | Use the OS engines (Windows.Media.Ocr, macOS Vision) through Rust bindings; Tesseract is C and fails §2. Store results outside the vault, like history |
| **Scheduled backup** — vault + history to a second folder or zip | Version history lives in the app config dir; a disk loss takes both | Atomic, additive, opt-in; never into the vault itself |
| **Import cleanup** — Notion, OneNote, Evernote exports | Students arrive from OneNote and Notion | Notion's escape-heavy markdown is now normalized by H0 on first edit; an explicit batch import is the remaining piece |
| **Link previews** for reference URLs | Context on hover | Any network fetch is a privacy decision: opt-in, no telemetry, nothing sent but the URL the user wrote |
| **Shared study vault guidance** | Groups already share a synced folder | The conflict machinery (branch 4) is built for this; it needs documenting more than code |

**Considered and deliberately left out:** a graph view (rarely used after the first
week; backlinks carry the value), a plugin system (README: "no plans"), and an in-app
spaced-repetition engine (feed Anki instead — M7).
