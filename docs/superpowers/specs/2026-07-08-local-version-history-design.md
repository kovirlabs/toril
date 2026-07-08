# Design — Local Version History (`feat/local-version-history`)

> ROADMAP Movement I (Trust Foundation), branch 3. Content-addressed local
> snapshots of each note plus a diff/restore panel. Out-does Apple Notes and is
> squarely on-brand. This is a **data-safety** feature: it exists to make the
> user's writing *more* recoverable, and must never make it *less* so (CLAUDE.md
> §3).

- **Date:** 2026-07-08
- **Branch:** `feat/local-version-history` (off `main`)
- **Status:** approved design → implementation

---

## 1. Goal & non-goals

**Goal.** Every meaningful save of a note becomes a restorable version. The user
can open a history panel for the active note, see prior versions with a
read-only diff against the current content, and restore any version — safely,
undoably, and without ever risking the live file.

**Non-goals (v1).**
- No in-app rename/move UI (that is Movement II.12, `feat/sidebar-file-ops`).
  This branch builds the *history-side* re-keying helper and documents the
  file-side contract; it does not add a rename button.
- No cross-note blob deduplication (blobs are per-note; keeps GC trivial).
- Diffs are **display-only**; restore always uses whole-content, so diff
  fidelity is cosmetic (no dependency on a "correct" diff).

---

## 2. Decisions (locked)

| Question | Decision | Rationale |
|---|---|---|
| Where does history live? | **App config dir**, keyed by a hash of the note's absolute path. | Matches the `recovery.json` / `session.json` precedent (§3: machine-state never lives in the vault). Vault stays plain/portable (§1); sidesteps folder-sync merge (Movement I.4) entirely. |
| When is a snapshot taken? | **On every atomic save, content-deduped.** | Deterministic; hooks the single existing save chokepoint (all saves funnel through the Rust `save_file`/`save_file_as` commands). Dedup means no-op re-saves cost nothing. |
| Retention? | **Time-decay thinning:** keep-all < 24h → hourly < 7d → daily < 30d → weekly beyond; always keep the oldest and newest. | Bounds growth gracefully (Time-Machine style) without silently dropping the original draft or the latest state. |
| Store implementation? | **Hand-rolled content-addressed store** (`crates/snapshots`), std + `sha2` + `flate2`(`miniz_oxide`) + `serde`. | Fits the house "tiny auditable crate" ethos (`fsatomic`/`trashbin`). We need blob-by-hash + a manifest + thinning — not git semantics. C-free, healthy deps (§2). Resolves ROADMAP §8's open decision. |
| Renames/moves? | **Crash-safe `rekey` (copy-first-then-delete)** in the crate now; note-file file-op principle documented for II.12. | Owner requirement: a power loss must leave ≥1 intact copy of the document on disk, even if at a different name/location. |

---

## 3. `crates/snapshots` — the store

Pure Rust, **no Tauri** (unit-testable anywhere, per §0). Location-agnostic: the
crate is handed a `root` directory (exactly as `trashbin` is handed a
`vault_root`); the command layer supplies the app-config history root.

### 3.1 Dependencies (all healthy, C-free — §2)
- `sha2` — content + path hashing.
- `flate2` with the pure-Rust `miniz_oxide` backend (no zlib C) — gzip blobs.
- `serde` / `serde_json` — the manifest.

### 3.2 On-disk layout
```
<history_root>/<path-hash>/
  manifest.json          # Manifest: original note path + ordered SnapshotMeta list
  blobs/<blob-hash>      # gzip(raw content), addressed by sha256(raw content)
```
- `path-hash` = lowercase hex `sha256(absolute_note_path)` — a filesystem-safe,
  collision-free per-note id. The original path is also stored *inside* the
  manifest for display/debug.
- `blob-hash` = lowercase hex `sha256(raw_content_bytes)` — the dedup key. The
  blob file stores `gzip(raw_content)`. Hashing the **raw** bytes (not the
  gzip) keeps addressing byte-exact and independent of compression settings
  (§3.2 fidelity).

### 3.3 Types
```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct SnapshotMeta {
    pub hash: String,    // sha256 of raw content (blob id)
    pub saved_at: u64,   // epoch millis
    pub size: u64,       // raw byte length (for display)
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Manifest {
    pub note_path: String,          // original absolute path (display/debug)
    pub snapshots: Vec<SnapshotMeta>, // chronological, oldest -> newest
}
```

### 3.4 Public API
```rust
pub enum Outcome { Stored { hash: String }, Skipped }

/// Snapshot `content` for `note_path`. Deduped against the latest entry.
/// Stores the blob if absent, appends meta, prunes, GCs orphaned blobs, and
/// writes the manifest atomically. `now_ms` is injected for determinism.
pub fn snapshot(root: &Path, note_path: &str, content: &[u8], now_ms: u64)
    -> io::Result<Outcome>;

/// Versions for `note_path`, **newest first** (for the panel). Missing/corrupt
/// manifest -> empty (never an error that could brick the UI).
pub fn list(root: &Path, note_path: &str) -> io::Result<Vec<SnapshotMeta>>;

/// Gunzip one stored version back to its exact original content.
pub fn read(root: &Path, note_path: &str, hash: &str) -> io::Result<String>;

/// Carry a note's history across a rename/move, crash-safely (copy -> fsync ->
/// delete old). Leaves >=1 intact history dir on power loss.
pub fn rekey(root: &Path, old_path: &str, new_path: &str) -> io::Result<()>;

/// PURE: apply the time-decay policy to a manifest as of `now_ms`. Returns the
/// thinned manifest; the caller deletes now-unreferenced blobs.
pub fn prune(manifest: &Manifest, now_ms: u64) -> Manifest;
```

Every manifest and blob write goes through `fsatomic::atomic_write` (§3.1).
Blobs are content-addressed and immutable, so a blob is only written if its file
is absent.

### 3.5 Thinning (`prune`) — the time-decay policy
Relative to `now_ms`, bucket each snapshot by age:

| Age of snapshot | Bucket width (keep newest per bucket) |
|---|---|
| < 24h | keep **all** |
| 24h – 7d | 1 hour |
| 7d – 30d | 1 day |
| > 30d | 1 week |

Rules:
- Within a bucket, keep the **newest** snapshot; drop the rest.
- **Always keep the oldest snapshot** (the original draft) and the **newest**
  (current state), regardless of bucket.
- `prune` is a **pure function** over `(Manifest, now_ms)` → `Manifest` — the
  whole policy is unit-testable with synthetic timestamps and no filesystem.
- After thinning, the caller GCs blob files whose hash is referenced by **no**
  surviving `SnapshotMeta` (a blob may be referenced by several metas when
  content repeats, e.g. A→B→A; only GC when the count reaches zero).

### 3.6 `rekey` — crash-safe history follow (copy-then-delete)
When a note moves from `old_path` to `new_path`:
1. Compute `old = <hash(old_path)>`, `new = <hash(new_path)>`.
2. **Copy** the entire `old/` history dir to `new/` (manifest + all blobs),
   fsync.
3. **Then** remove `old/`.

A power loss between (2) and (3) leaves both dirs (a harmless duplicate that the
next snapshot/prune reconciles), never zero. If `new/` already exists (target
had its own history), merge by appending `old`'s snapshots and re-sorting, then
prune — never discard either side's history. The manifest's `note_path` is
updated to `new_path`.

> **File-side principle for Movement II.12 (documented, not built here).** The
> note *file* rename/move must use the same discipline: copy the document to the
> new name/location → fsync → delete the original. Guarantees ≥1 complete copy of
> the document on disk at all times. II.12 wires `rekey` alongside it.

---

## 4. Save-path hook (Rust — `commands/files.rs`)

`save_file` and `save_file_as`, **after** a successful `atomic_write`, make a
**best-effort** call to `snapshots::snapshot(...)`, computing the history root
from the app config dir. Snapshot failure is logged and swallowed — the save
already succeeded, so history is strictly **additive and never blocks a save**
(§3). Because all saves (manual, Save All, autosave, and restore) funnel through
these two commands, "every save = a snapshot" is enforced by the call graph, not
by frontend discipline.

`save_file` gains an `AppHandle` parameter (to resolve the config dir); the
signature change is internal (the frontend `invoke("save_file", ...)` call is
unchanged — Tauri injects `AppHandle`).

---

## 5. Frontend commands + panel

### 5.1 New command module `commands/snapshots.rs`
Thin wrappers; each resolves `history_root` from the app config dir and reads the
real clock, delegating logic to the crate.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `list_history` | `path` | `SnapshotMeta[]` | newest first; empty if none |
| `read_snapshot` | `path, hash` | `content` | gunzip one version (for the diff view) |
| `restore_snapshot` | `path, hash` | `()` | **snapshots the current on-disk content first**, then atomically writes the chosen version to the note |

These rows are added to the CLAUDE.md §5 contract table.

### 5.2 `restore_snapshot` — undoable by construction
1. Read the note's **current** on-disk content; `snapshots::snapshot(...)` it
   (so the state you are leaving is always itself a restorable version).
2. `fsatomic::atomic_write` the chosen historical content over the note.
3. Return; the frontend reloads the buffer from disk.

Because step 1 records the pre-restore state and step 2 is atomic, a restore can
never lose data and is itself undoable (the pre-restore version sits at the top
of history).

### 5.3 `src/ui/history.ts` — the panel
Mirrors the shipped `outline.ts` panel pattern:
- Togglable pane; visibility persisted as `history_visible` in `settings.rs`
  (`None` ⇒ hidden by default) with a native menu item + shortcut, exactly like
  the outline panel.
- Lists the active note's versions (relative time — "2 min ago" — + byte size).
- Selecting a version calls `read_snapshot` and shows a **read-only line-level
  diff vs current content**, rendered by a small pure-TS diff helper
  (`src/ui/linediff.ts`, display-only). No new dependency; `similar` stays
  reserved for the Movement I.4 merge crate.
- **"Restore this version"** confirms, then — **if the active buffer has unsaved
  edits, saves it first** (which snapshots that state via the §4 hook, so nothing
  is lost) — calls `restore_snapshot`, and reloads the active tab's buffer from
  disk. Net effect: both the pre-restore editor state and the restored version
  are recoverable from history.
- Empty state when the note has no history (e.g. never saved, or brand-new).

---

## 6. Data-safety (§3) invariants

1. **Additive:** a snapshot failure never fails or blocks a save (best-effort,
   logged).
2. **Restore can't lose data:** current on-disk content is snapshotted *before*
   the overwrite; the overwrite is atomic.
3. **All writes atomic:** manifest, blobs, and the restore write all go through
   `fsatomic`.
4. **Crash-safe re-key:** copy-then-delete leaves ≥1 intact history dir.
5. **Outside the vault:** no §1 pollution; does not ride folder-sync.
6. **Byte-exact:** addressing and storage use raw bytes; no normalization
   (§3.2-consistent).

---

## 7. Gates (keep them green — §8)

### 7.1 `cargo test -p snapshots`
- **Round-trip lossless:** snapshot → mutate → `read` returns byte-exact
  original content through the gzip blob (incl. trailing-newline / empty-file
  edge cases).
- **Dedup:** snapshotting identical content twice adds no new blob and no new
  manifest entry (`Outcome::Skipped`).
- **Thinning:** a synthetic manifest spanning all four age tiers → `prune` keeps
  exactly the expected set (one per bucket + oldest + newest); orphaned-blob GC
  removes exactly the unreferenced blobs and keeps blobs still referenced by a
  repeat.
- **Resilience:** missing / corrupt / truncated manifest → `list` yields empty,
  never an error.
- **`rekey`:** history dir moves old→new; a pre-existing target merges without
  loss; `note_path` updated.

### 7.2 `tests/history.test.ts`
- Panel renders the version list (order, relative time, size).
- `linediff` helper: added/removed/unchanged lines for representative edits.
- Restore invokes `restore_snapshot` and triggers a buffer reload.
- `history_visible` toggle round-trips through settings.

---

## 8. Touch list

**New**
- `src-tauri/crates/snapshots/` — the store crate (+ its tests).
- `src-tauri/src/commands/snapshots.rs` — `list_history`, `read_snapshot`,
  `restore_snapshot`.
- `src/ui/history.ts` — the panel; `src/ui/linediff.ts` — display diff helper.
- `tests/history.test.ts` — the frontend gate.

**Modified**
- `src-tauri/Cargo.toml` — add `snapshots` to the workspace.
- `src-tauri/src/commands/files.rs` — snapshot hook in `save_file` /
  `save_file_as`.
- `src-tauri/src/commands/mod.rs`, `src/lib.rs` — register the new commands.
- `src-tauri/src/settings.rs` — add `history_visible`.
- `src-tauri/src/menu.rs` — toggle menu item.
- `src/main.ts`, `src/ipc.ts` — wire the panel, commands, reload-after-restore.
- `CLAUDE.md` §5 — the three new contract rows; §0/§4 notes as needed.
- `CHANGELOG.md` — `[Unreleased]` entry.

---

## 9. Accepted limitations (v1)

- **External renames** (Finder/Obsidian, seen only by the watcher) start fresh
  history under the new path; the old history dir is orphaned (never destroyed)
  and prunable. In-app rename (II.12) will call `rekey` to avoid this.
- **Per-note store, no cross-note dedup** — a micro-inefficiency traded for
  trivial, isolated GC.
- **Diff is display-only** — restore uses whole content, so diff correctness is
  cosmetic.
