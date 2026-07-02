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
use std::path::Path;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
}
