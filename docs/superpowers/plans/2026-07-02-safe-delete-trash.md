# Safe Delete (Trash) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace destructive delete with an atomic soft-delete into a per-workspace `.trash/` plus a reliable restore, delivered as a testable `trashbin` crate + three Tauri commands.

**Architecture:** A pure Rust `trashbin` crate (no Tauri, like `vaultscan`) moves each deleted file into its own `.trash/<id>/` container beside a `manifest.json`, so names never collide and every entry is self-describing. Moves are `fs::rename` (atomic); the manifest is written via `fsatomic`. Three thin Tauri commands in a new `commands/trash.rs` wrap the crate; no frontend calls them yet (the sidebar UI is branch #12).

**Tech Stack:** Rust (edition 2024, `std` + `serde` + `serde_json` + `fsatomic`), Tauri 2.

## Global Constraints

- **§3 Atomic + never-lose.** File moves use `fs::rename` (atomic same-filesystem; `.trash/` lives inside the vault). Manifest writes reuse `fsatomic::atomic_write`. The user's file is always at exactly one location — origin or trash, never zero.
- **§3 Never clobber.** Restore refuses to overwrite an existing file at the original path; it errors and leaves the item in trash.
- **§1 Vault stays clean.** Trash root is vault-root `.trash/`; it starts with `.`, so `vaultscan` already excludes it (no scanner change).
- **§2 No unhealthy / no new heavyweight deps.** `id` uses `SystemTime` + a process-local `AtomicU64` (the `fsatomic` pattern) — no `rand`. Tests use a hand-rolled `TempDir` — no `tempfile`.
- **§0 Build reality.** The Rust *app* crate can't link on this box (no webview). The **crate** gate `cargo test -p trashbin` runs here and is the automated gate. App-crate command wiring is `cargo fmt`-verified here; compile/clippy/GUI are on-device.
- **Rust: edition 2024, `cargo fmt` clean, conventional commits.**

---

### Task 1: `trashbin` crate — move-to-trash (the container + manifest core)

**Files:**
- Create: `src-tauri/crates/trashbin/Cargo.toml`
- Create: `src-tauri/crates/trashbin/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (add `"crates/trashbin"` to `[workspace].members`)

**Interfaces:**
- Produces:
  - `pub struct TrashEntry { pub id: String, pub original_path: String, pub name: String, pub deleted_at: u64 }` (derives `Serialize, Deserialize, Clone, Debug`)
  - `pub fn move_to_trash(vault_root: &std::path::Path, target: &std::path::Path) -> std::io::Result<TrashEntry>`
  - internal: `struct Manifest`, `fn new_id() -> String`, `fn now_millis() -> u64`, consts `TRASH_DIR = ".trash"`, `MANIFEST = "manifest.json"`

- [ ] **Step 1: Create the crate manifest**

Create `src-tauri/crates/trashbin/Cargo.toml`:

```toml
[package]
name = "trashbin"
version = "0.1.0"
edition = "2024"
description = "Soft-delete (move-to-trash) + restore for a Toril workspace (CLAUDE.md §3). Per-delete container + manifest; no Tauri dep so it's unit-testable anywhere."

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
fsatomic = { path = "../fsatomic" }
```

- [ ] **Step 2: Register the crate in the workspace**

In `src-tauri/Cargo.toml`, add `"crates/trashbin",` to the `[workspace].members` array (after `"crates/imgasset",`):

```toml
members = [
    "crates/fsatomic",
    "crates/vaultscan",
    "crates/mdhtml",
    "crates/mdrtf",
    "crates/imgasset",
    "crates/trashbin",
]
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/crates/trashbin/src/lib.rs` with ONLY the test module for now (the impl lands in Step 5, so this fails to compile — that is the red state):

```rust
//! Soft-delete (move-to-trash) + restore for a Toril workspace (CLAUDE.md §3).
//!
//! Destructive deletes are replaced by a move into a per-workspace `.trash/`.
//! Each delete gets its own container directory `<vault>/.trash/<id>/` holding the
//! moved file (original name intact) beside a `manifest.json` recording where it
//! came from. Per-delete containers mean two files of the same name never collide,
//! and each entry is self-describing (no global index to corrupt).
//!
//! Safety (§3): the file move is `fs::rename` (atomic on a same-filesystem rename;
//! `.trash/` lives inside the vault). The manifest is written via `fsatomic`. The
//! user's file is always at exactly one location — origin or trash, never zero.
//!
//! No Tauri dependency: pure `std` + `serde`, fully unit-tested anywhere (§0).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const TRASH_DIR: &str = ".trash";
const MANIFEST: &str = "manifest.json";

/// A soft-deleted item recorded in the workspace trash (mirrors the TS shape).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrashEntry {
    /// Container directory name, e.g. `"1751490612345-0"`.
    pub id: String,
    /// Absolute path the file was deleted from (restore target).
    pub original_path: String,
    /// Original file name, for display.
    pub name: String,
    /// Deletion time, epoch milliseconds.
    pub deleted_at: u64,
}

/// On-disk manifest — everything about an entry except its `id` (the dir name).
#[derive(Serialize, Deserialize)]
struct Manifest {
    original_path: String,
    name: String,
    deleted_at: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A unique container id: `<epoch_millis>-<process-local counter>`. Toril is
/// single-instance, so a global monotonic counter makes ids collision-free
/// without a `rand` dependency (§2).
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", now_millis(), n)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("trashbin-{tag}-{nanos}-{n}"));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn move_puts_file_in_container_and_clears_origin() {
        let tmp = TempDir::new("move");
        let vault = tmp.path();
        let file = vault.join("note.md");
        write_file(&file, "hello");

        let entry = move_to_trash(vault, &file).unwrap();

        assert!(!file.exists(), "origin should be gone");
        let container = vault.join(TRASH_DIR).join(&entry.id);
        assert_eq!(fs::read_to_string(container.join("note.md")).unwrap(), "hello");
        assert!(container.join(MANIFEST).exists());
        assert_eq!(entry.name, "note.md");
        assert_eq!(entry.original_path, file.to_string_lossy());
    }

    #[test]
    fn move_of_missing_file_errors_and_leaves_no_container() {
        let tmp = TempDir::new("missing");
        let vault = tmp.path();
        let missing = vault.join("nope.md");

        assert!(move_to_trash(vault, &missing).is_err());

        let trash = vault.join(TRASH_DIR);
        if trash.exists() {
            assert_eq!(fs::read_dir(&trash).unwrap().count(), 0, "no orphan container");
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd src-tauri && cargo test -p trashbin`
Expected: FAIL — compile error, `cannot find function move_to_trash in this scope`.

- [ ] **Step 5: Write the minimal implementation**

In `src-tauri/crates/trashbin/src/lib.rs`, insert this **above** the `#[cfg(test)]` module (after `new_id`):

```rust
/// Move `target` into `<vault_root>/.trash/<id>/`, recording a manifest.
///
/// Ordering preserves the one-location invariant: the file is `rename`d into the
/// container first (atomic; now safe in trash), then the manifest is written. If
/// the manifest write fails, the file is renamed back to its origin (rollback) and
/// the error is returned — the file is never left in limbo. `target` must be an
/// absolute path; its `original_path` is stored verbatim for restore.
pub fn move_to_trash(vault_root: &Path, target: &Path) -> io::Result<TrashEntry> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no file name"))?
        .to_string_lossy()
        .into_owned();

    let trash_root = vault_root.join(TRASH_DIR);
    fs::create_dir_all(&trash_root)?;

    let id = new_id();
    let container = trash_root.join(&id);
    fs::create_dir(&container)?;

    // Move the file first — the atomic, must-not-lose step.
    let dest = container.join(&name);
    if let Err(e) = fs::rename(target, &dest) {
        let _ = fs::remove_dir(&container);
        return Err(e);
    }

    let deleted_at = now_millis();
    let manifest = Manifest {
        original_path: target.to_string_lossy().into_owned(),
        name: name.clone(),
        deleted_at,
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(io::Error::other)?;
    if let Err(e) = fsatomic::atomic_write(container.join(MANIFEST), &json) {
        // Roll back: put the file back where it came from, drop the container.
        let _ = fs::rename(&dest, target);
        let _ = fs::remove_dir_all(&container);
        return Err(e);
    }

    Ok(TrashEntry {
        id,
        original_path: manifest.original_path,
        name,
        deleted_at,
    })
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd src-tauri && cargo test -p trashbin`
Expected: PASS (2 tests).

- [ ] **Step 7: Format + commit**

Run: `cd src-tauri && cargo fmt --all && cd ..`
Expected: no changes needed / clean.

```bash
git add src-tauri/crates/trashbin/Cargo.toml src-tauri/crates/trashbin/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(trash): trashbin crate with atomic move-to-trash + gate"
```

---

### Task 2: Restore, list, purge, empty (the read/restore/cleanup surface)

**Files:**
- Modify: `src-tauri/crates/trashbin/src/lib.rs`

**Interfaces:**
- Consumes: Task 1's `TrashEntry`, `Manifest`, `move_to_trash`, consts.
- Produces:
  - `pub fn restore(vault_root: &Path, id: &str) -> io::Result<String>` (returns restored absolute path; `AlreadyExists` if origin is occupied)
  - `pub fn list(vault_root: &Path) -> io::Result<Vec<TrashEntry>>` (newest first; empty if no `.trash/`; skips corrupt manifests)
  - `pub fn purge(vault_root: &Path, id: &str) -> io::Result<()>` (idempotent)
  - `pub fn empty(vault_root: &Path) -> io::Result<()>` (idempotent)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/crates/trashbin/src/lib.rs`, add these tests **inside** the existing `#[cfg(test)] mod tests` block (after `move_of_missing_file_errors_and_leaves_no_container`):

```rust
    #[test]
    fn round_trip_restores_identical_bytes() {
        let tmp = TempDir::new("rt");
        let vault = tmp.path();
        let file = vault.join("sub").join("note.md");
        write_file(&file, "content");

        let entry = move_to_trash(vault, &file).unwrap();
        assert!(!file.exists());

        let restored = restore(vault, &entry.id).unwrap();
        assert_eq!(restored, file.to_string_lossy());
        assert_eq!(fs::read_to_string(&file).unwrap(), "content");
        assert!(!vault.join(TRASH_DIR).join(&entry.id).exists(), "container removed");
    }

    #[test]
    fn restore_recreates_missing_parent() {
        let tmp = TempDir::new("parent");
        let vault = tmp.path();
        let file = vault.join("sub").join("note.md");
        write_file(&file, "x");

        let entry = move_to_trash(vault, &file).unwrap();
        fs::remove_dir_all(vault.join("sub")).unwrap(); // parent folder gone

        restore(vault, &entry.id).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "x");
    }

    #[test]
    fn restore_refuses_to_clobber_existing() {
        let tmp = TempDir::new("clobber");
        let vault = tmp.path();
        let file = vault.join("note.md");
        write_file(&file, "old");

        let entry = move_to_trash(vault, &file).unwrap();
        write_file(&file, "new"); // something re-occupies the path

        let err = restore(vault, &entry.id).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&file).unwrap(), "new", "existing file untouched");
        assert!(vault.join(TRASH_DIR).join(&entry.id).exists(), "item stays in trash");
    }

    #[test]
    fn same_name_deletes_do_not_collide() {
        let tmp = TempDir::new("collide");
        let vault = tmp.path();
        let a = vault.join("a").join("note.md");
        let b = vault.join("b").join("note.md");
        write_file(&a, "AAA");
        write_file(&b, "BBB");

        let ea = move_to_trash(vault, &a).unwrap();
        let eb = move_to_trash(vault, &b).unwrap();
        assert_ne!(ea.id, eb.id);
        assert_eq!(list(vault).unwrap().len(), 2);

        restore(vault, &ea.id).unwrap();
        restore(vault, &eb.id).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "AAA");
        assert_eq!(fs::read_to_string(&b).unwrap(), "BBB");
    }

    #[test]
    fn list_skips_corrupt_manifest() {
        let tmp = TempDir::new("corrupt");
        let vault = tmp.path();
        let good = vault.join("good.md");
        write_file(&good, "g");
        let entry = move_to_trash(vault, &good).unwrap();

        let bad = vault.join(TRASH_DIR).join("9999-bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join(MANIFEST), "not json").unwrap();

        let listed = list(vault).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, entry.id);
    }

    #[test]
    fn list_is_empty_without_trash_dir() {
        let tmp = TempDir::new("notrash");
        assert!(list(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn purge_removes_one_entry_and_is_idempotent() {
        let tmp = TempDir::new("purge");
        let vault = tmp.path();
        let f = vault.join("n.md");
        write_file(&f, "x");
        let e = move_to_trash(vault, &f).unwrap();

        purge(vault, &e.id).unwrap();
        assert!(!vault.join(TRASH_DIR).join(&e.id).exists());
        assert!(list(vault).unwrap().is_empty());
        purge(vault, &e.id).unwrap(); // idempotent on missing
    }

    #[test]
    fn empty_clears_all_and_is_idempotent() {
        let tmp = TempDir::new("empty");
        let vault = tmp.path();
        for name in ["a.md", "b.md"] {
            let f = vault.join(name);
            write_file(&f, "x");
            move_to_trash(vault, &f).unwrap();
        }
        empty(vault).unwrap();
        assert!(list(vault).unwrap().is_empty());
        empty(vault).unwrap(); // idempotent on missing
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p trashbin`
Expected: FAIL — compile error, `cannot find function restore`/`list`/`purge`/`empty`.

- [ ] **Step 3: Write the minimal implementation**

In `src-tauri/crates/trashbin/src/lib.rs`, add these functions **above** the `#[cfg(test)]` module (after `move_to_trash`):

```rust
/// Restore trash entry `id` to its original path. Errors with `AlreadyExists`
/// (without clobbering) if a file is already there; the item stays in trash. The
/// original parent folder is recreated if it was removed since. Returns the path.
pub fn restore(vault_root: &Path, id: &str) -> io::Result<String> {
    let container = vault_root.join(TRASH_DIR).join(id);
    let text = fsatomic::read_to_string(container.join(MANIFEST))?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(io::Error::other)?;

    let original = PathBuf::from(&manifest.original_path);
    if original.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", manifest.original_path),
        ));
    }
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(container.join(&manifest.name), &original)?;
    let _ = fs::remove_dir_all(&container); // best-effort; empty leftover is harmless
    Ok(manifest.original_path)
}

/// List every trash entry, newest first. A missing `.trash/` yields an empty list;
/// a single unparseable manifest is skipped so it can't hide the others.
pub fn list(vault_root: &Path) -> io::Result<Vec<TrashEntry>> {
    let trash_root = vault_root.join(TRASH_DIR);
    let read = match fs::read_dir(&trash_root) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut out = Vec::new();
    for entry in read {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let Ok(text) = fsatomic::read_to_string(entry.path().join(MANIFEST)) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Manifest>(&text) else {
            continue;
        };
        out.push(TrashEntry {
            id,
            original_path: manifest.original_path,
            name: manifest.name,
            deleted_at: manifest.deleted_at,
        });
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// Permanently delete one entry's container. A missing container is Ok (idempotent).
pub fn purge(vault_root: &Path, id: &str) -> io::Result<()> {
    remove_dir_all_ok(&vault_root.join(TRASH_DIR).join(id))
}

/// Permanently delete every entry (empty the trash). Missing `.trash/` is Ok.
pub fn empty(vault_root: &Path) -> io::Result<()> {
    remove_dir_all_ok(&vault_root.join(TRASH_DIR))
}

/// `remove_dir_all` that treats "already gone" as success.
fn remove_dir_all_ok(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test -p trashbin`
Expected: PASS (10 tests total).

- [ ] **Step 5: Format + commit**

Run: `cd src-tauri && cargo fmt --all && cd ..`
Expected: clean.

```bash
git add src-tauri/crates/trashbin/src/lib.rs
git commit -m "feat(trash): restore, list, purge, empty with round-trip + no-clobber gate"
```

---

### Task 3: Tauri commands — `move_to_trash`, `list_trash`, `restore_from_trash`

**Files:**
- Create: `src-tauri/src/commands/trash.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod trash;`)
- Modify: `src-tauri/Cargo.toml` (add `trashbin` path dependency)
- Modify: `src-tauri/src/lib.rs` (register 3 commands in `generate_handler!`)

**Interfaces:**
- Consumes: `trashbin::{TrashEntry, move_to_trash, list, restore}`.
- Produces (Tauri commands): `move_to_trash(vault_root, path) -> Result<TrashEntry, String>`, `list_trash(vault_root) -> Result<Vec<TrashEntry>, String>`, `restore_from_trash(vault_root, id) -> Result<String, String>`.

> **§0:** the app crate can't link on this box. This task is `cargo fmt`-verified only; compile/clippy and the actual IPC calls are on-device. No frontend wiring here — the commands exist for branch #12.

- [ ] **Step 1: Add the `trashbin` dependency to the app crate**

In `src-tauri/Cargo.toml`, in `[dependencies]`, after `imgasset = { path = "crates/imgasset" }`:

```toml
imgasset = { path = "crates/imgasset" }
trashbin = { path = "crates/trashbin" }
```

- [ ] **Step 2: Create the command module**

Create `src-tauri/src/commands/trash.rs`:

```rust
//! Trash commands (CLAUDE.md §5). Soft-delete + restore backed by the `trashbin`
//! crate; every move is atomic (§3). The frontend passes the open workspace root
//! and absolute file paths. No UI calls these yet — the sidebar file-ops branch
//! (#12) wires them.

use std::path::Path;
use trashbin::TrashEntry;

/// Soft-delete `path` into `<vault_root>/.trash/`. Returns the trash entry.
#[tauri::command]
pub fn move_to_trash(vault_root: String, path: String) -> Result<TrashEntry, String> {
    trashbin::move_to_trash(Path::new(&vault_root), Path::new(&path)).map_err(|e| e.to_string())
}

/// List the workspace trash, newest first.
#[tauri::command]
pub fn list_trash(vault_root: String) -> Result<Vec<TrashEntry>, String> {
    trashbin::list(Path::new(&vault_root)).map_err(|e| e.to_string())
}

/// Restore trash entry `id` to its original path (errors without clobbering).
#[tauri::command]
pub fn restore_from_trash(vault_root: String, id: String) -> Result<String, String> {
    trashbin::restore(Path::new(&vault_root), &id).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the module**

In `src-tauri/src/commands/mod.rs`, add `pub mod trash;` (after `pub mod recovery;`):

```rust
pub mod export;
pub mod files;
pub mod images;
pub mod recovery;
pub mod trash;
pub mod workspace;
```

- [ ] **Step 4: Register the commands in the handler**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ … ]`, add after the three `commands::recovery::*` lines (before `take_launch_path,`):

```rust
            commands::recovery::clear_recovery,
            commands::trash::move_to_trash,
            commands::trash::list_trash,
            commands::trash::restore_from_trash,
            take_launch_path,
```

- [ ] **Step 5: Format + commit (compile/clippy on-device — §0)**

Run: `cd src-tauri && cargo fmt --all && cd ..`
Expected: clean (formatting only; the app crate cannot link here).

```bash
git add src-tauri/src/commands/trash.rs src-tauri/src/commands/mod.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat(trash): tauri commands move_to_trash/list_trash/restore_from_trash"
```

---

### Task 4: Docs — contract rows, crate list, changelog, roadmap tick

**Files:**
- Modify: `CLAUDE.md` (§5 command rows + a prose note; §4 crate list)
- Modify: `CHANGELOG.md` (Unreleased entry)
- Modify: `ROADMAP.md` (tick branch 2; advance the status pointer)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the §5 contract rows in `CLAUDE.md`**

In the §5 command table, add these rows after the `clear_recovery` row (before `take_launch_path`):

```
| `move_to_trash` | `vault_root, path` | `TrashEntry` | soft-delete into workspace `.trash/` via `trashbin` — **atomic** move (§3) |
| `list_trash` | `vault_root` | `TrashEntry[]` | newest first; empty when no `.trash/` |
| `restore_from_trash` | `vault_root, id` | `path` | restore to original path; errors **without clobbering** an existing file |
```

Add this prose note under the table (after the "Recovery journal." note):

> **Trash.** Soft-delete moves a file into `<vault>/.trash/<id>/` (own container +
> `manifest.json`) rather than `rm`; restore reads the manifest and atomically renames
> it back, refusing to clobber a file that reappeared at the path. `.trash/` starts with
> `.`, so `vaultscan` already hides it from the sidebar (§1) and Obsidian hides it too.
> Backed by `crates/trashbin`; commands are not yet called by any UI (the sidebar file-ops
> branch wires them).

- [ ] **Step 2: Add `trashbin` to the §4 crate list in `CLAUDE.md`**

In the §4 project-structure `crates/` block, `imgasset` is currently the last entry
(`└── imgasset/`). Change its connector to `├──` and add `trashbin` as the new last entry.

Before:
```
    │   └── imgasset/          # save pasted clipboard images beside the doc (§6)
```
After:
```
    │   ├── imgasset/          # save pasted clipboard images beside the doc (§6)
    │   └── trashbin/          # soft-delete to workspace .trash/ + restore (§3)
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, under the existing `## [Unreleased]` → `### Added`, add a second bullet after the autosave one:

```markdown
- **Safe delete (trash)** (ROADMAP Movement I.2). Deletes now soft-delete into a
  per-workspace `.trash/` (each item in its own container beside a manifest) instead of
  a destructive remove, with atomic restore that refuses to overwrite a file that
  reappeared at the original path. Backed by the `trashbin` crate; the sidebar delete UI
  that surfaces it lands in a later branch.
```

- [ ] **Step 4: Tick the roadmap and advance the pointer**

In `ROADMAP.md`, change branch 2's checkbox from `- [ ]` to `- [x]`:

```markdown
- [x] **2. `feat/safe-delete-trash`** — soft-delete to a workspace `.trash/` with restore,
```

Update the Status block pointer line from:

```
> **▶ Pick up at Movement I, branch 2 — `feat/safe-delete-trash`.**
```

to:

```
> **▶ Pick up at Movement I, branch 3 — `feat/local-version-history`.**
```

And update the status sentence naming completed work from:

```
> **Movement I, branch 1
> (`feat/autosave-recovery`) is complete** (autosave + crash-recovery journal); the
> remaining Movement I–V branches are unstarted.
```

to:

```
> **Movement I, branches 1–2 are complete** (autosave + crash-recovery journal;
> safe-delete-to-trash); the remaining Movement I–V branches are unstarted.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs(trash): contract rows, crate list, changelog, tick roadmap branch 2"
```

---

## Self-Review

**Spec coverage:**
- Per-delete container + manifest layout, `id` = `<millis>-<counter>` (no `rand`) → Task 1. ✓
- One-location invariant + rename-first-then-manifest ordering + rollback → Task 1 (`move_to_trash`). ✓
- Restore with no-clobber + parent recreation → Task 2 (`restore`). ✓
- `list` newest-first, empty-without-`.trash/`, corrupt-manifest tolerance → Task 2. ✓
- `purge` / `empty` implemented + tested, commands deferred → Task 2 (crate) / not in Task 3. ✓
- Three commands (move/list/restore) + registration + `trashbin` dep → Task 3. ✓
- `vaultscan` unchanged (dotfolder skip already excludes `.trash/`) → noted, no task needed. ✓
- Gate `cargo test -p trashbin` (move, round-trip, collision, no-clobber, corrupt-manifest, failed-move, purge, empty) → Tasks 1–2. ✓
- §5 rows + §4 crate list + §1 note, changelog, roadmap tick → Task 4. ✓

**Placeholder scan:** none — every code step is complete; every run step has a command + expected result.

**Type consistency:** `TrashEntry { id, original_path, name, deleted_at: u64 }` identical across the crate (Task 1) and the commands (Task 3, imported not redefined). `move_to_trash`/`restore`/`list`/`purge`/`empty` signatures used identically in Tasks 2–3. Consts `TRASH_DIR`/`MANIFEST` defined once (Task 1) and reused in tests/impl. `io::Error::other` used for the `serde_json` → `io::Error` conversions in both `move_to_trash` and `restore`.

**Known accepted edges (from spec):** manifest-write rollback is inspection-verified, not unit-tested (no deterministic seam); a leftover empty container after a best-effort cleanup failure is harmless litter reclaimed by `empty`/`purge`.
