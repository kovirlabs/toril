//! File commands (CLAUDE.md §5). All disk access lives here in Rust; the
//! frontend never touches the filesystem directly. Writes go through
//! `fsatomic` so every save is atomic and fsync-backed (§3.1).

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub content: String,
}

/// Read a UTF-8 markdown file from disk.
#[tauri::command]
pub fn open_file(path: String) -> Result<OpenedFile, String> {
    let content = fsatomic::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(OpenedFile { path, content })
}

/// Atomically write `content` to `path` (temp + fsync + rename, §3.1), recording
/// a version-history snapshot on **both** sides of the write: the bytes already on
/// disk (so the pre-existing state of a note Toril has never written — e.g. one
/// authored in Obsidian, about to be normalized to Toril's canonical form — stays
/// restorable) and the bytes just written. Both are best-effort and additive:
/// neither can block or fail the save (§3 / ROADMAP I.3).
#[tauri::command]
pub fn save_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    super::snapshots::snapshot_before_write(&app, &path);
    fsatomic::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    super::snapshots::snapshot_on_save(&app, &path, content.as_bytes());
    Ok(())
}
