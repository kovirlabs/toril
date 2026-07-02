//! Crash-recovery journal (CLAUDE.md §3, ROADMAP Movement I.1).
//!
//! Unsaved buffer contents are snapshotted to `recovery.json` in the Tauri app
//! config dir — never inside the user's vault (§1) — so a crash or kill can't
//! lose work. This is the one deliberate place buffer *contents* are persisted
//! (session.json stores paths only, §3.2); it is justified by the private
//! location and cleared on clean shutdown. Writes go through `fsatomic` (§3.1);
//! a missing or corrupt file loads as empty so it can never brick startup.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RECOVERY_FILE: &str = "recovery.json";

/// A dirty buffer captured for crash recovery (mirrors TS `RecoveryEntry`).
#[derive(Serialize, Deserialize)]
pub struct RecoveryEntry {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub content: String,
    pub format: String,
}

fn recovery_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(RECOVERY_FILE))
}

/// Persist the recovery journal atomically. An empty vec still writes an empty
/// list; callers use `clear_recovery` to remove the file entirely.
#[tauri::command]
pub fn save_recovery(app: AppHandle, entries: Vec<RecoveryEntry>) -> Result<(), String> {
    let path = recovery_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&entries).map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&path, &json).map_err(|e| e.to_string())
}

/// Load the recovery journal. A missing or unparseable file yields an empty vec,
/// so a corrupt journal can never block startup.
#[tauri::command]
pub fn load_recovery(app: AppHandle) -> Vec<RecoveryEntry> {
    let Ok(path) = recovery_path(&app) else {
        return Vec::new();
    };
    match fsatomic::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Delete the recovery journal (clean-shutdown sentinel). A missing file is Ok —
/// nothing to recover means nothing to clear.
#[tauri::command]
pub fn clear_recovery(app: AppHandle) -> Result<(), String> {
    let path = recovery_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
