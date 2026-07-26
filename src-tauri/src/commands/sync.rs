//! External-change reconciliation (CLAUDE.md §5, ROADMAP Movement I.4).
//!
//! `merge_external` deliberately does no policy: it reports what *is*, and the
//! frontend decides what to *do*. That keeps the "HTML never auto-merges" rule
//! in one place (`src/sync.ts`) instead of split across the IPC boundary.
//!
//! Neither command writes the target note. `write_conflict_copy` writes only the
//! *conflict* file, and does so through `fsatomic` — so `fsatomic` remains the
//! only thing that ever writes a note (§3.1).

use mergemd::{Divergence, merge3, unique_conflict_path};
use serde::Serialize;
use std::time::SystemTime;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// `"unchanged" | "theirsOnly" | "merged" | "conflict" | "missing"`.
    pub outcome: String,
    /// The merged text. Present only for `"merged"`.
    pub content: Option<String>,
    /// The bytes now on disk. Present for every outcome except `"unchanged"`,
    /// where the caller's `base` already equals it. The caller needs this to set
    /// its new merge base, and to park the losing side without a second read
    /// that could race the writer.
    pub theirs: Option<String>,
}

/// Read `path` and three-way merge it against `base` and `mine`. Never writes.
///
/// A file that is *gone* reports `"missing"` rather than erroring. The two are
/// opposite instructions to the caller: an unreadable file must block writes
/// (we cannot know what we would clobber), whereas a deleted file must be
/// *recreated* by the next save — the buffer is the only copy left. Splitting
/// them here is the only way the frontend can tell them apart without parsing
/// an error string, and it is what keeps "removed on disk — save to recreate
/// it" from being a promise the write path then refuses to keep.
#[tauri::command]
pub fn merge_external(path: String, base: String, mine: String) -> Result<MergeReport, String> {
    let theirs = match fsatomic::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Covers a removed parent directory too: that also reads NotFound.
            return Ok(MergeReport {
                outcome: "missing".into(),
                content: None,
                theirs: None,
            });
        }
        Err(e) => return Err(e.to_string()),
    };
    Ok(match merge3(&base, &mine, &theirs) {
        Divergence::Unchanged => MergeReport {
            outcome: "unchanged".into(),
            content: None,
            theirs: None,
        },
        Divergence::TheirsOnly => MergeReport {
            outcome: "theirsOnly".into(),
            content: None,
            theirs: Some(theirs),
        },
        Divergence::Merged(text) => MergeReport {
            outcome: "merged".into(),
            content: Some(text),
            theirs: Some(theirs),
        },
        Divergence::Conflict => MergeReport {
            outcome: "conflict".into(),
            content: None,
            theirs: Some(theirs),
        },
    })
}

/// Park `content` beside `path` as a `… (conflict <ts>)` file, atomically.
/// Returns the path actually used.
///
/// `unique_conflict_path` checks `!candidate.exists()` and this call then writes
/// it — a TOCTOU window in principle. In practice it's unreachable here: Toril
/// is single-process, `TabManager` dedupes tabs by path so two conflicts on the
/// same note can't be resolved concurrently, and the conflict banner clears on
/// first resolution. Not closing it; recorded so the next reader doesn't have
/// to re-derive that.
#[tauri::command]
pub fn write_conflict_copy(path: String, content: String) -> Result<String, String> {
    let target = unique_conflict_path(std::path::Path::new(&path), SystemTime::now())
        .map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}
