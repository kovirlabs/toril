//! Workspace entry commands (CLAUDE.md §5, ROADMAP Movement II.12): create a
//! note, create a folder, rename either.
//!
//! Thin wrappers over the `fileops` crate (aliased `ops`, the `commands/snapshots.rs`
//! precedent) — the rules that make these safe live there and are unit-tested
//! without Tauri: name validation, vault containment, and a refusal to clobber.
//! Deleting is not here; it is `commands/trash.rs`, which soft-deletes and can
//! restore.
//!
//! The one piece of real logic in this file is **carrying version history across
//! a rename**. The snapshot store is keyed by a note's absolute path, so a rename
//! would otherwise orphan every version of that note behind a path nothing points
//! at any more. `snapshots::rekey` exists for exactly this and has had no caller
//! until now. It is applied **best-effort and additively** (§3), matching how
//! snapshots are taken on save: the rename already succeeded on disk, and history
//! failing to follow must not turn it into a reported failure — the user would be
//! left with a completed rename and an error message, unable to tell what state
//! anything is in.

use std::path::{Path, PathBuf};

use fileops as ops;
use tauri::AppHandle;

fn as_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// Create an empty note called `name` inside `dir`, and return its path.
///
/// `name` may omit the extension (`.md` is added). Refuses to overwrite an
/// existing file and refuses a `dir` outside `vault_root`.
#[tauri::command]
pub fn create_note(vault_root: String, dir: String, name: String) -> Result<String, String> {
    ops::create_note(Path::new(&vault_root), Path::new(&dir), &name)
        .map(as_string)
        .map_err(|e| e.to_string())
}

/// Create a folder called `name` inside `parent`, and return its path.
#[tauri::command]
pub fn create_folder(vault_root: String, parent: String, name: String) -> Result<String, String> {
    ops::create_folder(Path::new(&vault_root), Path::new(&parent), &name)
        .map(as_string)
        .map_err(|e| e.to_string())
}

/// A name the caller can safely propose for a new note in `dir` (`Untitled.md`,
/// `Untitled 2.md`, …).
///
/// A suggestion only — `create_note` still refuses a collision, because the user
/// edits the field before confirming and a sync daemon can land a file in
/// between. Its job is to stop New Note twice in a row from proposing a name
/// that is already taken.
#[tauri::command]
pub fn suggest_note_name(vault_root: String, dir: String, stem: String) -> Result<String, String> {
    Ok(ops::available_note_name(
        Path::new(&vault_root),
        Path::new(&dir),
        &stem,
    ))
}

/// Rename the file or folder at `path` to `new_name`, within the same parent.
///
/// Returns the new path. Version history follows the note (or, for a folder,
/// every note beneath it) — see the module docs for why that is best-effort.
#[tauri::command]
pub fn rename_entry(
    app: AppHandle,
    vault_root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let from = Path::new(&path);
    let was_dir = from.is_dir();
    // Taken *before* the move: after it, the old tree no longer exists to walk.
    let old_files = if was_dir {
        ops::descendant_files(from)
    } else {
        Vec::new()
    };

    let to = ops::rename(Path::new(&vault_root), from, &new_name).map_err(|e| e.to_string())?;

    // The rename is done. Everything below is additive (§3) and cannot fail it.
    //
    // `fileops` returns paths in the caller's own spelling, so the pre-move file
    // list (built by walking `from`) and the new root (`to`) share a prefix and
    // `reroot` pairs them directly — no canonicalization to reconcile.
    if was_dir {
        for old_file in old_files {
            let Some(new_file) = ops::reroot(&old_file, from, &to) else {
                continue;
            };
            carry_history(&app, &as_string(old_file), &as_string(new_file));
        }
    } else {
        carry_history(&app, &path, &as_string(to.clone()));
    }

    Ok(as_string(to))
}

/// Move one note's version history from `old_path` to `new_path`. Logged and
/// swallowed on failure — see the module docs.
fn carry_history(app: &AppHandle, old_path: &str, new_path: &str) {
    let Ok(root) = super::snapshots::history_root(app) else {
        return;
    };
    if let Err(e) = snapshots::rekey(&root, old_path, new_path) {
        eprintln!("version-history: rekey failed for {old_path} → {new_path}: {e}");
    }
}
