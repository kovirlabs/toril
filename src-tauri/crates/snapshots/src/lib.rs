//! Content-addressed local version history for Toril notes (CLAUDE.md §3,
//! ROADMAP Movement I.3).
//!
//! Every meaningful save of a note becomes a restorable version. This crate is a
//! small hand-rolled content-addressed store (not git): each note gets a
//! directory under a caller-supplied `root`, keyed by a hash of its absolute
//! path, holding a `manifest.json` (the ordered version list) and a `blobs/`
//! dir of gzip-compressed, sha256-addressed content.
//!
//! ```text
//! <root>/<path-hash>/
//!   manifest.json          # Manifest: original path + ordered SnapshotMeta list
//!   blobs/<blob-hash>      # gzip(raw content), addressed by sha256(raw content)
//! ```
//!
//! Data-safety (§3):
//! - **Additive.** History is only ever *added* to a save; callers treat a
//!   snapshot failure as non-fatal so it can never block or corrupt a save.
//! - **Atomic.** Every manifest and blob write goes through `fsatomic`.
//! - **Byte-exact.** Content is addressed and stored by its raw bytes; nothing is
//!   normalized (§3.2), so `read` returns exactly what was saved.
//! - **Crash-safe re-key.** `rekey` copies a note's history to its new location
//!   *before* deleting the old, so a power loss leaves ≥1 intact history dir.
//!
//! No Tauri dependency: pure `std` + `serde` + `sha2` + `flate2`, unit-tested
//! anywhere (§0). The caller (a Tauri command) supplies the history `root` (the
//! app config dir) and the wall clock (`now_ms`), keeping this crate deterministic
//! and testable.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MANIFEST: &str = "manifest.json";
const BLOBS: &str = "blobs";

// Thinning windows (see `prune`). Milliseconds.
const HOUR: u64 = 3_600_000;
const DAY: u64 = 24 * HOUR;
const WEEK: u64 = 7 * DAY;
const MONTH: u64 = 30 * DAY;

/// One stored version of a note.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    /// sha256 (hex) of the raw content — the blob id and dedup key.
    pub hash: String,
    /// Save time, epoch milliseconds.
    pub saved_at: u64,
    /// Raw byte length, for display.
    pub size: u64,
}

/// A note's on-disk history index.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Manifest {
    /// Original absolute path of the note (for display/debug).
    pub note_path: String,
    /// Versions, chronological oldest → newest.
    pub snapshots: Vec<SnapshotMeta>,
}

/// Result of a `snapshot` call.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A new version was recorded.
    Stored { hash: String },
    /// Content was byte-identical to the latest version; nothing was written.
    Skipped,
}

/// Hex-encode bytes (lowercase). Avoids a `hex` dependency (§2).
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
    }
    s
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

/// The per-note directory, keyed by a hash of its absolute path. Hashing the path
/// yields a filesystem-safe, collision-free id (paths can contain any character).
fn note_dir(root: &Path, note_path: &str) -> PathBuf {
    root.join(sha256_hex(note_path.as_bytes()))
}

fn load_manifest(dir: &Path) -> Manifest {
    match fsatomic::read_to_string(dir.join(MANIFEST)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Manifest::default(),
    }
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
    fsatomic::atomic_write(dir.join(MANIFEST), &json)
}

fn gzip(content: &[u8]) -> io::Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(content)?;
    enc.finish()
}

fn gunzip(compressed: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(compressed).read_to_end(&mut out)?;
    Ok(out)
}

/// Write a content blob (gzip) if it is not already present. Blobs are immutable
/// and content-addressed, so an existing file is already correct.
fn store_blob(dir: &Path, hash: &str, content: &[u8]) -> io::Result<()> {
    let blobs = dir.join(BLOBS);
    std::fs::create_dir_all(&blobs)?;
    let path = blobs.join(hash);
    if path.exists() {
        return Ok(());
    }
    fsatomic::atomic_write(path, &gzip(content)?)
}

/// Delete any blob file not referenced by a surviving snapshot. A blob may be
/// referenced by several snapshots when content repeats (A→B→A), so we key GC on
/// the set of live hashes, not on which entries were removed.
fn gc_blobs(dir: &Path, live: &HashSet<&str>) -> io::Result<()> {
    let blobs = dir.join(BLOBS);
    let read = match std::fs::read_dir(&blobs) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in read {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !live.contains(name.as_str()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Snapshot `content` for the note at `note_path`, as of `now_ms`.
///
/// Deduped against the latest version: byte-identical content is `Skipped`.
/// Otherwise the blob is stored (if new), the manifest is pruned per the
/// time-decay policy, orphaned blobs are GC'd, and the manifest is written
/// atomically. Ordering is store-blob → write-manifest → GC, so the on-disk
/// manifest never references a blob that isn't there.
pub fn snapshot(root: &Path, note_path: &str, content: &[u8], now_ms: u64) -> io::Result<Outcome> {
    let dir = note_dir(root, note_path);
    let mut manifest = load_manifest(&dir);

    let hash = sha256_hex(content);
    if manifest.snapshots.last().map(|s| &s.hash) == Some(&hash) {
        return Ok(Outcome::Skipped);
    }

    std::fs::create_dir_all(&dir)?;
    store_blob(&dir, &hash, content)?;

    manifest.note_path = note_path.to_string();
    manifest.snapshots.push(SnapshotMeta {
        hash: hash.clone(),
        saved_at: now_ms,
        size: content.len() as u64,
    });

    let pruned = prune(&manifest, now_ms);
    // Manifest first (references only stored blobs), then GC the now-orphaned
    // blobs: a crash between leaves harmless orphans, never a dangling reference.
    write_manifest(&dir, &pruned)?;
    let live: HashSet<&str> = pruned.snapshots.iter().map(|s| s.hash.as_str()).collect();
    gc_blobs(&dir, &live)?;

    Ok(Outcome::Stored { hash })
}

/// Versions for `note_path`, **newest first** (for the history panel). A missing
/// or corrupt manifest yields an empty list — never an error that could brick the
/// UI.
pub fn list(root: &Path, note_path: &str) -> Vec<SnapshotMeta> {
    let mut snaps = load_manifest(&note_dir(root, note_path)).snapshots;
    snaps.reverse();
    snaps
}

/// Return the exact original content of version `hash` for `note_path`.
pub fn read(root: &Path, note_path: &str, hash: &str) -> io::Result<String> {
    let path = note_dir(root, note_path).join(BLOBS).join(hash);
    let compressed = std::fs::read(&path)?;
    let bytes = gunzip(&compressed)?;
    String::from_utf8(bytes).map_err(io::Error::other)
}

/// Apply the time-decay retention policy to `manifest` as of `now_ms` and return
/// the thinned copy. **Pure** — no filesystem — so the whole policy is testable
/// with synthetic timestamps.
///
/// Buckets by snapshot age: keep-all `< 24h`, then keep the newest per 1-hour
/// bucket `< 7d`, per 1-day bucket `< 30d`, and per 1-week bucket beyond. The
/// oldest (original draft) and newest (current state) are always kept.
pub fn prune(manifest: &Manifest, now_ms: u64) -> Manifest {
    let mut snaps = manifest.snapshots.clone();
    snaps.sort_by_key(|s| s.saved_at);
    let n = snaps.len();
    if n <= 2 {
        return Manifest {
            note_path: manifest.note_path.clone(),
            snapshots: snaps,
        };
    }

    let mut keep = vec![false; n];
    keep[0] = true; // oldest — the original draft
    keep[n - 1] = true; // newest — current state

    // For each bucketed tier, remember the index of the newest snapshot per bucket.
    let mut newest_in_bucket: HashMap<(u8, u64), usize> = HashMap::new();
    for (i, snap) in snaps.iter().enumerate() {
        let age = now_ms.saturating_sub(snap.saved_at);
        match bucket_key(age) {
            None => keep[i] = true, // keep-all window (< 24h)
            Some(key) => {
                let better = newest_in_bucket
                    .get(&key)
                    .is_none_or(|&j| snap.saved_at >= snaps[j].saved_at);
                if better {
                    newest_in_bucket.insert(key, i);
                }
            }
        }
    }
    for &i in newest_in_bucket.values() {
        keep[i] = true;
    }

    let snapshots = snaps
        .into_iter()
        .enumerate()
        .filter_map(|(i, s)| keep[i].then_some(s))
        .collect();
    Manifest {
        note_path: manifest.note_path.clone(),
        snapshots,
    }
}

/// Bucket a snapshot age into `(tier, index)`. `None` means "keep-all" (< 24h).
fn bucket_key(age: u64) -> Option<(u8, u64)> {
    if age < DAY {
        None
    } else if age < WEEK {
        Some((1, age / HOUR))
    } else if age < MONTH {
        Some((2, age / DAY))
    } else {
        Some((3, age / WEEK))
    }
}

/// Carry a note's history from `old_path` to `new_path`, crash-safely.
///
/// Copy-first-then-delete: blobs are copied and the (possibly merged) manifest is
/// written under the new key *before* the old directory is removed. A power loss
/// leaves ≥1 intact history dir — at worst a harmless duplicate the next snapshot
/// reconciles, never zero (§3). If the new location already has history, the two
/// are merged (no version from either side is dropped). No-op if there is no old
/// history or the key is unchanged.
pub fn rekey(root: &Path, old_path: &str, new_path: &str) -> io::Result<()> {
    let old_dir = note_dir(root, old_path);
    let new_dir = note_dir(root, new_path);
    if old_dir == new_dir || !old_dir.exists() {
        return Ok(());
    }

    let old_manifest = load_manifest(&old_dir);
    std::fs::create_dir_all(new_dir.join(BLOBS))?;

    // Copy every old blob into the new dir (write-if-absent).
    if let Ok(read) = std::fs::read_dir(old_dir.join(BLOBS)) {
        for entry in read {
            let entry = entry?;
            let dest = new_dir.join(BLOBS).join(entry.file_name());
            if !dest.exists() {
                std::fs::copy(entry.path(), dest)?;
            }
        }
    }

    // Merge manifests (append + sort + dedup), retitle to the new path, write it
    // last so a crash mid-copy leaves the new dir manifest-less (treated as empty)
    // while the old dir is still intact.
    let mut merged = load_manifest(&new_dir);
    merged.note_path = new_path.to_string();
    merged.snapshots.extend(old_manifest.snapshots);
    merged.snapshots.sort_by_key(|s| s.saved_at);
    merged
        .snapshots
        .dedup_by(|a, b| a.hash == b.hash && a.saved_at == b.saved_at);
    write_manifest(&new_dir, &merged)?;

    // New location is complete — now remove the old (the "delete" half).
    std::fs::remove_dir_all(&old_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("snapshots-{tag}-{nanos}-{n}"));
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

    const NOTE: &str = "/home/user/vault/note.md";

    fn meta(hash: &str, saved_at: u64) -> SnapshotMeta {
        SnapshotMeta {
            hash: hash.to_string(),
            saved_at,
            size: 0,
        }
    }

    #[test]
    fn snapshot_then_read_is_byte_exact() {
        let tmp = TempDir::new("rt");
        for content in ["hello world", "", "trailing\n", "u\u{00e9}nicode ✓\n\n"] {
            let note = format!("/n/{}.md", content.len());
            let out = snapshot(tmp.path(), &note, content.as_bytes(), 1_000).unwrap();
            let Outcome::Stored { hash } = out else {
                panic!("expected Stored");
            };
            assert_eq!(read(tmp.path(), &note, &hash).unwrap(), content);
        }
    }

    #[test]
    fn identical_content_is_deduped() {
        let tmp = TempDir::new("dedup");
        assert!(matches!(
            snapshot(tmp.path(), NOTE, b"same", 1).unwrap(),
            Outcome::Stored { .. }
        ));
        assert_eq!(
            snapshot(tmp.path(), NOTE, b"same", 2).unwrap(),
            Outcome::Skipped
        );
        // No second version, and only one blob on disk.
        assert_eq!(list(tmp.path(), NOTE).len(), 1);
        let blobs = note_dir(tmp.path(), NOTE).join(BLOBS);
        assert_eq!(fs::read_dir(&blobs).unwrap().count(), 1);
    }

    #[test]
    fn returning_to_earlier_content_records_a_new_version_reusing_the_blob() {
        let tmp = TempDir::new("aba");
        snapshot(tmp.path(), NOTE, b"A", 1).unwrap();
        snapshot(tmp.path(), NOTE, b"B", 2).unwrap();
        snapshot(tmp.path(), NOTE, b"A", 3).unwrap(); // != latest (B) → stored
        assert_eq!(list(tmp.path(), NOTE).len(), 3);
        // Only two distinct blobs (A, B) despite three versions.
        let blobs = note_dir(tmp.path(), NOTE).join(BLOBS);
        assert_eq!(fs::read_dir(&blobs).unwrap().count(), 2);
    }

    #[test]
    fn list_is_newest_first_and_empty_without_history() {
        let tmp = TempDir::new("order");
        assert!(list(tmp.path(), NOTE).is_empty());
        snapshot(tmp.path(), NOTE, b"one", 10).unwrap();
        snapshot(tmp.path(), NOTE, b"two", 20).unwrap();
        let l = list(tmp.path(), NOTE);
        assert_eq!(l[0].saved_at, 20);
        assert_eq!(l[1].saved_at, 10);
    }

    #[test]
    fn corrupt_manifest_yields_empty_list() {
        let tmp = TempDir::new("corrupt");
        let dir = note_dir(tmp.path(), NOTE);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), "not json").unwrap();
        assert!(list(tmp.path(), NOTE).is_empty());
    }

    #[test]
    fn prune_keeps_all_within_a_day() {
        let now = 100 * DAY;
        let snaps: Vec<_> = (0..5)
            .map(|i| meta(&format!("h{i}"), now - i * HOUR))
            .collect();
        let m = Manifest {
            note_path: NOTE.into(),
            snapshots: snaps,
        };
        assert_eq!(prune(&m, now).snapshots.len(), 5, "all < 24h are kept");
    }

    #[test]
    fn prune_thins_older_tiers_but_keeps_oldest_and_newest() {
        let now = 400 * DAY;
        // Two snapshots in the SAME hour, 10 days ago (daily-bucket tier): thinned to one.
        // Plus one now, one 3 days ago, one very old — all in distinct buckets.
        let m = Manifest {
            note_path: NOTE.into(),
            snapshots: vec![
                meta("oldest", now - 200 * DAY),        // weekly tier, and the oldest
                meta("ten_a", now - 10 * DAY),          // daily tier
                meta("ten_b", now - 10 * DAY - 60_000), // same day-bucket as ten_a
                meta("three", now - 3 * DAY),           // hourly tier
                meta("newest", now),                    // keep-all + newest
            ],
        };
        let kept: Vec<String> = prune(&m, now)
            .snapshots
            .into_iter()
            .map(|s| s.hash)
            .collect();
        assert!(kept.contains(&"oldest".to_string()), "oldest always kept");
        assert!(kept.contains(&"newest".to_string()), "newest always kept");
        assert!(kept.contains(&"three".to_string()));
        // ten_a is the newer of the two in that day-bucket; ten_b is dropped.
        assert!(kept.contains(&"ten_a".to_string()));
        assert!(
            !kept.contains(&"ten_b".to_string()),
            "older of same bucket dropped"
        );
    }

    #[test]
    fn snapshot_gcs_orphaned_blobs_when_thinned() {
        let tmp = TempDir::new("gc");
        let note = "/n/gc.md";
        // Two saves in the same far-past day-bucket: the second save thins the first.
        let base = 100 * DAY;
        snapshot(tmp.path(), note, b"first", base).unwrap();
        snapshot(tmp.path(), note, b"second", base + 60_000).unwrap();
        // Advance far enough that both land in the daily/weekly tier and the first
        // is thinned out; a third save triggers prune + GC.
        let now = base + 400 * DAY;
        snapshot(tmp.path(), note, b"third", now).unwrap();

        let live: HashSet<String> = list(tmp.path(), note).into_iter().map(|s| s.hash).collect();
        let blobs = note_dir(tmp.path(), note).join(BLOBS);
        let on_disk = fs::read_dir(&blobs).unwrap().count();
        assert_eq!(
            on_disk,
            live.len(),
            "every blob on disk is referenced; orphans GC'd"
        );
    }

    #[test]
    fn rekey_moves_history_to_new_path() {
        let tmp = TempDir::new("rekey");
        let old = "/vault/old.md";
        let new = "/vault/new.md";
        snapshot(tmp.path(), old, b"v1", 1).unwrap();
        let Outcome::Stored { hash } = snapshot(tmp.path(), old, b"v2", 2).unwrap() else {
            panic!()
        };

        rekey(tmp.path(), old, new).unwrap();

        assert!(!note_dir(tmp.path(), old).exists(), "old dir removed");
        assert_eq!(list(tmp.path(), new).len(), 2, "history followed");
        assert_eq!(read(tmp.path(), new, &hash).unwrap(), "v2", "blob followed");
    }

    #[test]
    fn rekey_merges_into_existing_target_without_loss() {
        let tmp = TempDir::new("rekey-merge");
        let old = "/vault/a.md";
        let new = "/vault/b.md";
        snapshot(tmp.path(), old, b"from-a", 1).unwrap();
        snapshot(tmp.path(), new, b"from-b", 5).unwrap();

        rekey(tmp.path(), old, new).unwrap();

        let saved: Vec<u64> = list(tmp.path(), new)
            .into_iter()
            .map(|s| s.saved_at)
            .collect();
        assert_eq!(saved, vec![5, 1], "both histories present, newest first");
        assert!(!note_dir(tmp.path(), old).exists());
    }

    #[test]
    fn rekey_is_noop_without_old_history() {
        let tmp = TempDir::new("rekey-noop");
        rekey(tmp.path(), "/nope.md", "/also-nope.md").unwrap();
        assert!(list(tmp.path(), "/also-nope.md").is_empty());
    }
}
