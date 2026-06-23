//! Persisted app settings / session (CLAUDE.md §4, §5).
//!
//! Stored as JSON in the Tauri **app config dir** — outside the user's vault, so
//! session state never pollutes their notes or git history (§1). Writes go
//! through `fsatomic` (temp + fsync + rename, §3.1).
//!
//! Persistence is **best-effort**: a missing or unparseable file loads as
//! defaults (never an error that could block startup), and the frontend treats
//! a failed save as non-fatal. Only *paths* are stored — never buffer contents —
//! so the file on disk stays the single source of truth (§3.2); restoration
//! re-reads each file via `open_file`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_VERSION: u32 = 1;
const SETTINGS_FILE: &str = "session.json";

/// Persisted session + preferences. Versioned so the shape can evolve; unknown
/// or missing fields fall back to defaults rather than failing the load.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// Schema version of the persisted file.
    pub version: u32,
    /// Last opened workspace folder, if any.
    pub last_folder: Option<String>,
    /// Absolute paths of the file-backed tabs that were open (order preserved).
    pub open_files: Vec<String>,
    /// Which open file was focused, if any.
    pub active_file: Option<String>,
    /// Theme preference: "system" | "light" | "dark". `None` ⇒ frontend default.
    pub theme: Option<String>,
    /// Whether the workspace sidebar is shown. `None` ⇒ visible (default).
    pub sidebar_visible: Option<bool>,
    /// Whether the outline panel is shown. `None` ⇒ visible (default).
    pub outline_visible: Option<bool>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

/// Load persisted settings. A missing or unparseable file yields defaults, so a
/// corrupt session file can never brick startup.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Settings {
    let Ok(path) = settings_path(&app) else {
        return Settings::default();
    };
    match fsatomic::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// Persist settings atomically, creating the config dir if needed.
#[tauri::command]
pub fn save_settings(app: AppHandle, mut settings: Settings) -> Result<(), String> {
    settings.version = SETTINGS_VERSION;
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&path, &json).map_err(|e| e.to_string())
}
