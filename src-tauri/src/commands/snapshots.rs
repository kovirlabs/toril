//! Version-history commands (CLAUDE.md §5, ROADMAP Movement I.3).
//!
//! Thin wrappers over the `snapshots` crate (aliased `store` here to avoid any
//! confusion with this module's name). The history root is the Tauri app config
//! dir — never inside the user's vault (§1) — matching the recovery journal. The
//! wall clock is read here and injected into the crate, keeping the store
//! deterministic and testable (§0).
//!
//! Snapshots are taken as a **side-effect of saving** (`snapshot_on_save`, called
//! from the file commands), so "every save = a version" is enforced by the call
//! graph rather than by frontend discipline. That capture is best-effort and
//! **additive** (§3): a failure is logged and swallowed so it can never block or
//! fail a save.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use snapshots::{self as store, SnapshotMeta};
use tauri::{AppHandle, Manager};

const HISTORY_DIR: &str = "history";

/// The version-history root: `<app-config-dir>/history`. Public so the file
/// commands can snapshot on save.
pub fn history_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(HISTORY_DIR))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort snapshot as a side-effect of a successful save. Additive (§3): any
/// failure is logged and swallowed — the save already succeeded, so history can
/// never make a save fail.
pub fn snapshot_on_save(app: &AppHandle, path: &str, content: &[u8]) {
    let Ok(root) = history_root(app) else {
        return;
    };
    if let Err(e) = store::snapshot(&root, path, content, now_ms()) {
        eprintln!("version-history: snapshot failed for {path}: {e}");
    }
}

/// Best-effort snapshot of the content **currently on disk**, taken *before* a
/// write replaces it. Additive (§3) exactly like `snapshot_on_save`: nothing here
/// returns an error, so it can never block or fail the save that follows.
///
/// This is what makes the first Toril save of an externally-authored note
/// undoable — without it, canonical-form normalization would be recorded with no
/// pre-normalization version to go back to. A new file (nothing on disk) is
/// skipped silently; content identical to the latest version is deduped by the
/// snapshots crate.
pub fn snapshot_before_write(app: &AppHandle, path: &str) {
    let Ok(root) = history_root(app) else {
        return;
    };
    if let Err(e) = store::snapshot_existing(&root, path, now_ms()) {
        eprintln!("version-history: pre-save snapshot failed for {path}: {e}");
    }
}

/// Versions of the note at `path`, newest first. Empty if none.
#[tauri::command]
pub fn list_history(app: AppHandle, path: String) -> Result<Vec<SnapshotMeta>, String> {
    let root = history_root(&app)?;
    Ok(store::list(&root, &path))
}

/// The exact stored content of version `hash` for `path` (for the diff view).
#[tauri::command]
pub fn read_snapshot(app: AppHandle, path: String, hash: String) -> Result<String, String> {
    let root = history_root(&app)?;
    store::read(&root, &path, &hash).map_err(|e| e.to_string())
}

/// Restore version `hash` to the note at `path`. Snapshots the current on-disk
/// content **first** (so the state being left is itself restorable — restore is
/// undoable and cannot lose data, §3), then atomically writes the chosen version.
#[tauri::command]
pub fn restore_snapshot(app: AppHandle, path: String, hash: String) -> Result<(), String> {
    let root = history_root(&app)?;
    // Capture where we are before overwriting it — the same pre-write capture the
    // file commands do. Best-effort: if the note is unreadable we still allow the
    // restore to proceed.
    snapshot_before_write(&app, &path);
    let content = store::read(&root, &path, &hash).map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())
}
