//! File commands (CLAUDE.md §5). All disk access lives here in Rust; the
//! frontend never touches the filesystem directly. Writes go through
//! `fsatomic` so every save is atomic and fsync-backed (§3.1).

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

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

/// Atomically write `content` to `path` (temp + fsync + rename, §3.1), then
/// record a version-history snapshot (best-effort, additive — never blocks or
/// fails the save, §3 / ROADMAP I.3).
#[tauri::command]
pub fn save_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    fsatomic::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    super::snapshots::snapshot_on_save(&app, &path, content.as_bytes());
    Ok(())
}

/// Prompt for a destination with the native save dialog, then atomically write.
/// Returns the chosen path, or `None` if the user cancelled.
#[tauri::command]
pub fn save_file_as(app: AppHandle, content: String) -> Result<Option<String>, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name("untitled.md")
        .blocking_save_file()
    else {
        return Ok(None); // user cancelled
    };

    let path = file_path.into_path().map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().into_owned();
    super::snapshots::snapshot_on_save(&app, &path_str, content.as_bytes());
    Ok(Some(path_str))
}
