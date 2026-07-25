# Design — Sync Coexistence (`feat/sync-coexistence`)

> ROADMAP Movement I (Trust Foundation), branch 4. Make Toril flawless at living
> in a folder synced by iCloud Drive / OneDrive / Dropbox / Syncthing / Git —
> detect external edits to open files, 3-way merge where safe, park a conflict
> copy otherwise. **This is Toril's entire sync story** (ROADMAP §0, fact 1): we
> do not build sync infrastructure, we become excellent at coexisting with it.
>
> This is a **data-safety** feature. Its single hard constraint: a conflict must
> **never** silently overwrite either side (CLAUDE.md §3).

- **Date:** 2026-07-24
- **Branch:** `feat/sync-coexistence`
- **Status:** approved design → implementation

---

## 1. Goal & non-goals

**Goal.** When a file open in Toril changes underneath the editor, the user
never loses bytes — theirs or the external writer's. Non-overlapping edits merge
into the buffer automatically and are reviewed before saving; overlapping edits
raise a clear banner whose every resolution preserves both sides on disk.

**Non-goals (v1).**

- **No interactive per-hunk merge review UI.** A "review each merged hunk"
  surface is a natural follow-up but is a second feature; v1 merges cleanly or
  asks.
- **No rename correlation** in the watcher. `notify` reports a rename as
  remove + create and we treat it as such.
- **No coupling to `crates/snapshots`.** The merge base is in-memory (§2). Saves
  continue to snapshot as they already do, so a merged result is versioned for
  free once saved.
- **No real-time / collaborative merge.** Toril is single-writer; this feature
  reconciles asynchronous writers, not concurrent ones.
- **No conflict handling for directories** or for files not open in a tab. A
  vault file Toril has never opened has no buffer to conflict with.

---

## 2. Decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| Merge base (common ancestor)? | **In-memory per-tab `base`** — the exact bytes last read from or written to disk. | Zero new storage, always exactly right while the app runs, no coupling to `snapshots` and so no exposure to its time-decay thinning. After a restart there is no ancestor, so a diverged file falls back to `Conflict` — safe, and narrow in practice because crash recovery reopens dirty buffers. |
| Default behaviour on divergence of a dirty tab? | **Auto-merge into the buffer when safe; prompt only on true conflict.** | Matches ROADMAP I.4 ("3-way merge where safe"). Merging into the *buffer* writes nothing to disk, so the merge is reviewable and undoable before it becomes bytes. Keeps interruptions rare under a chatty sync daemon. |
| Which side is parked on a true conflict? | **The losing side, in both directions.** *Keep mine* parks theirs; *Use theirs* parks mine. | Strictest reading of "never silently overwrite either side". Symmetric and easy to explain. Notably, today's `confirm()` discards unsaved work on one OK click — that path goes away. |
| Merge granularity? | **Line-based diff3 on `similar`.** | Proven algorithm (git, diff3). Format-agnostic, no second markdown parser (which would brush against §3.2's one-canonical-converter rule), ~150–200 LOC pure Rust. Rejected: block-aware markdown merge (needs a parser, no story for HTML); word/char merge (highest chance of splicing two people's sentences into something neither wrote — the worst failure mode for a notes app). |
| Auto-merge for HTML tabs? | **No.** Markdown only; HTML divergence goes straight to the banner. | A line-level merge of two HTML documents can produce structurally invalid markup (unbalanced tags across hunks), which `html-serializer.ts` would then normalize on load — corrupting silently. |
| Where does the correctness guarantee live? | **In the save path, not the watcher.** Every save re-checks disk before writing. | Watchers drop and coalesce events on network shares, some FUSE mounts, and a few sync clients. A design protected only by "we got notified" fails silently on exactly the setups this branch exists to support. |

---

## 3. `crates/mergemd` — the merge core

Pure Rust, **no Tauri** (unit-testable anywhere, per §0). Pure computation plus
filename selection; it never writes the target file. `fsatomic` remains the only
thing that writes notes (§3.1).

### 3.1 Dependencies (healthy, C-free — §2)

- **`similar`** — diff primitives. Maintained by Armin Ronacher (`mitsuhiko`),
  active publish history, pure Rust, widely used. Vetted per §2.

Nothing else beyond `std`. Conflict-name collision checking uses `std::fs`.

### 3.2 API

```rust
pub enum Divergence {
    /// theirs == base — no real external change (this is where self-writes die).
    Unchanged,
    /// mine == base — the buffer has no edits; theirs loads losslessly.
    TheirsOnly,
    /// Non-overlapping hunks combined cleanly.
    Merged(String),
    /// Both sides edited the same region differently.
    Conflict,
}

/// Three-way merge. Never panics; never returns partial content.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Divergence;

/// Pick an unused `<stem> (conflict <ts>)<.ext>` path beside `original`.
pub fn unique_conflict_path(original: &Path, now: SystemTime) -> io::Result<PathBuf>;
```

### 3.3 Algorithm

Classic diff3:

1. Diff `base → mine` and `base → theirs` with `similar`.
2. Project both change sets into **base line coordinates**.
3. Walk them together:
   - region touched by exactly one side → take that side;
   - region both sides changed **identically** → take it once (convergent edit);
   - region both sides changed differently → `Conflict`.
4. Short-circuits: `theirs == base` → `Unchanged`; `mine == base` →
   `TheirsOnly`.

**Line terminators travel with their lines.** If the buffer is LF and an
external Windows editor wrote CRLF, a naive line merge rewrites every line
ending in the file — a whole-file diff in git and in the user's vault for a
one-line semantic change. Each line keeps its original terminator so a merged
file only changes the lines that actually changed.

### 3.4 Conflict-file naming

`note (conflict 2026-07-24 14-32-05).md` — Obsidian-style, beside the original.

- **Dashes, not colons.** A colon is illegal in a Windows filename and Windows is
  the primary target (§1).
- **Collisions get a `-2`, `-3`… suffix; never an overwrite.** A conflict file is
  itself user data that must not be clobbered.
- The extension is preserved, so a parked `.html` stays `.html`.
- Conflict files live in the vault and so are visible in the sidebar and to
  Obsidian — deliberate: the user must be able to find the parked side.

### 3.5 Gate — `cargo test -p mergemd`

- Each of the four `Divergence` outcomes.
- Convergent edits (both sides made the *same* change) merge, not conflict.
- Two inserts at the same position conflict.
- CRLF/LF preservation through a merge.
- Conflict-name collision produces a fresh path.
- **No-content-loss property test:** for generated input triples, either the
  outcome is `Conflict`, or every line of both inputs appears in the output.

---

## 4. Backend — new commands

Two rows for CLAUDE.md §5, in a new `src-tauri/src/commands/sync.rs`:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `merge_external` | `path, base, mine` | `{ outcome, content? }` | Reads the file, runs `mergemd::merge3`. **Never writes.** `content` is present only for `Merged`. |
| `write_conflict_copy` | `path, content` | `conflict_path` | `mergemd::unique_conflict_path` + **atomic** `fsatomic` write. Returns the path actually used. |

`merge_external` deliberately does no policy: it reports what *is*, and the
frontend decides what to *do*. That keeps the HTML-never-auto-merges rule in one
place (§5) rather than split across the IPC boundary.

---

## 5. Frontend — the divergence state machine

### 5.1 New per-tab state (`tabs.ts`)

```ts
interface TabState {
  // …existing fields…
  /** Exact bytes last read from / written to disk — the merge base. */
  base: string;
  /** Non-null while the tab is diverged from disk; blocks all writes. */
  diverged: DivergedState | null;
}
```

`base` is set on open, on successful save, and after every reload, merge, or
conflict resolution. **After an auto-merge `base` becomes *theirs***, because
theirs is what is on disk now; the buffer holds the merged text and stays dirty.

### 5.2 Reacting to `workspace:change`

1. **Debounce ~250 ms per path.** Sync daemons emit bursts (write, chmod, touch);
   today's code reacts to every one.
2. For **every** tab whose path changed — not only the active one — call
   `merge_external(path, tab.base, mine)`. For the active tab `mine` comes from
   the editor via `docToMarkdown` / the HTML serializer, since `tab.content` is
   authoritative only while the tab is inactive.
3. Map the outcome:

| Outcome | Action |
|---|---|
| `Unchanged` | Nothing. Self-writes terminate here. |
| `TheirsOnly` | Reload the buffer, `base = theirs`, status line. Lossless, so no prompt. |
| `Merged` (markdown) | Replace the buffer with the merged text, tab stays dirty, `base = theirs`, non-blocking notice: *"Merged N external changes — review and save."* |
| `Merged` (HTML) | Treated as `Conflict` (§2). |
| `Conflict` | Set `tab.diverged`, raise the banner. |

**Convergent-edit refinement.** If the merged result equals *theirs* — both sides
made the same change, or the user's edits were a subset — the buffer now matches
disk exactly, so the tab is marked **clean** rather than dirty. Without this a
tab sits dirty with nothing to save, which reads as a bug.

**Clearing divergence.** `tab.diverged` is cleared by either banner action *and*
by any later check returning `Unchanged` — i.e. if the external writer reverts
their change, the conflict resolves itself and the banner disappears.

### 5.3 Removal of `isSelfWrite`

The 2-second time window at `main.ts:465-477` is deleted. `Unchanged` replaces
it: after Toril saves, disk == base, so a self-triggered event returns
`Unchanged` and stops there. Byte comparison is exact where a timer guesses — no
false negative when a sync daemon is slow to flush, no false positive when an
external edit lands fast.

### 5.4 The conflict banner

Non-blocking, per-tab, rendered from `tab.diverged` (never a `confirm()`, which
cannot represent a background tab and evaporates when dismissed).

| Action | Effect |
|---|---|
| **Keep mine** | `write_conflict_copy(path, theirs)` → `base = theirs` → tab stays dirty. User saves when ready; their work keeps the original path. |
| **Use theirs** | `write_conflict_copy(path, mine)` → reload theirs → `base = theirs`, `dirty = false`. |

Both directions park the losing side, so **no path through this feature discards
bytes** — including the path where the user chooses to discard.

### 5.5 Writes consult `diverged`

- **Save** and **Save All** refuse a diverged tab: they focus it and surface the
  banner instead of writing. Save All is the real clobber vector — it loops every
  dirty tab, and a background tab that diverged an hour ago would otherwise be
  overwritten with no prompt ever shown.
- **Autosave is suspended** while `diverged` is set. Autosave writing over an
  external change with the user absent is precisely the silent overwrite §3
  forbids.

### 5.6 Pre-save divergence check

Before `save_file` writes, the frontend calls `merge_external` and proceeds only
on `Unchanged`; anything else raises the banner instead of writing. This demotes
the watcher from *safety mechanism* to *optimization* and costs one extra read
per save.

**Exemptions**, so the check never blocks a legitimate first write:

- **A tab with no `path`** (an Untitled draft) has nothing on disk to diverge
  from; `save_file_as` is unaffected.
- **Save As to a *new* path** writes without a check — there is no shared history
  with that path. Save As over an *existing* file is a plain overwrite the user
  explicitly chose via the native dialog, and stays that way.
- **`TheirsOnly`** means the buffer is unmodified, so reload rather than banner.
  Unreachable in practice (only dirty tabs are saved), specified so the mapping
  is total.

### 5.7 External deletion

`kind === "remove"` is handled rather than ignored as it is today: keep the
buffer, mark the tab dirty, note *"removed on disk"*. The next save recreates the
file. A sync daemon deleting a file the user has open must not vaporize their
buffer.

### 5.8 Module split

Following the `toolbar.ts` precedent — pure logic exported separately from the
DOM so the gate runs headlessly (§8):

- **`src/sync.ts`** — pure mapping of `(outcome, format, dirty) → action`. No
  DOM, no IPC.
- **`src/ui/conflictbar.ts`** — the banner element and its buttons.
- **`main.ts`** — `handleWorkspaceChange` shrinks to wiring.

---

## 6. Error handling — fail closed

- **`merge_external` fails** (file locked mid-sync, permission denied, invalid
  UTF-8 after an external tool mangles it): retry once after 200 ms, then mark
  the tab diverged with an error banner. Blocking a save is the safe direction to
  fail.
- **`write_conflict_copy` fails: the whole resolution aborts.** The reload does
  not happen and `diverged` is not cleared. If we cannot park the losing side, we
  do not get to destroy it. This is the most important error path in the feature.
- **A file that becomes non-UTF-8 on disk** can be neither merged nor reloaded;
  the tab stays diverged and the buffer is never touched.
- Every failure leaves the buffer intact. No error path writes.

---

## 7. Known limitation — normalization inflates the conflict rate

Milkdown reformats on first save, so a buffer normalized by Toril and a file
written by Obsidian can differ on lines *neither human edited*. Line-based merge
cannot see through that, which raises the conflict rate on the first save of an
externally-authored note.

**This was measured, not assumed** (2026-07-25, Milkdown 7.21.1, probe against
the real `serializer.ts`). The blanket claim in CLAUDE.md §0 — "a cost of the
WYSIWYG trade-off" — turns out to cover three different causes with very
different price tags:

| Tier | Constructs | Cause | Fixable? |
|---|---|---|---|
| **1 — cosmetic** | `*` vs `-` bullets, `***` vs `---`, ` ``` ` vs `~~~`, table cell padding | `remark-stringify` output options | **Yes** — `remarkStringifyOptionsCtx`, ~5 lines |
| **2 — upstream bug** | tight→loose lists | Milkdown coercion slip (below) | **Yes** — local `extendSchema` override |
| **3 — schema-level** | setext headings, indented code blocks, hard-break style, link references + definitions, escaping | ProseMirror's doc model is normalized; no node records its original syntax | **No** — would mean carrying original-markup attrs through every node, against CLAUDE.md §11 |

**Tier 2 is a genuine bug, not a design cost.** Tightness *is* modelled — the
parser stores `spread` correctly — but two of the four `toMarkdown` sites
forward the attribute as the **string** `"false"`, which is truthy, so every
bullet list serializes loose:

```js
// bullet_list — forwards the raw string  ❌
state.openNode("list", undefined, { ordered: false, spread: node.attrs.spread })
// ordered_list — coerces  ✅  (which is why tight ordered lists already survive)
spread: node.attrs.spread === "true"
```

A local override restores tight lists, nesting, and `---` byte-stably and
idempotently. **Caveat found the hard way:** overriding `list_item.toMarkdown`
naively clobbers GFM's task-list handling and silently drops `- [ ]` checkboxes
— a §3 data-loss bug. Any fix must preserve `checked` and gate on it.

**Decision — out of scope for this branch.** Tiers 1 + 2 change the canonical
serialization, which means rewriting every fixture in `tests/roundtrip.test.ts`
and re-normalizing users' already-saved notes once more. That is its own change
with its own gate, and folding it in here would make both harder to review. It
belongs on a precursor branch (`fix/serializer-normalization`) that this branch
rebases onto, so the merge base starts clean.

**Residual limitation after that precursor lands:** Tier 3 only — rare,
localized constructs rather than every bullet line in the vault. That is the
honest remaining cost of the WYSIWYG trade-off.

> The Tier 2 coercion bug affects every Milkdown consumer and has a second,
> sharper symptom: `schema.nodeFromJSON()` **throws** on any document containing
> a list, because the attrs declare `validate: "boolean"` while the parser
> stores strings. An upstream report + patch is drafted for the Milkdown
> maintainers.

---

## 8. Gates

| Gate | Covers |
|---|---|
| `cargo test -p mergemd` | The merge core (§3.5). |
| `tests/sync.test.ts` *(new)* | Pure policy mapping; diverged tabs reject save / Save All / autosave; both resolutions park the losing side; a failed park aborts the resolution; HTML never auto-merges. |
| `tests/tabs.test.ts` *(extend)* | `base` bookkeeping across open / save / reload / merge / resolution. |
| `tests/autosave.test.ts` *(extend)* | Autosave suspended while diverged. |
| **On-device** (§0 — no webview here) | Edit a note in Toril and a second editor simultaneously; confirm non-overlapping edits merge and overlapping ones park correctly; confirm a sync daemon's event bursts do not spam the banner. |

---

## 9. Docs to update on this branch

- **CLAUDE.md §4** — `crates/mergemd`, `commands/sync.rs`, `src/sync.ts`,
  `src/ui/conflictbar.ts`.
- **CLAUDE.md §5** — the two contract rows, plus a note that the watcher is an
  optimization and the save path is the guarantee.
- **`CHANGELOG.md`** — entry under `[Unreleased]`.
- **`ROADMAP.md`** — tick Movement I.4; `mergemd` row in §6 already exists.

---

## 10. Definition of done

- `crates/mergemd` exists with the §3.5 gate green.
- `merge_external` + `write_conflict_copy` registered and documented in §5.
- Divergence is tab state; save, Save All, and autosave all consult it.
- Pre-save check in place; `isSelfWrite` deleted.
- Both conflict resolutions park the losing side; a failed park aborts.
- All frontend gates green (`pnpm test`, `pnpm typecheck`), `cargo fmt` +
  `cargo clippy` clean on first-party crates (§10).
- On-device verification performed, or explicitly recorded as outstanding (§0).
