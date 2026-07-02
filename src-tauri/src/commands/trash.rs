//! Trash commands (CLAUDE.md §5). Soft-delete + restore backed by the `trashbin`
//! crate; every move is atomic (§3). The frontend passes the open workspace root
//! and absolute file paths. No UI calls these yet — the sidebar file-ops branch
//! (#12) wires them.

use std::path::{Component, Path};
use trashbin::TrashEntry;

/// Reject a trash `id` that isn't a single normal path component, so a crafted
/// value (`..`, `a/b`, absolute paths) can't escape `.trash/` (defense at the
/// untrusted IPC boundary, §3).
fn is_valid_id(id: &str) -> bool {
    let mut parts = Path::new(id).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

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
    if !is_valid_id(&id) {
        return Err("invalid trash id".to_string());
    }
    trashbin::restore(Path::new(&vault_root), &id).map_err(|e| e.to_string())
}
