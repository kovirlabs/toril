//! Vault search commands (CLAUDE.md §5, ROADMAP Movement II.6): index the open
//! folder, search it, and keep the index in step with the watcher.
//!
//! A thin wrapper over the `vaultsearch` crate, on the `commands/entries.rs`
//! precedent — the rules that make this safe live there and are unit-tested
//! without Tauri: what counts as a note, that a read is confined to the open
//! folder, and that a rootless index reads nothing at all.
//!
//! **The index is session state, not a file.** It is held in `SearchState` for as
//! long as the app runs and is rebuilt from the vault on the next launch. There
//! is deliberately nothing to persist, invalidate or repair — see the crate docs
//! for why that is a §3 position rather than a performance one.
//!
//! **The caps are ours, not the caller's.** [`vaultsearch::Query`] can be asked
//! for any number of results, but the webview only supplies the pattern and the
//! three modifier flags; how much comes back is fixed here. A search box cannot
//! ask for a million rows and take the window down with it.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;
use vaultsearch::{Index, Query, SearchResults, SkippedFile};

/// The open folder's text, for as long as the session lasts.
///
/// Starts rootless, which the crate treats as "read nothing" — so the state that
/// exists before a folder is opened cannot be talked into reading a file.
#[derive(Default)]
pub struct SearchState(Mutex<Index>);

/// What the index currently holds. Returned by every command that changes it, so
/// the frontend never has to ask a second question to find out what happened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// Notes searchable right now.
    pub files: usize,
    /// Bytes of note text held in memory — what the in-memory design costs, so
    /// the app can report it rather than the user having to wonder.
    pub bytes: usize,
    /// Files deliberately not indexed, and why. Reported rather than dropped: a
    /// search that quietly ignores a file is worse than one that says it did.
    pub skipped: Vec<SkippedFile>,
}

impl IndexStats {
    fn of(index: &Index) -> Self {
        Self {
            files: index.len(),
            bytes: index.bytes(),
            skipped: index.skipped().to_vec(),
        }
    }
}

/// The pattern and the three modifiers. Nothing else crosses the boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub text: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

/// Build the index for `path`, replacing whatever was there.
///
/// Called when a folder is opened. Reads every note in the vault, so it is the
/// one slow command here — hundreds of milliseconds on a large vault — and the
/// frontend runs it without blocking the first paint.
#[tauri::command]
pub fn index_vault(path: String, state: State<'_, SearchState>) -> Result<IndexStats, String> {
    let index = Index::load(&path).map_err(|e| e.to_string())?;
    let stats = IndexStats::of(&index);
    *state.0.lock().map_err(|e| e.to_string())? = index;
    Ok(stats)
}

/// Search the indexed folder.
///
/// An empty pattern returns nothing rather than everything, and a malformed
/// regular expression is an ordinary error carrying the engine's message — a
/// half-typed pattern is the normal case for a search box, not an exceptional
/// one.
#[tauri::command]
pub fn search_vault(
    args: SearchArgs,
    state: State<'_, SearchState>,
) -> Result<SearchResults, String> {
    let query = Query {
        text: args.text,
        case_sensitive: args.case_sensitive,
        whole_word: args.whole_word,
        regex: args.regex,
        ..Query::new("")
    };
    let index = state.0.lock().map_err(|e| e.to_string())?;
    index.search(&query).map_err(|e| e.to_string())
}

/// Bring `paths` up to date — what a `workspace:change` event calls.
///
/// Each path is resolved against disk rather than trusted from the event, because
/// the watcher coalesces and reorders (§5) and the only reliable question is what
/// is there *now*:
///
/// - a file → re-read it;
/// - a directory → index everything under it, which is how the landing half of a
///   folder rename arrives (one event, naming the folder and nothing inside it);
/// - gone → drop it *and its subtree*, since a vanished path gives no way to tell
///   whether it was a note or the folder that held a hundred.
///
/// Anything outside the open folder is refused by the crate, so a crafted call
/// cannot pull an arbitrary file into the index and read it back out as a search
/// result (§3.3).
#[tauri::command]
pub fn index_paths(
    paths: Vec<String>,
    state: State<'_, SearchState>,
) -> Result<IndexStats, String> {
    let mut index = state.0.lock().map_err(|e| e.to_string())?;
    for path in paths {
        let path = Path::new(&path);
        if path.is_file() {
            index.upsert_from_disk(path);
        } else if path.is_dir() {
            // Best-effort: a folder that disappeared between the event and this
            // call is the `remove_subtree` case, and one that is outside the
            // vault is refused. Neither should fail the whole batch — the other
            // paths in it are still real changes the index has to see.
            let _ = index.index_tree(path);
        } else {
            index.remove_subtree(path);
        }
    }
    Ok(IndexStats::of(&index))
}
