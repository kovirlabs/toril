# Sync Coexistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a file open in Toril changes underneath the editor, the user never loses bytes — theirs or the external writer's.

**Architecture:** A pure-Rust `crates/mergemd` does line-based diff3 and conflict-file naming. Two Tauri commands expose it; `merge_external` only *reports*, never writes. The frontend holds a per-tab `base` (last bytes seen on disk) and `diverged` flag; a pure policy module maps `(outcome, format)` to an action, and every write path — save, Save All, autosave — refuses a diverged tab. The correctness guarantee lives in the save path, not the watcher.

**Tech Stack:** Rust (edition 2024) + `similar` for diffs; TypeScript strict; Vitest + jsdom.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-sync-coexistence-design.md`. Read it before starting.
- **Branch:** `feat/sync-coexistence`, already rebased onto `main`. Do not create a new branch.
- **A conflict must NEVER silently overwrite either side** (CLAUDE.md §3). This outranks every other consideration in this plan.
- **`fsatomic` is the only thing that writes notes** (§3.1). `mergemd` never writes the target file.
- **All markdown conversion goes through `src/editor/serializer.ts`** (§3.2); HTML through `html-serializer.ts`. Do not add a second conversion path.
- **`mergemd` takes no Tauri dependency** and only `similar` beyond `std` — it must be unit-testable with `cargo test -p mergemd`.
- **Markdown only for auto-merge.** HTML divergence goes straight to the conflict banner (§2).
- **TypeScript strict, no `any`.** Rust edition 2024; `cargo fmt --all` + `cargo clippy` clean.
- **Conventional commits.** Full suite green before each commit: `pnpm test` (expect 158 passing at start), `pnpm typecheck`.
- CI runs `pnpm typecheck`/`test`/`build` and the logic crates on Ubuntu **and** Windows for every PR. `mergemd` must be added to the CI crate list (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/crates/mergemd/Cargo.toml` *(create)* | Crate manifest; `similar` only. |
| `src-tauri/crates/mergemd/src/lib.rs` *(create)* | `Divergence`, `merge3`, `unique_conflict_path`. Pure computation + filename selection. |
| `src-tauri/Cargo.toml` *(modify)* | Add `crates/mergemd` to workspace members and as an app dependency. |
| `src-tauri/src/commands/sync.rs` *(create)* | `merge_external`, `write_conflict_copy`. Wire types + policy-free reporting. |
| `src-tauri/src/commands/mod.rs` *(modify)* | `pub mod sync;` |
| `src-tauri/src/lib.rs` *(modify)* | Register the two commands. |
| `src/ipc.ts` *(modify)* | `mergeExternal`, `writeConflictCopy`, `MergeReport` type. |
| `src/sync.ts` *(create)* | **Pure** policy: outcome → action, and the write-gating selectors. No DOM, no IPC. |
| `src/ui/conflictbar.ts` *(create)* | The banner element and its two buttons. |
| `src/ui/tabs.ts` *(modify)* | `base` and `diverged` on `TabState`; setters. |
| `src/main.ts` *(modify)* | Wiring: watcher handler, pre-save check, Save All, autosave dep, deletion handling. Delete `isSelfWrite`/`recordSelfWrite`. |
| `src/styles.css` *(modify)* | Banner styling. |
| `tests/sync.test.ts` *(create)* | Policy mapping, write gating, resolution ordering. |
| `tests/tabs.test.ts` *(modify)* | `base`/`diverged` bookkeeping. |
| `.github/workflows/ci.yml` *(modify)* | Add `-p mergemd`. |
| `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md` *(modify)* | Docs (Task 13). |

> **One deviation from spec §8, deliberate.** The spec lists "autosave suspended while diverged" under `tests/autosave.test.ts`. `autosave.ts` does not actually need to change: `saveDirtySaved` is a dependency injected from `main.ts` (`src/main.ts:782-786`), so the filter belongs in `src/sync.ts` and is tested in `tests/sync.test.ts`. Extending `autosave.test.ts` would mean coupling `BufferLike` to a sync concept for no gain. Task 11 covers the behavior; Task 8 covers the test.

---

## Task 1: `mergemd` scaffold, line splitting, and short-circuits

**Files:**
- Create: `src-tauri/crates/mergemd/Cargo.toml`
- Create: `src-tauri/crates/mergemd/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum Divergence { Unchanged, TheirsOnly, Merged(String), Conflict }` and `pub fn merge3(base: &str, mine: &str, theirs: &str) -> Divergence`. Later tasks extend `merge3`; the signature does not change.

- [ ] **Step 1: Create the manifest**

`src-tauri/crates/mergemd/Cargo.toml`:

```toml
[package]
name = "mergemd"
version = "0.1.0"
edition = "2024"
description = "Line-based three-way merge for Toril (CLAUDE.md §3, ROADMAP Movement I.4). Pure computation plus conflict-filename selection — it never writes the target file, so fsatomic stays the only writer (§3.1). No Tauri dep, so it is unit-testable anywhere."

# Diff primitives only (§2): `similar` is pure Rust, actively maintained by
# Armin Ronacher, and widely used. Nothing else beyond std.
[dependencies]
similar = "2"
```

- [ ] **Step 2: Register the crate in the workspace and the app**

In `src-tauri/Cargo.toml`, add to `members` (after `"crates/snapshots",`):

```toml
    "crates/mergemd",
```

And to the app's dependencies, after the `snapshots = { path = "crates/snapshots" }` line:

```toml
mergemd = { path = "crates/mergemd" }
```

- [ ] **Step 3: Write the failing test**

`src-tauri/crates/mergemd/src/lib.rs`:

```rust
//! Line-based three-way merge (CLAUDE.md §3, ROADMAP Movement I.4).
//!
//! Classic diff3: diff `base → mine` and `base → theirs`, project both change
//! sets into base line coordinates, then walk them together. A region touched
//! by one side is taken from that side; a region both sides changed identically
//! is taken once; a region both changed differently is a `Conflict`.
//!
//! Line terminators travel with their lines. If the buffer is LF and an external
//! Windows editor wrote CRLF, a naive merge rewrites every line ending in the
//! file — a whole-file diff for a one-line change. Keeping each line's own
//! terminator means a merged file changes only the lines that actually changed.

/// The outcome of comparing a buffer and a file against their common ancestor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Divergence {
    /// `theirs == base` — no real external change. Self-writes terminate here.
    Unchanged,
    /// `mine == base` — the buffer has no edits, so theirs loads losslessly.
    TheirsOnly,
    /// Non-overlapping hunks combined cleanly.
    Merged(String),
    /// Both sides edited the same region differently.
    Conflict,
}

/// Split into lines, each keeping its own terminator (`\n` or `\r\n`).
fn split_lines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, _) in s.match_indices('\n') {
        out.push(&s[start..=i]);
        start = i + 1;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Three-way merge. Never panics; never returns partial content.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Divergence {
    if theirs == base {
        return Divergence::Unchanged;
    }
    if mine == base {
        return Divergence::TheirsOnly;
    }
    Divergence::Conflict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_keeping_terminators() {
        assert_eq!(split_lines("a\nb\n"), vec!["a\n", "b\n"]);
        assert_eq!(split_lines("a\r\nb\r\n"), vec!["a\r\n", "b\r\n"]);
        assert_eq!(split_lines("a\nb"), vec!["a\n", "b"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
    }

    #[test]
    fn theirs_equal_to_base_is_unchanged() {
        // This is where a self-write dies: after Toril saves, disk == base.
        assert_eq!(merge3("a\n", "a\nmine\n", "a\n"), Divergence::Unchanged);
    }

    #[test]
    fn mine_equal_to_base_is_theirs_only() {
        assert_eq!(merge3("a\n", "a\n", "a\ntheirs\n"), Divergence::TheirsOnly);
    }

    #[test]
    fn unchanged_wins_when_neither_side_moved() {
        assert_eq!(merge3("a\n", "a\n", "a\n"), Divergence::Unchanged);
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: 4 passed. (`split_lines` is currently unused by `merge3`, which is fine — Task 2 wires it in. If clippy complains about the unused function, leave it; Task 2 uses it.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/mergemd src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(mergemd): crate scaffold, line splitting, merge short-circuits"
```

---

## Task 2: Change extraction and clean merge

**Files:**
- Modify: `src-tauri/crates/mergemd/src/lib.rs`

**Interfaces:**
- Consumes: `split_lines`, `Divergence`, `merge3` from Task 1.
- Produces: internal `struct Change { base_start: usize, base_end: usize, lines: Vec<String> }` and `fn changes(base: &[&str], other: &[&str]) -> Vec<Change>`. `merge3` now returns `Merged` for non-overlapping edits.

**Background:** `similar::capture_diff_slices(Algorithm::Myers, old, new)` returns `Vec<DiffOp>`. `DiffOp` has four variants — `Equal { old_index, new_index, len }`, `Delete { old_index, old_len, new_index }`, `Insert { old_index, new_index, new_len }`, `Replace { old_index, old_len, new_index, new_len }`. Everything below is derived from those fields.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `src-tauri/crates/mergemd/src/lib.rs`:

```rust
    #[test]
    fn non_overlapping_edits_merge() {
        let base = "one\ntwo\nthree\n";
        let mine = "one CHANGED\ntwo\nthree\n";
        let theirs = "one\ntwo\nthree CHANGED\n";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("one CHANGED\ntwo\nthree CHANGED\n".to_string())
        );
    }

    #[test]
    fn insert_from_each_side_merges() {
        let base = "a\nb\n";
        let mine = "a\nMINE\nb\n";
        let theirs = "a\nb\nTHEIRS\n";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("a\nMINE\nb\nTHEIRS\n".to_string())
        );
    }

    #[test]
    fn deletion_on_one_side_is_taken() {
        let base = "a\nb\nc\n";
        let mine = "a\nc\n";
        let theirs = "a\nb\nc CHANGED\n";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("a\nc CHANGED\n".to_string())
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: the three new tests FAIL, each with `Conflict` where `Merged(..)` was expected — `merge3` still returns `Conflict` for everything that isn't a short-circuit.

- [ ] **Step 3: Implement change extraction and the merge walk**

Add above `merge3` in `src-tauri/crates/mergemd/src/lib.rs`:

```rust
use similar::{Algorithm, DiffOp, capture_diff_slices};

/// One side's edit, expressed in **base line coordinates**: base lines
/// `[base_start, base_end)` are replaced by `lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Change {
    base_start: usize,
    base_end: usize,
    lines: Vec<String>,
}

/// Project a diff of `base → other` into base-coordinate changes.
fn changes(base: &[&str], other: &[&str]) -> Vec<Change> {
    let mut out = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, base, other) {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index, old_len, ..
            } => out.push(Change {
                base_start: old_index,
                base_end: old_index + old_len,
                lines: Vec::new(),
            }),
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => out.push(Change {
                base_start: old_index,
                base_end: old_index,
                lines: other[new_index..new_index + new_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            }),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => out.push(Change {
                base_start: old_index,
                base_end: old_index + old_len,
                lines: other[new_index..new_index + new_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            }),
        }
    }
    out
}
```

Then replace the body of `merge3` (keeping the two short-circuits) with:

```rust
/// Three-way merge. Never panics; never returns partial content.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Divergence {
    if theirs == base {
        return Divergence::Unchanged;
    }
    if mine == base {
        return Divergence::TheirsOnly;
    }

    let base_lines = split_lines(base);
    let mine_changes = changes(&base_lines, &split_lines(mine));
    let theirs_changes = changes(&base_lines, &split_lines(theirs));

    let mut out = String::new();
    let mut pos = 0usize; // cursor in base lines
    let mut i = 0usize; // index into mine_changes
    let mut j = 0usize; // index into theirs_changes

    while pos < base_lines.len() || i < mine_changes.len() || j < theirs_changes.len() {
        let m = mine_changes.get(i).filter(|c| c.base_start <= pos);
        let t = theirs_changes.get(j).filter(|c| c.base_start <= pos);

        match (m, t) {
            (Some(mc), Some(tc)) => {
                // Both sides touch this position. Identical edits are a
                // convergent change and are taken once; anything else is a
                // genuine conflict — we do not guess.
                if mc == tc {
                    for line in &mc.lines {
                        out.push_str(line);
                    }
                    pos = mc.base_end.max(pos);
                    i += 1;
                    j += 1;
                } else {
                    return Divergence::Conflict;
                }
            }
            (Some(mc), None) => {
                for line in &mc.lines {
                    out.push_str(line);
                }
                pos = mc.base_end.max(pos);
                i += 1;
            }
            (None, Some(tc)) => {
                for line in &tc.lines {
                    out.push_str(line);
                }
                pos = tc.base_end.max(pos);
                j += 1;
            }
            (None, None) => {
                if pos < base_lines.len() {
                    out.push_str(base_lines[pos]);
                    pos += 1;
                } else {
                    // Both change lists still hold entries but neither starts at
                    // or before `pos`, and base is exhausted. Cannot happen with
                    // well-formed diffs; bail to the safe outcome rather than
                    // loop forever.
                    return Divergence::Conflict;
                }
            }
        }
    }

    Divergence::Merged(out)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/mergemd/src/lib.rs
git commit -m "feat(mergemd): project diffs into base coordinates and merge clean hunks"
```

---

## Task 3: Conflicts, convergent edits, and CRLF preservation

**Files:**
- Modify: `src-tauri/crates/mergemd/src/lib.rs`

**Interfaces:**
- Consumes: everything from Task 2. No signature changes — this task only adds tests, and fixes whatever they expose.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module:

```rust
    #[test]
    fn same_line_edited_differently_conflicts() {
        let base = "hello\n";
        let mine = "hello mine\n";
        let theirs = "hello theirs\n";
        assert_eq!(merge3(base, mine, theirs), Divergence::Conflict);
    }

    #[test]
    fn convergent_edit_merges_once() {
        // Both sides made the SAME change — that is agreement, not conflict.
        let base = "a\nb\n";
        let same = "a\nB\n";
        assert_eq!(
            merge3(base, same, same),
            Divergence::Merged("a\nB\n".to_string())
        );
    }

    #[test]
    fn two_inserts_at_the_same_position_conflict() {
        let base = "a\nb\n";
        let mine = "a\nMINE\nb\n";
        let theirs = "a\nTHEIRS\nb\n";
        assert_eq!(merge3(base, mine, theirs), Divergence::Conflict);
    }

    #[test]
    fn crlf_lines_keep_their_terminators_through_a_merge() {
        // A CRLF file edited on one line must come back CRLF everywhere, with
        // only the edited line different. If terminators did not travel with
        // their lines this would rewrite the whole file.
        let base = "one\r\ntwo\r\nthree\r\n";
        let mine = "one\r\ntwo EDITED\r\nthree\r\n";
        let theirs = "one\r\ntwo\r\nthree\r\n";
        // theirs == base here, so this is Unchanged — the interesting case is
        // when theirs also moved:
        assert_eq!(merge3(base, mine, theirs), Divergence::Unchanged);

        let theirs2 = "one CHANGED\r\ntwo\r\nthree\r\n";
        let merged = merge3(base, mine, theirs2);
        match merged {
            Divergence::Merged(text) => {
                assert_eq!(text, "one CHANGED\r\ntwo EDITED\r\nthree\r\n");
                assert!(!text.contains("\n\n"), "no stray bare newlines");
                assert_eq!(text.matches("\r\n").count(), 3, "all three lines stay CRLF");
            }
            other => panic!("expected Merged, got {other:?}"),
        }
    }

    #[test]
    fn a_file_without_a_trailing_newline_survives() {
        let base = "a\nb";
        let mine = "a CHANGED\nb";
        let theirs = "a\nb";
        assert_eq!(merge3(base, mine, theirs), Divergence::Unchanged);

        let theirs2 = "a\nb CHANGED";
        match merge3(base, mine, theirs2) {
            Divergence::Merged(text) => assert_eq!(text, "a CHANGED\nb CHANGED"),
            other => panic!("expected Merged, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run them**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: all 12 pass. These assert behavior the Task 2 walk should already produce — the `mc == tc` equality branch gives convergent-edit merging, and inequality gives `Conflict`.

**If `two_inserts_at_the_same_position_conflict` fails with `Merged`**, the two `Change`s differ only in `lines` and are being taken sequentially rather than compared. That means the `.filter(|c| c.base_start <= pos)` guard let only one side match. Do **not** relax the test — fix the walk so both sides are consulted at the same `pos`.

**If `crlf_lines_keep_their_terminators_through_a_merge` fails**, `split_lines` is dropping the `\r`. Re-check that the slice is `&s[start..=i]` (inclusive of `\n`), not `&s[start..i]`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/mergemd/src/lib.rs
git commit -m "test(mergemd): conflicts, convergent edits, CRLF and no-trailing-newline"
```

---

## Task 4: Conflict-file naming

**Files:**
- Modify: `src-tauri/crates/mergemd/src/lib.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pub fn unique_conflict_path(original: &Path, now: SystemTime) -> io::Result<PathBuf>`. Task 6 calls this.

**Naming rules from spec §3.4:** `note (conflict 2026-07-24 14-32-05).md`, beside the original. **Dashes, not colons** — a colon is illegal in a Windows filename and Windows is the primary target. Collisions get `-2`, `-3`… and never overwrite: a conflict file is itself user data.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module (and add the imports at the top of the file: `use std::path::{Path, PathBuf};`, `use std::time::{Duration, SystemTime, UNIX_EPOCH};`, `use std::io;`, `use std::fs;`):

```rust
    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn conflict_path_is_beside_the_original_with_a_windows_safe_stamp() {
        let dir = std::env::temp_dir().join(format!("mergemd-name-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("note.md");

        let p = unique_conflict_path(&original, at(1_800_000_000)).unwrap();
        let name = p.file_name().unwrap().to_str().unwrap();

        assert!(p.parent() == original.parent(), "must sit beside the original");
        assert!(name.starts_with("note (conflict "), "got {name}");
        assert!(name.ends_with(").md"), "extension preserved: {name}");
        assert!(!name.contains(':'), "colons are illegal on Windows: {name}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflict_path_preserves_an_html_extension() {
        let dir = std::env::temp_dir().join(format!("mergemd-html-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = unique_conflict_path(&dir.join("page.html"), at(1_800_000_000)).unwrap();
        assert!(
            p.file_name().unwrap().to_str().unwrap().ends_with(").html"),
            "a parked .html must stay .html"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflict_path_never_overwrites_an_existing_conflict_file() {
        let dir = std::env::temp_dir().join(format!("mergemd-collide-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("note.md");

        let first = unique_conflict_path(&original, at(1_800_000_000)).unwrap();
        fs::write(&first, b"parked").unwrap();

        // Same timestamp, so the plain name is taken.
        let second = unique_conflict_path(&original, at(1_800_000_000)).unwrap();
        assert_ne!(first, second, "must not hand back an occupied path");
        assert!(
            second.file_name().unwrap().to_str().unwrap().contains("-2"),
            "expected a -2 suffix, got {second:?}"
        );

        fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: FAIL — `cannot find function unique_conflict_path in this scope`.

- [ ] **Step 3: Implement it**

Add to `src-tauri/crates/mergemd/src/lib.rs` (top-level, after `merge3`). Put `use std::path::{Path, PathBuf};`, `use std::time::{SystemTime, UNIX_EPOCH};` and `use std::io;` with the other imports at the top of the file:

```rust
/// Format `now` as `YYYY-MM-DD HH-MM-SS` in UTC, using dashes throughout so the
/// result is a legal filename on Windows (§3.4).
fn stamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    // Civil-date conversion from days since the Unix epoch (Howard Hinnant's
    // algorithm). Avoids a date dependency for one format string (§2).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02} {hh:02}-{mm:02}-{ss:02}")
}

/// Pick an unused `<stem> (conflict <ts>)<.ext>` path beside `original`.
///
/// Never returns a path that already exists: a conflict file is user data, so a
/// collision gets a `-2`, `-3`… suffix rather than an overwrite (§3.4).
pub fn unique_conflict_path(original: &Path, now: SystemTime) -> io::Result<PathBuf> {
    let dir = original.parent().unwrap_or(Path::new("."));
    let stem = original
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = original.extension().and_then(|s| s.to_str());
    let ts = stamp(now);

    for n in 1..1000 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let name = match ext {
            Some(e) => format!("{stem} (conflict {ts}{suffix}).{e}"),
            None => format!("{stem} (conflict {ts}{suffix})"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "exhausted conflict-file name candidates",
    ))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/mergemd/src/lib.rs
git commit -m "feat(mergemd): Windows-safe conflict filenames that never overwrite"
```

---

## Task 5: No-content-loss property test, and add the crate to CI

**Files:**
- Modify: `src-tauri/crates/mergemd/src/lib.rs`
- Modify: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md` (the `### Commands` logic-crate line)

**Interfaces:**
- Consumes: `merge3` from Tasks 1–3.
- Produces: nothing new. This is the gate that makes the merge trustworthy.

**Why this test matters more than the others:** every other test checks a case someone thought of. This one checks the property the whole feature exists to guarantee — that a successful merge never drops a line. It is the difference between "the cases I imagined work" and "content loss is structurally excluded".

- [ ] **Step 1: Write the property test**

Add to the `tests` module. A small deterministic LCG keeps this dependency-free and reproducible — no `proptest`, per §2's dependency-light rule:

```rust
    /// Deterministic pseudo-random generator so a failure is reproducible from
    /// the seed alone. Avoids a proptest dependency for one property (§2).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }
        fn pick(&mut self, n: usize) -> usize {
            (self.next() as usize) % n
        }
    }

    /// Apply a few random edits to `lines`, returning the new text.
    fn mutate(lines: &[&str], rng: &mut Lcg, tag: &str) -> String {
        let mut v: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        let edits = 1 + rng.pick(3);
        for _ in 0..edits {
            if v.is_empty() {
                v.push(format!("{tag}-new\n"));
                continue;
            }
            let at = rng.pick(v.len());
            match rng.pick(3) {
                0 => v[at] = format!("{tag}-edit\n"),
                1 => v.insert(at, format!("{tag}-ins\n")),
                _ => {
                    v.remove(at);
                }
            }
        }
        v.concat()
    }

    #[test]
    fn a_successful_merge_never_drops_a_line() {
        let base_lines: Vec<&str> = vec!["l1\n", "l2\n", "l3\n", "l4\n", "l5\n", "l6\n"];
        let base = base_lines.concat();
        let mut rng = Lcg(0x5EED);

        for case in 0..500 {
            let mine = mutate(&base_lines, &mut rng, "M");
            let theirs = mutate(&base_lines, &mut rng, "T");

            match merge3(&base, &mine, &theirs) {
                // Conflict is always an acceptable answer — it writes nothing.
                Divergence::Conflict => {}
                Divergence::Unchanged | Divergence::TheirsOnly => {}
                Divergence::Merged(out) => {
                    // Every line either side introduced must survive. This is
                    // the §3 guarantee: a clean merge loses nothing.
                    for line in split_lines(&mine) {
                        if !split_lines(&base).contains(&line) {
                            assert!(
                                out.contains(line),
                                "case {case}: merged output dropped a line of MINE\n\
                                 line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                            );
                        }
                    }
                    for line in split_lines(&theirs) {
                        if !split_lines(&base).contains(&line) {
                            assert!(
                                out.contains(line),
                                "case {case}: merged output dropped a line of THEIRS\n\
                                 line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                            );
                        }
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Run it**

Run: `cd src-tauri && cargo test -p mergemd`
Expected: 16 passed.

**If it fails**, the walk in Task 2 is emitting a merge where it should have returned `Conflict`. Fix the walk — do **not** weaken the assertion or reduce the case count. A merge that drops a line is the exact failure this branch exists to prevent.

- [ ] **Step 3: Add `mergemd` to CI**

In `.github/workflows/ci.yml`, the `Test logic crates` step lists packages one per line. Add `mergemd` after `-p snapshots`:

```yaml
          -p snapshots
          -p mergemd
```

- [ ] **Step 4: Update the CLAUDE.md command line**

In `CLAUDE.md`'s `### Commands` block, the logic-crate line currently ends `-p trashbin -p snapshots`. Append ` -p mergemd`, and change the comment above it from "the same seven CI runs" to "the same eight CI runs".

- [ ] **Step 5: Verify everything is clean**

Run: `cd src-tauri && cargo test -p mergemd && cargo fmt --all --check && cargo clippy -p mergemd -- -D warnings`
Expected: tests pass, fmt clean, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/mergemd/src/lib.rs .github/workflows/ci.yml CLAUDE.md
git commit -m "test(mergemd): property-test that a clean merge never drops a line"
```

---

## Task 6: Backend commands

**Files:**
- Create: `src-tauri/src/commands/sync.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs:54-76`

**Interfaces:**
- Consumes: `mergemd::{merge3, unique_conflict_path, Divergence}`.
- Produces two Tauri commands. The wire shape later tasks depend on:
  - `merge_external(path: String, base: String, mine: String) -> Result<MergeReport, String>` where `MergeReport { outcome: "unchanged" | "theirsOnly" | "merged" | "conflict", content: Option<String>, theirs: Option<String> }`.
  - `write_conflict_copy(path: String, content: String) -> Result<String, String>` returning the path actually written.

> **Note — a correction to spec §4.** The spec's `merge_external` returns only `{ outcome, content? }`. That is not enough: §5.4's **Keep mine** must park *theirs*, and §5.2's `Merged`/`TheirsOnly` must set `base = theirs`. Reading the file a second time to get it would race the sync daemon that just wrote it. So `MergeReport` also carries `theirs`, populated for every outcome except `unchanged` (where by definition `theirs == base`, which the caller already has).

- [ ] **Step 1: Write the command module**

`src-tauri/src/commands/sync.rs`:

```rust
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
    /// `"unchanged" | "theirsOnly" | "merged" | "conflict"`.
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
#[tauri::command]
pub fn merge_external(path: String, base: String, mine: String) -> Result<MergeReport, String> {
    let theirs = fsatomic::read_to_string(&path).map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn write_conflict_copy(path: String, content: String) -> Result<String, String> {
    let target =
        unique_conflict_path(std::path::Path::new(&path), SystemTime::now()).map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}
```

- [ ] **Step 2: Register the module and the commands**

In `src-tauri/src/commands/mod.rs`, add in alphabetical position (after `pub mod snapshots;`):

```rust
pub mod sync;
```

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![…]`, after the `commands::snapshots::restore_snapshot,` line:

```rust
            commands::sync::merge_external,
            commands::sync::write_conflict_copy,
```

- [ ] **Step 3: Verify it compiles and is clean**

Run: `cd src-tauri && cargo test --workspace && cargo fmt --all --check && cargo clippy --workspace --all-targets 2>&1 | grep -E "^(warning|error).*toril|^error" | head`
Expected: workspace tests pass; fmt clean; no warnings or errors attributable to first-party crates. (The vendored `glib` produces pre-existing clippy warnings — those are expected and excluded by CLAUDE.md §2.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/sync.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(sync): merge_external and write_conflict_copy commands

merge_external reports and never writes; the frontend owns policy so the
HTML-never-auto-merges rule lives in one place. It returns theirs as well
as the outcome, which the spec omitted — Keep mine has to park theirs,
and re-reading the file to get it would race the sync daemon."
```

---

## Task 7: Per-tab `base` and `diverged` state, and the IPC wrappers

**Files:**
- Modify: `src/ui/tabs.ts`
- Modify: `src/ipc.ts`
- Modify: `tests/tabs.test.ts`

**Interfaces:**
- Consumes: the wire shape from Task 6.
- Produces:
  - `TabState.base: string` and `TabState.diverged: DivergedState | null`.
  - `export interface DivergedState { theirs: string; reason: "conflict" | "error"; message: string }`.
  - `TabManager.setBase(id: string, base: string): void` and `TabManager.setDiverged(id: string, d: DivergedState | null): void`.
  - `mergeExternal(path, base, mine): Promise<MergeReport>` and `writeConflictCopy(path, content): Promise<string>` from `ipc.ts`, plus `MergeOutcome` / `MergeReport` types.

- [ ] **Step 1: Write the failing test**

Add to `tests/tabs.test.ts`:

```ts
  it("seeds base from the content a tab opened with", () => {
    const { tabs } = makeTabs();
    const tab = tabs.open({ path: "/v/a.md", name: "a.md", content: "hello\n" });
    expect(tab.base).toBe("hello\n");
    expect(tab.diverged).toBeNull();
  });

  it("tracks base independently of the buffer", () => {
    const { tabs } = makeTabs();
    const tab = tabs.open({ path: "/v/a.md", name: "a.md", content: "hello\n" });
    tab.content = "hello edited\n";
    expect(tab.base).toBe("hello\n"); // base is what disk had, not the buffer

    tabs.setBase(tab.id, "hello edited\n"); // as a save would
    expect(tab.base).toBe("hello edited\n");
  });

  it("stores and clears divergence", () => {
    const { tabs } = makeTabs();
    const tab = tabs.open({ path: "/v/a.md", name: "a.md", content: "x\n" });
    tabs.setDiverged(tab.id, {
      theirs: "y\n",
      reason: "conflict",
      message: "changed on disk",
    });
    expect(tab.diverged?.theirs).toBe("y\n");
    tabs.setDiverged(tab.id, null);
    expect(tab.diverged).toBeNull();
  });
```

If `tests/tabs.test.ts` has no `makeTabs` helper, use whatever construction the existing tests in that file use — read the top of the file and match it.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/tabs.test.ts`
Expected: FAIL — `base` is `undefined` and `setBase` does not exist.

- [ ] **Step 3: Add the state to `tabs.ts`**

In `src/ui/tabs.ts`, add above `TabState`:

```ts
/**
 * Why a tab is blocked from writing, and the disk content that caused it.
 *
 * `theirs` is captured at detection time so a resolution can park the losing
 * side without re-reading the file — a second read could race the sync daemon
 * that wrote it.
 */
export interface DivergedState {
  theirs: string;
  reason: "conflict" | "error";
  message: string;
}
```

Add to the `TabState` interface, after `dirty`:

```ts
  /**
   * Exact bytes last read from / written to disk — the merge base for a
   * three-way merge (ROADMAP I.4). Kept in memory only: it is always exactly
   * right while the app runs, and needs no storage.
   */
  base: string;
  /** Non-null while the tab is diverged from disk. Blocks all writes (§3). */
  diverged: DivergedState | null;
```

In `open()`, extend the object literal that builds `tab`:

```ts
      dirty: false,
      base: opts.content,
      diverged: null,
```

Add the two setters as methods on `TabManager`, beside the existing `setDirty`:

```ts
  /** Record the bytes now on disk for this tab (open, save, reload, merge). */
  setBase(id: string, base: string): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab) tab.base = base;
  }

  /** Mark or clear divergence. While set, no write path may touch this tab. */
  setDiverged(id: string, d: DivergedState | null): void {
    const tab = this.items.find((t) => t.id === id);
    if (tab) tab.diverged = d;
  }
```

- [ ] **Step 4: Add the IPC wrappers**

In `src/ipc.ts`, add near the other file commands:

```ts
export type MergeOutcome = "unchanged" | "theirsOnly" | "merged" | "conflict";

export interface MergeReport {
  outcome: MergeOutcome;
  /** The merged text. Present only for `"merged"`. */
  content: string | null;
  /** Bytes now on disk. Present for everything except `"unchanged"`. */
  theirs: string | null;
}

/**
 * Three-way merge the file at `path` against `base` and `mine`. Reads only —
 * this never writes, so calling it is always safe (§5 contract).
 */
export function mergeExternal(path: string, base: string, mine: string): Promise<MergeReport> {
  return invoke<MergeReport>("merge_external", { path, base, mine });
}

/** Park `content` beside `path` as a `… (conflict <ts>)` file. Returns its path. */
export function writeConflictCopy(path: string, content: string): Promise<string> {
  return invoke<string>("write_conflict_copy", { path, content });
}
```

- [ ] **Step 5: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass. `pnpm typecheck` may flag other construction sites of `TabState` that now need `base`/`diverged` — fix those by passing the values through, not by making the fields optional. Optional fields would let a write path skip the check.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tabs.ts src/ipc.ts tests/tabs.test.ts
git commit -m "feat(tabs): per-tab merge base and divergence state, plus IPC wrappers"
```

---

## Task 8: `src/sync.ts` — the pure policy module

**Files:**
- Create: `src/sync.ts`
- Create: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `MergeOutcome`, `MergeReport` from `ipc.ts`; `DocFormat`, `DivergedState` from `tabs.ts`.
- Produces:
  - `type SyncAction = { kind: "none" } | { kind: "reload"; theirs: string } | { kind: "applyMerge"; merged: string; theirs: string; clean: boolean } | { kind: "conflict"; theirs: string; message: string }`
  - `decideAction(report: MergeReport, format: DocFormat): SyncAction`
  - `blocksWrite(tab: { diverged: DivergedState | null }): boolean`
  - `selectSavable<T extends { dirty: boolean; path: string | null; diverged: DivergedState | null }>(tabs: readonly T[]): T[]`

**Why this file exists:** following the `toolbar.ts` precedent, the decision logic is exported separately from the DOM so the gate runs headlessly. It is also the single place the HTML rule lives.

- [ ] **Step 1: Write the failing test**

`tests/sync.test.ts`:

```ts
// GATE for external-change reconciliation (CLAUDE.md §3, ROADMAP I.4).
//
// The rule this file protects: a conflict must never silently overwrite either
// side. That decomposes into three testable properties —
//
//   1. the outcome→action mapping is total and HTML never auto-merges;
//   2. a diverged tab is excluded from every write path;
//   3. a resolution parks the losing side BEFORE anything is overwritten.
import { describe, expect, it } from "vitest";
import { blocksWrite, decideAction, selectSavable } from "../src/sync";
import type { MergeReport } from "../src/ipc";

const report = (r: Partial<MergeReport> & Pick<MergeReport, "outcome">): MergeReport => ({
  content: null,
  theirs: null,
  ...r,
});

describe("decideAction", () => {
  it("does nothing when disk matches the base (this is where self-writes die)", () => {
    expect(decideAction(report({ outcome: "unchanged" }), "markdown")).toEqual({ kind: "none" });
  });

  it("reloads when only disk moved", () => {
    const a = decideAction(report({ outcome: "theirsOnly", theirs: "disk\n" }), "markdown");
    expect(a).toEqual({ kind: "reload", theirs: "disk\n" });
  });

  it("applies a clean merge and keeps the tab dirty", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "merged\n", theirs: "disk\n" }),
      "markdown",
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "merged\n", theirs: "disk\n", clean: false });
  });

  it("marks the tab CLEAN when the merge result already equals disk", () => {
    // Convergent edit: without this the tab sits dirty with nothing to save,
    // which reads as a bug.
    const a = decideAction(
      report({ outcome: "merged", content: "same\n", theirs: "same\n" }),
      "markdown",
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "same\n", theirs: "same\n", clean: true });
  });

  it("never auto-merges HTML — a line merge can unbalance tags", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "<p>x</p>", theirs: "<p>y</p>" }),
      "html",
    );
    expect(a.kind).toBe("conflict");
  });

  it("raises a conflict when both sides changed the same region", () => {
    const a = decideAction(report({ outcome: "conflict", theirs: "disk\n" }), "markdown");
    expect(a.kind).toBe("conflict");
    if (a.kind === "conflict") expect(a.theirs).toBe("disk\n");
  });

  it("falls back to conflict rather than losing data if theirs is missing", () => {
    // Defensive: a malformed report must fail closed, never silently proceed.
    const a = decideAction(report({ outcome: "merged", content: "x\n", theirs: null }), "markdown");
    expect(a.kind).toBe("conflict");
  });
});

describe("write gating", () => {
  const tab = (over: Partial<{ dirty: boolean; path: string | null; diverged: unknown }> = {}) => ({
    dirty: true,
    path: "/v/a.md",
    diverged: null,
    ...over,
  }) as { dirty: boolean; path: string | null; diverged: null };

  it("blocks a write while diverged", () => {
    expect(blocksWrite(tab())).toBe(false);
    expect(
      blocksWrite(
        tab({ diverged: { theirs: "x", reason: "conflict", message: "m" } }) as never,
      ),
    ).toBe(true);
  });

  it("excludes diverged tabs from Save All and autosave", () => {
    const clean = tab({ dirty: false });
    const untitled = tab({ path: null });
    const diverged = tab({ diverged: { theirs: "x", reason: "conflict", message: "m" } }) as never;
    const savable = tab();

    const out = selectSavable([clean, untitled, diverged, savable]);
    expect(out).toEqual([savable]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/sync.test.ts`
Expected: FAIL — `Failed to resolve import "../src/sync"`.

- [ ] **Step 3: Implement the module**

`src/sync.ts`:

```ts
// Pure reconciliation policy (CLAUDE.md §3, ROADMAP Movement I.4).
//
// No DOM and no IPC, so the gate runs headlessly — the `toolbar.ts` precedent.
// `merge_external` reports what IS; this module decides what to DO, which keeps
// the "HTML never auto-merges" rule in exactly one place.
import type { MergeReport } from "./ipc";
import type { DivergedState, DocFormat } from "./ui/tabs";

export type SyncAction =
  | { kind: "none" }
  | { kind: "reload"; theirs: string }
  | { kind: "applyMerge"; merged: string; theirs: string; clean: boolean }
  | { kind: "conflict"; theirs: string; message: string };

/**
 * Map a merge report onto an action. Total over every outcome, and fails closed:
 * anything it cannot safely apply becomes a conflict, which writes nothing.
 */
export function decideAction(report: MergeReport, format: DocFormat): SyncAction {
  if (report.outcome === "unchanged") return { kind: "none" };

  // Every remaining outcome needs `theirs` — to reload, to set the new base, or
  // to park. A report without it is malformed; treat it as a conflict rather
  // than guessing, since a conflict never writes.
  const theirs = report.theirs;
  if (theirs === null) {
    return { kind: "conflict", theirs: "", message: "Changed on disk (could not read it)" };
  }

  if (report.outcome === "theirsOnly") return { kind: "reload", theirs };

  if (report.outcome === "merged") {
    // A line-level merge of two HTML documents can produce unbalanced tags,
    // which html-serializer.ts would then normalize on load — corrupting
    // silently. Markdown only (§2).
    if (format === "html") {
      return { kind: "conflict", theirs, message: "Changed on disk — HTML is not auto-merged" };
    }
    if (report.content === null) {
      return { kind: "conflict", theirs, message: "Changed on disk (merge produced nothing)" };
    }
    // If the merged result already equals disk, the buffer matches the file and
    // there is nothing left to save — mark it clean, or the tab sits dirty with
    // no pending change, which reads as a bug.
    return {
      kind: "applyMerge",
      merged: report.content,
      theirs,
      clean: report.content === theirs,
    };
  }

  return { kind: "conflict", theirs, message: "Changed on disk while you were editing" };
}

/** True while a tab must not be written. */
export function blocksWrite(tab: { diverged: DivergedState | null }): boolean {
  return tab.diverged !== null;
}

/**
 * Dirty, path-backed, non-diverged tabs — the only ones Save All or autosave
 * may write. Save All is the real clobber vector: it loops every dirty tab, so a
 * background tab that diverged an hour ago would otherwise be overwritten with
 * no prompt ever shown (§5.5).
 */
export function selectSavable<
  T extends { dirty: boolean; path: string | null; diverged: DivergedState | null },
>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.dirty && t.path !== null && !blocksWrite(t));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/sync.test.ts && pnpm typecheck`
Expected: 9 passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat(sync): pure reconciliation policy, headlessly gated

Fails closed by construction: any report it cannot safely apply becomes a
conflict, and a conflict writes nothing."
```

---

## Task 9: The conflict banner

**Files:**
- Create: `src/ui/conflictbar.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `DivergedState` from `tabs.ts`.
- Produces: `class ConflictBar { constructor(host: HTMLElement); show(opts: { name: string; message: string; onKeepMine(): void; onUseTheirs(): void }): void; hide(): void }`.

**Why not `confirm()`:** the current code uses one (`main.ts:499`). A `confirm()` cannot represent a background tab, evaporates when dismissed, and — as written today — discards unsaved work on a single OK click. The banner is non-blocking and per-tab.

- [ ] **Step 1: Write the module**

`src/ui/conflictbar.ts`:

```ts
// The conflict banner (ROADMAP Movement I.4, spec §5.4).
//
// Non-blocking and per-tab, rendered from `tab.diverged`. Never a `confirm()`:
// that cannot represent a background tab, evaporates when dismissed, and gives
// the user one click to destroy unsaved work.
//
// Both actions park the losing side, so no path through this UI discards bytes.

export interface ConflictBarOptions {
  name: string;
  message: string;
  /** Park theirs; the buffer keeps the original path. */
  onKeepMine(): void;
  /** Park mine; reload theirs into the buffer. */
  onUseTheirs(): void;
}

export class ConflictBar {
  private readonly el: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "conflict-bar";
    this.el.hidden = true;
    this.el.setAttribute("role", "alert");
    host.appendChild(this.el);
  }

  show(opts: ConflictBarOptions): void {
    this.el.replaceChildren();

    const text = document.createElement("span");
    text.className = "conflict-bar-text";
    text.textContent = `${opts.name} — ${opts.message}`;
    this.el.appendChild(text);

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "conflict-bar-btn";
    keep.textContent = "Keep mine";
    keep.title = "Save the disk version alongside as a conflict copy, and keep editing yours";
    keep.addEventListener("click", () => opts.onKeepMine());
    this.el.appendChild(keep);

    const theirs = document.createElement("button");
    theirs.type = "button";
    theirs.className = "conflict-bar-btn";
    theirs.textContent = "Use theirs";
    theirs.title = "Save your version alongside as a conflict copy, and load the disk version";
    theirs.addEventListener("click", () => opts.onUseTheirs());
    this.el.appendChild(theirs);

    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
    this.el.replaceChildren();
  }
}
```

- [ ] **Step 2: Add the styling**

Append to `src/styles.css`:

```css
/* Conflict banner (ROADMAP I.4) — non-blocking, above the editor. Uses the
   warning role rather than danger: nothing has been lost, a decision is due. */
.conflict-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--warn-bg, #4a3a1a);
  color: var(--warn-fg, #f4e2be);
  border-bottom: 1px solid var(--warn-border, #6b5424);
  font-size: 13px;
}
.conflict-bar[hidden] {
  display: none;
}
.conflict-bar-text {
  flex: 1 1 auto;
  min-width: 0;
}
.conflict-bar-btn {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--warn-border, #6b5424);
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.conflict-bar-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: clean; suite unchanged (nothing imports the bar yet).

- [ ] **Step 4: Commit**

```bash
git add src/ui/conflictbar.ts src/styles.css
git commit -m "feat(ui): non-blocking per-tab conflict banner"
```

---

## Task 10: Wire the watcher, delete `isSelfWrite`

**Files:**
- Modify: `src/main.ts` — `handleWorkspaceChange` (~line 491), `isSelfWrite` (~line 469), `recordSelfWrite` (~line 219), and the `selfWrites` map (~line 81)

**Interfaces:**
- Consumes: `decideAction` (Task 8), `ConflictBar` (Task 9), `mergeExternal`/`writeConflictCopy` (Task 7), `tabs.setBase`/`setDiverged` (Task 7).
- Produces: `reconcile(tab: TabState): Promise<void>` and `resolveConflict(tab: TabState, keepMine: boolean): Promise<void>` inside `main.ts`. Task 11 calls `reconcile`.

**What is deleted and why:** `isSelfWrite`'s 2-second window guesses. `Unchanged` knows: after Toril saves, disk equals base, so a self-triggered event returns `Unchanged` and stops. Byte comparison has no false negative when a sync daemon is slow to flush, and no false positive when an external edit lands inside two seconds.

- [ ] **Step 1: Add the imports and the bar instance**

In `src/main.ts`, add to the imports:

```ts
import { blocksWrite, decideAction, selectSavable } from "./sync";
import { ConflictBar } from "./ui/conflictbar";
```

and add `mergeExternal` and `writeConflictCopy` to the **existing** `./ipc` import
list (it already imports `openFile`, `saveFile`, and others — extend that
statement rather than adding a second one):

```ts
import {
  // …existing named imports…
  mergeExternal,
  writeConflictCopy,
} from "./ipc";
```

Add to the module-level declarations near the other UI singletons:

```ts
let conflictBar: ConflictBar | null = null;
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

Construct it during bootstrap, beside the other UI setup (it needs a host element above the editor — use the same parent the editor mounts into):

```ts
  conflictBar = new ConflictBar(document.querySelector("#main") as HTMLElement);
```

- [ ] **Step 2: Delete the self-write machinery**

Remove all four of these:

1. `const selfWrites = new Map<string, number>();` (~line 81)
2. the whole `function recordSelfWrite(path: string): void { … }` (~lines 219-221)
3. the whole `function isSelfWrite(path: string): boolean { … }` (~lines 469-477)
4. every call to `recordSelfWrite(...)` — five sites, at roughly lines 227, 257, 290, 381, and inside `persistActive`

Also remove the stale mention of `recordSelfWrite` in the comment near line 368.

- [ ] **Step 3: Replace `handleWorkspaceChange`**

Replace the whole existing `handleWorkspaceChange` function with:

```ts
/**
 * Reconcile one tab against disk and act on the result.
 *
 * Called from the watcher and from the pre-save check. The watcher is an
 * optimization; the save path is the guarantee (§2) — watchers drop and
 * coalesce events on network shares and some sync clients.
 */
async function reconcile(tab: TabState): Promise<void> {
  if (!tab.path) return;
  const mine = tab.id === tabs.active()?.id ? serializeEditor(tab.format) : tab.content;

  let report;
  try {
    report = await mergeExternal(tab.path, tab.base, mine);
  } catch {
    // One retry: a sync client may hold the file open for a moment mid-write.
    await new Promise((r) => setTimeout(r, 200));
    try {
      report = await mergeExternal(tab.path, tab.base, mine);
    } catch (e) {
      // Fail closed — block writes rather than risk overwriting something we
      // could not read (§6).
      tabs.setDiverged(tab.id, {
        theirs: "",
        reason: "error",
        message: `could not be compared with disk (${String(e)})`,
      });
      renderConflictBar();
      return;
    }
  }

  const action = decideAction(report, tab.format);
  switch (action.kind) {
    case "none":
      // If an external writer reverted their change, the conflict resolves
      // itself and the banner goes away (§5.2).
      if (tab.diverged) {
        tabs.setDiverged(tab.id, null);
        renderConflictBar();
      }
      return;

    case "reload":
      tab.content = action.theirs;
      tabs.setBase(tab.id, action.theirs);
      tabs.setDiverged(tab.id, null);
      tabs.setDirty(tab.id, false);
      if (tab.id === tabs.active()?.id) {
        loadIntoEditor(action.theirs, tab.format);
        outline?.refresh();
      }
      updateTitle();
      renderConflictBar();
      setStatus(`Reloaded ${tab.name}`);
      return;

    case "applyMerge":
      tab.content = action.merged;
      // base becomes THEIRS, not the merged text: theirs is what is on disk now.
      tabs.setBase(tab.id, action.theirs);
      tabs.setDiverged(tab.id, null);
      tabs.setDirty(tab.id, !action.clean);
      if (tab.id === tabs.active()?.id) {
        loadIntoEditor(action.merged, tab.format);
        outline?.refresh();
      }
      updateTitle();
      renderConflictBar();
      setStatus(
        action.clean
          ? `${tab.name}: external changes matched yours`
          : `Merged external changes into ${tab.name} — review and save`,
      );
      return;

    case "conflict":
      tabs.setDiverged(tab.id, {
        theirs: action.theirs,
        reason: "conflict",
        message: action.message,
      });
      renderConflictBar();
      return;
  }
}

/** Show the banner for the active tab if it is diverged; hide it otherwise. */
function renderConflictBar(): void {
  const tab = tabs.active();
  if (!tab || !tab.diverged) {
    conflictBar?.hide();
    return;
  }
  conflictBar?.show({
    name: tab.name,
    message: tab.diverged.message,
    onKeepMine: () => void resolveConflict(tab, true),
    onUseTheirs: () => void resolveConflict(tab, false),
  });
}

/**
 * Resolve a conflict by parking the losing side, in both directions.
 *
 * The park happens FIRST. If it fails the whole resolution aborts — no reload,
 * `diverged` stays set. If we cannot preserve the losing side, we do not get to
 * destroy it (§6). This is the most important error path in the feature.
 */
async function resolveConflict(tab: TabState, keepMine: boolean): Promise<void> {
  if (!tab.path || !tab.diverged) return;
  const theirs = tab.diverged.theirs;
  const mine = tab.id === tabs.active()?.id ? serializeEditor(tab.format) : tab.content;

  let parked: string;
  try {
    parked = await writeConflictCopy(tab.path, keepMine ? theirs : mine);
  } catch (e) {
    setStatus(`Could not save the conflict copy — nothing changed (${String(e)})`);
    return; // diverged stays set; the banner stays up
  }

  if (keepMine) {
    tabs.setBase(tab.id, theirs); // disk holds theirs; the buffer is still ours
    tabs.setDiverged(tab.id, null);
    tabs.setDirty(tab.id, true);
  } else {
    tab.content = theirs;
    tabs.setBase(tab.id, theirs);
    tabs.setDiverged(tab.id, null);
    tabs.setDirty(tab.id, false);
    if (tab.id === tabs.active()?.id) {
      loadIntoEditor(theirs, tab.format);
      outline?.refresh();
    }
  }
  updateTitle();
  renderConflictBar();
  if (workspaceRoot) scheduleSidebarRefresh();
  setStatus(`Saved the other version as ${basename(parked)}`);
}

async function handleWorkspaceChange(change: WorkspaceChange): Promise<void> {
  scheduleSidebarRefresh();

  if (change.kind === "remove") {
    // A sync daemon deleting a file the user has open must not vaporize their
    // buffer. Keep it, mark it dirty; the next save recreates the file (§5.7).
    for (const tab of tabs.list()) {
      if (tab.path && change.paths.includes(tab.path)) {
        tabs.setDirty(tab.id, true);
        setStatus(`${tab.name} was removed on disk — save to recreate it`);
      }
    }
    updateTitle();
    return;
  }
  if (change.kind !== "modify" && change.kind !== "create") return;

  // Every tab whose path changed, not only the active one. Debounced per path:
  // sync daemons emit bursts (write, chmod, touch) and today's code reacts to
  // every one.
  for (const tab of tabs.list()) {
    if (!tab.path || !change.paths.includes(tab.path)) continue;
    const path = tab.path;
    const existing = reconcileTimers.get(path);
    if (existing) clearTimeout(existing);
    reconcileTimers.set(
      path,
      setTimeout(() => {
        reconcileTimers.delete(path);
        const current = tabs.byPath(path);
        if (current) void reconcile(current);
      }, 250),
    );
  }
}
```

- [ ] **Step 4: Set `base` on every save and reload path**

`base` must follow disk. Add `tabs.setBase(...)` at each write site:

- In `persistActive`, after `tab.content = content;`:
  ```ts
  tabs.setBase(tab.id, content);
  ```
- In `saveTabsToDisk`, after `await saveFile(tab.path, tab.content);`:
  ```ts
  tabs.setBase(tab.id, tab.content);
  ```
- In `doSaveAs`, after `tab.content = content;`:
  ```ts
  tabs.setBase(tab.id, content);
  ```
- In the history-restore path (~line 381, where `recordSelfWrite` was), after the buffer is reloaded from disk, set `base` to the restored content.

- [ ] **Step 5: Call `renderConflictBar` on tab switch**

The banner is per-tab, so switching tabs must re-render it. In the `onActivate` callback passed to `TabManager`, add `renderConflictBar();` as the last statement.

- [ ] **Step 6: Verify**

Run: `pnpm test && pnpm typecheck`
Expected: all pass. If `pnpm typecheck` reports `serializeEditor` or `loadIntoEditor` used before definition, move `reconcile`/`resolveConflict`/`renderConflictBar` below them — they are function declarations so hoisting applies, but keep the file's existing ordering conventions.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(sync): reconcile every changed tab, and delete isSelfWrite

The 2-second self-write window guessed; Unchanged knows. After Toril
saves, disk equals base, so a self-triggered event returns Unchanged and
stops — no false negative when a sync daemon is slow to flush, no false
positive when an external edit lands fast.

Also handles external deletion, which was previously ignored: the buffer
is kept and marked dirty rather than the tab being left to overwrite or
lose it."
```

---

## Task 11: Gate every write path

**Files:**
- Modify: `src/main.ts` — `doSave`, `doSaveAll`, `saveTabsToDisk`, and the `AutosaveScheduler` dependency at ~line 782

**Interfaces:**
- Consumes: `reconcile` (Task 10), `blocksWrite`/`selectSavable` (Task 8).
- Produces: nothing new.

**Why this is the task that actually makes the feature safe:** the watcher can miss events. The pre-save check cannot — it runs on the write path itself, so a divergence that no event announced is still caught before bytes land.

- [ ] **Step 1: Add the pre-save check to `doSave`**

Replace `doSave` with:

```ts
async function doSave(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  if (!tab.path) {
    // An Untitled draft has nothing on disk to diverge from (§5.6 exemption).
    await doSaveAs();
    return;
  }
  if (blocksWrite(tab)) {
    renderConflictBar();
    setStatus(`${tab.name} changed on disk — resolve the banner before saving`);
    return;
  }
  // Re-check disk before writing. The watcher is an optimization; this is the
  // guarantee (§2). Costs one extra read per save.
  await reconcile(tab);
  if (blocksWrite(tab)) {
    setStatus(`${tab.name} changed on disk — resolve the banner before saving`);
    return;
  }
  try {
    await persistActive(tab.path);
  } catch (e) {
    setStatus(`Save failed: ${String(e)}`);
  }
}
```

> **Do not add a check to `doSaveAs`.** It is exempt by design (§5.6): Save As to a
> *new* path has no shared history with that path, so there is nothing to diverge
> from. Save As *over* an existing file is a plain overwrite the user explicitly
> chose in the native dialog, and stays that way. Adding a check there would block
> a legitimate first write and make the dialog behave unpredictably.

- [ ] **Step 2: Gate `saveTabsToDisk` and `doSaveAll`**

In `saveTabsToDisk`, add immediately after `if (!tab.path) continue;`:

```ts
    if (blocksWrite(tab)) {
      setStatus(`Skipped ${tab.name} — it changed on disk`);
      continue;
    }
```

In `doSaveAll`, replace the filter so diverged tabs are excluded and each candidate is re-checked first:

```ts
async function doSaveAll(): Promise<void> {
  captureActiveBuffer();
  // Re-check every candidate before writing any of them. Save All is the real
  // clobber vector: it loops every dirty tab, so a background tab that diverged
  // an hour ago would otherwise be overwritten with no prompt ever shown (§5.5).
  for (const tab of selectSavable(tabs.list())) {
    await reconcile(tab);
  }
  const saved = await saveTabsToDisk(selectSavable(tabs.list()));
  updateTitle();
  autosave?.notifyChange();
  renderConflictBar();
  if (saved > 0) setStatus(`Saved ${saved} file${saved === 1 ? "" : "s"}`);
}
```

- [ ] **Step 3: Suspend autosave while diverged**

In the `AutosaveScheduler` construction (~line 782), change `saveDirtySaved` to use `selectSavable` instead of `selectDirtySaved`:

```ts
      saveDirtySaved: async () => {
        captureActiveBuffer();
        // Autosave writing over an external change with the user absent is
        // precisely the silent overwrite §3 forbids — diverged tabs are excluded.
        await saveTabsToDisk(selectSavable(tabs.list()));
        updateTitle();
      },
```

Remove `selectDirtySaved` from the `./autosave` import if nothing else uses it (check with a grep before deleting — `snapshotDirty` and `RecoveryEntry` are still needed).

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(sync): save, Save All and autosave all refuse a diverged tab

The pre-save re-check is the correctness guarantee, not the watcher:
watchers drop and coalesce events on network shares and some sync
clients, so a design protected only by 'we got notified' fails silently
on exactly the setups this branch exists to support."
```

---

## Task 12: Resolution-ordering test

**Files:**
- Modify: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `selectSavable`, `blocksWrite` from Task 8.
- Produces: nothing new.

**Why a separate task:** the park-before-overwrite ordering in `resolveConflict` is the single most important error path in the feature, and it lives in `main.ts` where it is not directly unit-testable. This task tests the invariant at the level that *is* testable, and records why full coverage needs the on-device pass.

- [ ] **Step 1: Add the tests**

Append to `tests/sync.test.ts`:

```ts
describe("resolution ordering (the invariant that matters most)", () => {
  // resolveConflict lives in main.ts, which needs a live editor and Tauri IPC,
  // so it is exercised on-device (§8). What IS unit-testable is the contract it
  // depends on: a failed park must leave the tab diverged, so the next write
  // attempt is still refused. These assert that contract.

  const diverged = () => ({
    dirty: true,
    path: "/v/a.md",
    diverged: { theirs: "disk\n", reason: "conflict" as const, message: "m" },
  });

  it("keeps refusing writes while divergence is unresolved", () => {
    const tab = diverged();
    expect(blocksWrite(tab)).toBe(true);
    expect(selectSavable([tab])).toEqual([]);
  });

  it("captures theirs at detection time so a resolution needs no second read", () => {
    // A second read could race the sync daemon that just wrote the file; the
    // parked copy must be the bytes we actually compared against.
    const tab = diverged();
    expect(tab.diverged.theirs).toBe("disk\n");
  });

  it("permits writes again only once divergence is cleared", () => {
    const tab: {
      dirty: boolean;
      path: string | null;
      diverged: { theirs: string; reason: "conflict"; message: string } | null;
    } = diverged();
    tab.diverged = null;
    expect(blocksWrite(tab)).toBe(false);
    expect(selectSavable([tab])).toEqual([tab]);
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run tests/sync.test.ts && pnpm test && pnpm typecheck`
Expected: 12 passed in `sync.test.ts`; full suite green.

- [ ] **Step 3: Commit**

```bash
git add tests/sync.test.ts
git commit -m "test(sync): a failed park leaves the tab refusing writes"
```

---

## Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md` — §4 tree, §5 contract table, §8 gates
- Modify: `CHANGELOG.md` — `[Unreleased]`
- Modify: `ROADMAP.md` — tick Movement I branch 4

**Interfaces:**
- Consumes: the completed behavior.
- Produces: nothing code-facing.

- [ ] **Step 1: CLAUDE.md §4 — the project tree**

Add to the `crates/` list, after the `snapshots/` line:

```
    │   └── mergemd/           # line-based 3-way merge + conflict filenames (§3, ROADMAP I.4)
```

Add to `commands/`, after `images.rs`:

```
        │   └── sync.rs        # merge_external / write_conflict_copy (§5)
```

Add to `src/`, beside `sanitize.ts`:

```
│   ├── sync.ts                # pure external-change policy (no DOM/IPC)
```

and under `ui/`:

```
│   │   ├── conflictbar.ts     # non-blocking per-tab conflict banner
```

- [ ] **Step 2: CLAUDE.md §5 — the two contract rows**

Add to the command table, after the `restore_snapshot` row:

```markdown
| `merge_external` | `path, base, mine` | `{ outcome, content?, theirs? }` | Reads the file and 3-way merges via `mergemd`. **Never writes.** `content` only for `merged`; `theirs` for every outcome except `unchanged` (ROADMAP I.4) |
| `write_conflict_copy` | `path, content` | `conflict_path` | Park the losing side as `note (conflict <ts>).md` beside the original — **atomic** via `fsatomic`, never overwrites (§3) |
```

Then add this note after the existing blockquote notes in §5:

```markdown
> **External changes: the save path is the guarantee, the watcher is an optimization.**
> `workspace:change` is debounced ~250 ms per path and reconciles **every** tab whose
> file changed, not just the active one. But watchers drop and coalesce events on network
> shares, some FUSE mounts, and a few sync clients — so **every save re-checks disk
> before writing** (`merge_external`, then proceed only on `unchanged`). A tab that has
> diverged blocks save, Save All, and autosave until the user resolves it. Both
> resolutions park the losing side, so no path through the feature discards bytes. The
> old 2-second `isSelfWrite` window is gone: after Toril saves, disk equals the tab's
> `base`, so a self-triggered event returns `unchanged` and stops.
```

- [ ] **Step 3: CLAUDE.md §8 — gates**

Add to the gates list:

```markdown
- **External-change policy:** `tests/sync.test.ts` — outcome→action mapping is total, HTML
  never auto-merges, and a diverged tab is excluded from every write path (§3).
- **Merge core:** `cargo test -p mergemd` — the four outcomes, convergent edits, CRLF
  preservation, conflict-name collisions, and a property test that a clean merge never
  drops a line.
```

- [ ] **Step 4: CHANGELOG.md**

Add under `## [Unreleased]`, in the `### Added` section:

```markdown
- **Sync coexistence** (ROADMAP Movement I.4). Toril now handles a file changing
  underneath it while you have it open — the case that matters when a folder is a live
  Obsidian vault or is synced by iCloud Drive, OneDrive, Dropbox, Syncthing, or git.
  Non-overlapping edits are merged into your buffer automatically and left for you to
  review before saving; overlapping edits raise a non-blocking banner per tab.

  **Whichever way you resolve it, the other version is kept** as
  `note (conflict 2026-07-25 14-32-05).md` beside the original — including when you
  choose to discard it. No path through this feature deletes bytes.

  A diverged file blocks saving, Save All, and autosave until you decide, and **every
  save re-checks the file on disk before writing**, so a change the file watcher missed
  still cannot be overwritten. New `crates/mergemd` (line-based 3-way merge on
  `similar`, with line terminators preserved so a CRLF file does not get rewritten
  end-to-end). Gates: `cargo test -p mergemd` + `tests/sync.test.ts`.
```

- [ ] **Step 5: ROADMAP.md**

Change the Movement I branch-4 checkbox from `- [ ] **4. \`feat/sync-coexistence\`**` to `- [x] **4. \`feat/sync-coexistence\`**`, and update the `▶ Pick up at` line in the §1 status block to point at Movement I branch 5, `feat/release-readiness`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm typecheck && cd src-tauri && cargo test --workspace && cargo fmt --all --check`
Expected: all green.

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs: record sync coexistence in the contract, gates and changelog"
```

---

## Task 14: On-device verification

**Files:** none — this is the verification CI structurally cannot do.

- [ ] **Step 1: Launch the app**

Run: `pnpm tauri dev`

Use a scratch folder, **not** a real vault.

- [ ] **Step 2: Non-overlapping edits merge**

1. Create `note.md` with ten numbered lines. Open it in Toril.
2. Edit line 1 in Toril. Do not save.
3. In another editor, edit line 10 and save.
4. Expect: within ~250 ms, a status message *"Merged external changes into note.md — review and save"*, both edits present in the buffer, tab still dirty.
5. Save. Diff the file: both edits present, nothing else changed.

- [ ] **Step 3: Overlapping edits park the losing side**

1. Same file. Edit line 5 in Toril, do not save.
2. Edit line 5 differently in the other editor and save.
3. Expect the banner, not a merge.
4. Click **Keep mine**. Expect a `note (conflict …).md` appearing beside it containing the *other* editor's version, the banner clearing, and your buffer still dirty with your text.
5. Repeat and click **Use theirs**. Expect a conflict copy containing *your* text, and the buffer reloading to theirs.

- [ ] **Step 4: The pre-save check catches what the watcher missed**

1. Open a note, edit it, do not save.
2. Stop the watcher's ability to notify by editing the file on a **network share or a synced folder** if you have one; otherwise this step is best-effort.
3. Save. Expect the banner rather than a silent overwrite.

- [ ] **Step 5: Bursts do not spam the banner**

With a sync client running, touch the open file repeatedly (`touch note.md` several times in a second). Expect at most one reconcile per burst and no flicker.

- [ ] **Step 6: External deletion keeps the buffer**

Delete the open file from outside Toril. Expect *"was removed on disk — save to recreate it"*, the buffer intact, and Save recreating the file.

- [ ] **Step 7: Record the outcome**

Add what you verified — and anything you could not — to the PR description. If a step could not be run, say so explicitly rather than leaving it implied.

---

## Definition of Done

- `crates/mergemd` exists, is in the workspace, in the app's deps, and in CI's crate list.
- `cargo test -p mergemd` green, including the no-content-loss property test.
- `merge_external` and `write_conflict_copy` registered and documented in CLAUDE.md §5.
- `base` and `diverged` are tab state; `base` is updated on open, save, Save As, reload, merge, resolution, and history restore.
- `isSelfWrite`, `recordSelfWrite`, and the `selfWrites` map are gone.
- Save, Save All, and autosave all refuse a diverged tab; save re-checks disk first.
- Both resolutions park the losing side, and a failed park aborts the resolution.
- External deletion keeps the buffer.
- `pnpm test`, `pnpm typecheck`, `cargo test --workspace`, `cargo fmt --all --check` all green.
- Docs updated (CLAUDE.md §4/§5/§8, CHANGELOG, ROADMAP tick).
- On-device verification performed, or explicitly recorded as outstanding.
