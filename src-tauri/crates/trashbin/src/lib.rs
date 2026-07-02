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

/// Move `target` into `<vault_root>/.trash/<id>/`, recording a manifest.
///
/// Ordering preserves the one-location invariant: the file is `rename`d into the
/// container first (atomic; now safe in trash), then the manifest is written. If
/// the manifest write fails, the file is renamed back to its origin (rollback) and
/// the error is returned — the file is never left in limbo. `target` must be an
/// absolute path; its `original_path` is stored verbatim for restore.
///
/// Defense-in-depth (§3, untrusted webview IPC): `target` must resolve to a path
/// **inside** `vault_root` — you can only trash a file that belongs to this vault.
/// A `target` outside the vault (or one that doesn't exist) is rejected before any
/// filesystem change, so a crafted command can't relocate arbitrary files into the
/// vault's trash.
pub fn move_to_trash(vault_root: &Path, target: &Path) -> io::Result<TrashEntry> {
    // Canonicalize both sides (resolves symlinks/`..`, and on Windows applies the
    // same verbatim prefix to each) and require containment. `canonicalize` also
    // fails fast if `target` doesn't exist — nothing is created in that case.
    let canon_root = fs::canonicalize(vault_root)?;
    let canon_target = fs::canonicalize(target)?;
    if !canon_target.starts_with(&canon_root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target is outside the vault",
        ));
    }

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
        // Roll back: try to return the file to its origin. Only discard the
        // container once the file has actually left it — if the rename-back
        // fails, the file is still safely in trash and must NOT be deleted
        // (the never-zero invariant, §3). It stays recoverable in .trash/.
        if fs::rename(&dest, target).is_ok() {
            let _ = fs::remove_dir_all(&container);
        }
        return Err(e);
    }

    Ok(TrashEntry {
        id,
        original_path: manifest.original_path,
        name,
        deleted_at,
    })
}

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
    out.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
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
        assert_eq!(
            fs::read_to_string(container.join("note.md")).unwrap(),
            "hello"
        );
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
            assert_eq!(
                fs::read_dir(&trash).unwrap().count(),
                0,
                "no orphan container"
            );
        }
    }

    #[test]
    fn move_rejects_target_outside_vault() {
        let tmp = TempDir::new("outside");
        let vault = tmp.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        // A real file that exists but lives OUTSIDE the vault (a sibling dir).
        let outsider = tmp.path().join("outside.md");
        write_file(&outsider, "secret");

        let err = move_to_trash(&vault, &outsider).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        // The outside file is untouched and no trash was created in the vault.
        assert!(outsider.exists(), "outside file must not be moved");
        assert!(
            !vault.join(TRASH_DIR).exists(),
            "no trash created for a rejected move"
        );
    }

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
        assert!(
            !vault.join(TRASH_DIR).join(&entry.id).exists(),
            "container removed"
        );
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
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "new",
            "existing file untouched"
        );
        assert!(
            vault.join(TRASH_DIR).join(&entry.id).exists(),
            "item stays in trash"
        );
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
}
