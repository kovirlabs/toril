# Safe Delete (Trash) — Design Spec

> **Branch:** `feat/safe-delete-trash` — ROADMAP Movement I, branch 2.
> **Status:** approved 2026-07-02.

## Goal

Replace destructive `rm` with a **soft-delete** to a per-workspace `.trash/`, with
reliable **restore**. This branch ships the backing capability — a `trashbin` crate,
three Tauri commands, and a headless gate. The sidebar UI that calls it is a separate
later branch (`feat/sidebar-file-ops`, #12).

## Scope

**In scope:**
- `crates/trashbin` — pure Rust (no Tauri), unit-tested everywhere (§0).
- Commands `move_to_trash`, `list_trash`, `restore_from_trash` (new `commands/trash.rs`).
- §5 contract rows.
- Gate: `cargo test -p trashbin`.

**Out of scope (deferred to #12 `feat/sidebar-file-ops`):**
- Any sidebar/context-menu UI. The three commands exist but no frontend calls them yet.
- `purge` / `empty` **commands** — the crate *implements and tests* both, but they are
  not registered as commands until the management UI needs them.

**Files-only (wired):** the crate's move/restore use `fs::rename`, which is type-agnostic,
so folders work mechanically; only file-delete is a wired use case for now.

## Non-negotiables (CLAUDE.md §3)

- **Atomic moves.** File moves use `fs::rename` (atomic on a same-filesystem rename;
  `.trash/` lives inside the vault, so this always holds). Manifest writes reuse
  `fsatomic::atomic_write`.
- **The one-location invariant.** The user's file is always at **exactly one** location —
  origin or trash, never zero. Operation ordering (below) preserves this at every step,
  including on error.
- **Never clobber.** Restore refuses to overwrite a file that reappeared at the original
  path; it errors and leaves the item in trash.
- **Vault stays clean (§1).** `.trash/` sits at the vault root and starts with `.`, so
  `vaultscan` already excludes it from the sidebar (same rule that hides `.git`/
  `.obsidian`) and Obsidian hides it too. No `vaultscan` change needed.

## Storage layout — per-delete container + manifest

Trash root: `<vault>/.trash/`. Each delete gets its own container directory, so file
names can never collide:

```
.trash/
  1751490612345-1/
    note.md          # the moved file, original name intact
    manifest.json    # { original_path, name, deleted_at }
  1751490698881-2/
    note.md          # same name, different container — no collision
    manifest.json
```

The container `id` is `<epoch_millis>-<counter>`, built from `SystemTime` plus a
process-local `AtomicU64` — the exact scheme `fsatomic` uses for temp-file names. **No
new dependency** (§2).

## Crate API — `crates/trashbin`

Dependencies: `serde` + `serde_json` (manifest), `fsatomic` (path dep, manifest write).
No Tauri dependency, like `vaultscan`. Tests use a hand-rolled `TempDir` helper mirroring
`fsatomic`'s (no `tempfile` dev-dep).

```rust
/// A soft-deleted item recorded in the workspace trash (mirrors TS shape).
pub struct TrashEntry {
    pub id: String,            // container dir name, e.g. "1751490612345-1"
    pub original_path: String, // absolute path the file was deleted from
    pub name: String,          // original file name (for display)
    pub deleted_at: u64,       // epoch millis
}

/// Move `target` into `<vault_root>/.trash/<id>/`, recording a manifest. Atomic;
/// on manifest failure the file is rolled back to its origin.
pub fn move_to_trash(vault_root: &Path, target: &Path) -> io::Result<TrashEntry>;

/// Restore trash entry `id` to its original path. Errors (without clobbering) if a
/// file already exists there. Returns the restored path.
pub fn restore(vault_root: &Path, id: &str) -> io::Result<String>;

/// List all trash entries, newest first. A corrupt/unparseable manifest is skipped,
/// never fatal.
pub fn list(vault_root: &Path) -> io::Result<Vec<TrashEntry>>;

/// Permanently delete one entry's container. (Crate-tested; command deferred to #12.)
pub fn purge(vault_root: &Path, id: &str) -> io::Result<()>;

/// Permanently delete every entry (empty the trash). (Command deferred to #12.)
pub fn empty(vault_root: &Path) -> io::Result<()>;
```

### Operation ordering (preserves the one-location invariant)

**`move_to_trash`:**
1. `create_dir_all(.trash/<id>/)` — empty container; a crash here leaves harmless litter.
2. `fs::rename(target → .trash/<id>/<name>)` — **atomic; the file is now safely in trash,
   origin cleared.**
3. `fsatomic::atomic_write(.trash/<id>/manifest.json, …)`.
   - On failure: `fs::rename(.trash/<id>/<name> → target)` to **roll back**, remove the
     container, and return the error. The file is back at its origin.
4. Best-effort fsync of the container dir (durability of the rename; non-fatal if
   unsupported, matching `fsatomic`).

**`restore`:**
1. Read `.trash/<id>/manifest.json` → `original_path`.
2. If `original_path` already exists → `Err(AlreadyExists)`; the item stays in trash
   (**never clobber**).
3. `create_dir_all(parent(original_path))` — the parent folder may itself have been
   deleted since.
4. `fs::rename(.trash/<id>/<name> → original_path)` — atomic; file back at origin.
5. Remove the manifest and container (best-effort; a leftover empty container is harmless
   and cleaned by `empty`/`purge`).

**`list`:** read each subdirectory of `.trash/`, parse its `manifest.json`, collect the
successes, sort by `deleted_at` descending. A missing `.trash/` yields an empty list. A
single unparseable manifest is skipped so it can't hide the rest.

## Commands — `src-tauri/src/commands/trash.rs`

New module (mirrors last branch's `commands/recovery.rs`). Thin wrappers over the crate;
they convert `io::Error` → `String` for the IPC boundary.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `move_to_trash` | `vault_root, path` | `TrashEntry` | soft-delete via `trashbin` (atomic, §3) |
| `list_trash` | `vault_root` | `TrashEntry[]` | newest first; empty when no `.trash/` |
| `restore_from_trash` | `vault_root, id` | `path` | errors without clobbering an existing path |

Registered in `lib.rs` `generate_handler!`. `commands/mod.rs` gains `pub mod trash;`.
No frontend calls them yet (branch #12).

`vault_root` is supplied by the caller (the frontend already tracks the open folder in the
session); this branch does not wire that call.

## Watcher interplay — nothing to do

A move into `.trash/` fires `notify` → `workspace:change` → re-scan. Because `vaultscan`
skips `.trash/`, the re-scan drops the deleted file from the tree — exactly right. Restore
fires another change and the file reappears. The existing self-write suppression is about
file *content* writes and does not apply; a structural re-scan is the correct response.

## Gate — `cargo test -p trashbin`

- **move** creates `.trash/<id>/` with the file (bytes preserved) + a manifest, and the
  origin no longer exists.
- **round-trip**: move then `restore` returns the original path, the bytes are identical,
  and the container is gone.
- **collision**: deleting two files with the same basename yields two containers; `list`
  returns both and both restore correctly.
- **no-clobber**: `restore` when a file exists again at the original path returns an error
  and leaves the item in trash.
- **corrupt manifest tolerated**: `list` skips an unparseable manifest and still returns
  the others.
- **failed move cleans up**: moving a nonexistent target errors and leaves no orphan
  container behind (covers the `fs::rename` failure branch).
- **empty/purge**: `purge(id)` removes one container; `empty` clears all.

> The manifest-write-failure rollback path (rename the file back to origin) has no
> deterministic unit seam without injecting a fake writer; it is verified by code
> inspection rather than an automated test. The invariant it protects — file always at
> exactly one location — is what the round-trip and failed-move tests exercise.

## Self-review notes

- **Placeholders:** none.
- **Consistency:** `TrashEntry` shape identical across crate, command layer, and (future)
  TS mirror. `deleted_at: u64` (epoch millis) is the single representation; no RFC3339
  second form.
- **Scope:** single crate + three thin commands + gate — sized for one implementation plan.
- **Ambiguity resolved:** id format fixed to `<epoch_millis>-<counter>`; trash root fixed
  to vault-root `.trash/`; files-only for wired commands; `purge`/`empty` crate-only this
  branch.
- **Accepted edge:** a leftover empty container after a best-effort cleanup failure is
  harmless litter, reclaimed by `empty`/`purge`.
