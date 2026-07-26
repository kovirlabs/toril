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

use similar::{Algorithm, DiffOp, capture_diff_slices};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One side's edit, expressed in **base line coordinates**: base lines
/// `[base_start, base_end)` are replaced by `lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Change {
    base_start: usize,
    base_end: usize,
    lines: Vec<String>,
}

/// Project a diff of `base → other` into base-coordinate changes.
///
/// Positions are derived from a **running cursor**, advanced by list order —
/// never from a `DiffOp`'s own `old_index` field. `capture_diff_slices` can
/// emit an `Insert` whose `old_index` is stale: e.g. `base = ["a\n","b\n"]`,
/// `other = ["b\n","b\n","a\n"]` produces
/// `[Delete{old_index:0,old_len:1}, Equal{old_index:1,len:1},
/// Insert{old_index:1,new_len:2}]` — the `Insert` reports `old_index: 1`,
/// the *start* of the `Equal` that precedes it in the list and consumes
/// `base[1..2]`, not the position after it. Trusting that field anchors the
/// insert before the kept line instead of after it, scrambling the output
/// even though the two surviving (non-`Equal`) changes never numerically
/// overlap — so a sort-and-check over the filtered list can't see this; the
/// information was in the dropped `Equal`. A cursor that only advances via
/// each op's own `old_len`, replayed in the list's own order, doesn't have
/// that blind spot: it is exactly the position "how much of `base` has this
/// op list consumed so far", which is what an `Insert` is anchored to.
fn changes(base: &[&str], other: &[&str]) -> Option<Vec<Change>> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for op in capture_diff_slices(Algorithm::Myers, base, other) {
        match op {
            DiffOp::Equal { len, .. } => {
                cursor += len;
            }
            DiffOp::Delete { old_len, .. } => {
                out.push(Change {
                    base_start: cursor,
                    base_end: cursor + old_len,
                    lines: Vec::new(),
                });
                cursor += old_len;
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                out.push(Change {
                    base_start: cursor,
                    base_end: cursor,
                    lines: other[new_index..new_index + new_len]
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                });
            }
            DiffOp::Replace {
                old_len,
                new_index,
                new_len,
                ..
            } => {
                out.push(Change {
                    base_start: cursor,
                    base_end: cursor + old_len,
                    lines: other[new_index..new_index + new_len]
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                });
                cursor += old_len;
            }
        }
    }
    // Defense in depth: a cursor that only ever advances makes `out` already
    // non-decreasing by construction, so this should be a no-op. Keep it as
    // a structural check anyway — if some future op variant or algorithm
    // change breaks that invariant, fail closed instead of emitting a
    // scramble.
    out.sort_by_key(|c| (c.base_start, c.base_end));
    for pair in out.windows(2) {
        if pair[1].base_start < pair[0].base_end {
            return None;
        }
    }
    Some(out)
}

/// Do two changes touch the same region?
///
/// Half-open ranges, so a change ending exactly where another begins is
/// adjacent, not overlapping — those stay independent. Zero-width insertions
/// need their own cases: an insert at `x` lies inside `[s, e)` when `s <= x < e`
/// (at `e` it appends after the region, which is independent), and two inserts
/// collide only at the same point.
fn overlaps(a: &Change, b: &Change) -> bool {
    let a_empty = a.base_start == a.base_end;
    let b_empty = b.base_start == b.base_end;
    match (a_empty, b_empty) {
        (true, true) => a.base_start == b.base_start,
        (true, false) => b.base_start <= a.base_start && a.base_start < b.base_end,
        (false, true) => a.base_start <= b.base_start && b.base_start < a.base_end,
        (false, false) => a.base_start < b.base_end && b.base_start < a.base_end,
    }
}

/// Render one side's version of base lines `[start, end)`, applying that side's
/// changes. Lines are concatenated verbatim so each keeps its own terminator.
fn render(base: &[&str], side: &[Change], start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut pos = start;
    for c in side {
        while pos < c.base_start {
            out.push_str(base[pos]);
            pos += 1;
        }
        for line in &c.lines {
            out.push_str(line);
        }
        pos = c.base_end.max(pos);
    }
    while pos < end {
        out.push_str(base[pos]);
        pos += 1;
    }
    out
}

/// Three-way merge. Never panics; never returns partial content.
///
/// Diffs `base → mine` and `base → theirs`, then clusters the two change
/// lists: overlapping changes (from either side, possibly chained
/// transitively) are grouped and decided together — identical renderings
/// merge, differing renderings conflict. Non-overlapping changes are taken
/// straight from whichever side made them.
pub fn merge3(base: &str, mine: &str, theirs: &str) -> Divergence {
    if theirs == base {
        return Divergence::Unchanged;
    }
    if mine == base {
        return Divergence::TheirsOnly;
    }

    let base_lines = split_lines(base);
    let (Some(mine_changes), Some(theirs_changes)) = (
        changes(&base_lines, &split_lines(mine)),
        changes(&base_lines, &split_lines(theirs)),
    ) else {
        return Divergence::Conflict;
    };

    let mut out = String::new();
    let mut pos = 0usize; // how much of base has been emitted, in base lines
    let mut i = 0usize; // index into mine_changes
    let mut j = 0usize; // index into theirs_changes

    loop {
        // Seed the next cluster with whichever side's next unconsumed change
        // starts first (ties go to mine; if the other side's next change
        // starts at the same point, the growth loop below absorbs it too).
        let (mut envelope, mut mi, mut tj);
        match (mine_changes.get(i), theirs_changes.get(j)) {
            (Some(m), Some(t)) if m.base_start <= t.base_start => {
                envelope = m.clone();
                mi = i + 1;
                tj = j;
            }
            (Some(_), Some(t)) => {
                envelope = t.clone();
                mi = i;
                tj = j + 1;
            }
            (Some(m), None) => {
                envelope = m.clone();
                mi = i + 1;
                tj = j;
            }
            (None, Some(t)) => {
                envelope = t.clone();
                mi = i;
                tj = j + 1;
            }
            (None, None) => break,
        }

        // Flush unchanged base lines up to the cluster's start.
        while pos < envelope.base_start {
            // A line without a terminator can only be the last line of a
            // file. Appending after one would fuse it with what follows,
            // producing a line neither input wrote — refuse instead.
            if !out.is_empty() && !out.ends_with('\n') {
                return Divergence::Conflict;
            }
            out.push_str(base_lines[pos]);
            pos += 1;
        }

        // Grow the cluster: absorb any change from either side that overlaps
        // the envelope accumulated so far. This transitively chains — a
        // change that only overlaps something absorbed on a later pass still
        // gets pulled in, because we keep looping until a full pass absorbs
        // nothing.
        loop {
            let mut grew = false;
            if let Some(m) = mine_changes.get(mi)
                && overlaps(m, &envelope)
            {
                envelope.base_start = envelope.base_start.min(m.base_start);
                envelope.base_end = envelope.base_end.max(m.base_end);
                mi += 1;
                grew = true;
            }
            if let Some(t) = theirs_changes.get(tj)
                && overlaps(t, &envelope)
            {
                envelope.base_start = envelope.base_start.min(t.base_start);
                envelope.base_end = envelope.base_end.max(t.base_end);
                tj += 1;
                grew = true;
            }
            if !grew {
                break;
            }
        }

        // Invariant: a cluster may never begin behind the cursor. If it does,
        // content would be emitted out of order — the failure mode that has
        // already produced two silent-corruption bugs here. Fail closed: a
        // Conflict writes nothing, so an unenumerated case costs the user a
        // prompt rather than a mangled file.
        if envelope.base_start < pos {
            return Divergence::Conflict;
        }

        let mine_touched = mi > i;
        let theirs_touched = tj > j;
        match (mine_touched, theirs_touched) {
            (true, true) => {
                // Both sides touched this region. Identical renderings are a
                // convergent edit and are taken once; anything else is a
                // genuine conflict — we do not guess.
                let a = render(
                    &base_lines,
                    &mine_changes[i..mi],
                    envelope.base_start,
                    envelope.base_end,
                );
                let b = render(
                    &base_lines,
                    &theirs_changes[j..tj],
                    envelope.base_start,
                    envelope.base_end,
                );
                if a != b {
                    return Divergence::Conflict;
                }
                if !out.is_empty() && !out.ends_with('\n') {
                    return Divergence::Conflict;
                }
                out.push_str(&a);
            }
            (true, false) => {
                if !out.is_empty() && !out.ends_with('\n') {
                    return Divergence::Conflict;
                }
                out.push_str(&render(
                    &base_lines,
                    &mine_changes[i..mi],
                    envelope.base_start,
                    envelope.base_end,
                ));
            }
            (false, true) => {
                if !out.is_empty() && !out.ends_with('\n') {
                    return Divergence::Conflict;
                }
                out.push_str(&render(
                    &base_lines,
                    &theirs_changes[j..tj],
                    envelope.base_start,
                    envelope.base_end,
                ));
            }
            (false, false) => {
                // Unreachable: the seed above always advances `mi` or `tj`
                // immediately. Kept as a safe bail rather than an
                // `unreachable!()` so a future refactor that breaks that
                // invariant fails a test instead of panicking.
                return Divergence::Conflict;
            }
        }

        i = mi;
        j = tj;
        pos = envelope.base_end.max(pos);
    }

    while pos < base_lines.len() {
        if !out.is_empty() && !out.ends_with('\n') {
            return Divergence::Conflict;
        }
        out.push_str(base_lines[pos]);
        pos += 1;
    }

    Divergence::Merged(out)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

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

    #[test]
    fn a_change_engulfing_the_other_sides_change_conflicts() {
        // The regression this fix exists for: theirs inserts INSIDE the range
        // mine replaced. Previously returned Merged("X\nNEW\n") — silent
        // corruption in the only outcome that overwrites the user's file.
        let base = "a\nb\nc\nd\ne\n";
        let mine = "X\n";
        let theirs = "a\nb\nNEW\nc\nd\ne\n";
        assert_eq!(merge3(base, mine, theirs), Divergence::Conflict);
        // symmetric
        assert_eq!(merge3(base, theirs, mine), Divergence::Conflict);
    }

    #[test]
    fn adjacent_changes_stay_independent() {
        // mine deletes line b [1,2); theirs rewrites line c [2,3). Touching
        // ranges, but disjoint — this must still merge.
        let base = "a\nb\nc\n";
        let mine = "a\nc\n";
        let theirs = "a\nb\nc CHANGED\n";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("a\nc CHANGED\n".to_string())
        );
    }

    #[test]
    fn an_insert_at_the_head_of_a_replaced_range_conflicts() {
        // Regression: theirs prepends, mine replaces the whole file. Previously
        // Merged("M\nZ\n") — Z was written before the content and emitted after.
        let base = "a\nb\nc\n";
        let mine = "M\n";
        let theirs = "Z\na\nb\nc\n";
        assert_eq!(merge3(base, mine, theirs), Divergence::Conflict);
        assert_eq!(merge3(base, theirs, mine), Divergence::Conflict);
    }

    #[test]
    fn an_append_after_a_replaced_range_still_merges() {
        // The control for the asymmetry above: an insert at the END boundary is
        // appending after the region, which is independent and must still merge.
        // If this regresses to Conflict, `overlaps` has been made too eager.
        let base = "a\nb\nc\n";
        let mine = "M\n";
        let theirs = "a\nb\nc\nZ\n";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("M\nZ\n".to_string())
        );
    }

    #[test]
    fn an_identical_edit_is_never_scrambled() {
        // Regression: diff ops came back out of base order and the projection
        // reordered content. Both sides made the SAME edit — the only correct
        // answers are that edit, or Conflict. Never a permutation of it.
        let base = "a\nb\n";
        let same = "b\nb\na\n";
        match merge3(base, same, same) {
            Divergence::Merged(text) => assert_eq!(text, same),
            Divergence::Conflict => {}
            other => panic!("expected Merged(same) or Conflict, got {other:?}"),
        }
    }

    #[test]
    fn an_unterminated_last_line_never_fuses_with_the_other_side() {
        // Regression: produced "a\nb\ncd\n" — the line "cd" exists in neither
        // input. Conflict is the only safe answer here.
        let base = "a\nb\nc\n";
        let mine = "a\nb\nc";
        let theirs = "a\nb\nc\nd\n";
        assert_eq!(merge3(base, mine, theirs), Divergence::Conflict);
        assert_eq!(merge3(base, theirs, mine), Divergence::Conflict);
    }

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
    fn an_unterminated_final_line_is_still_allowed_to_merge() {
        // The control for the asymmetry: ending without a terminator is fine.
        // Only appending AFTER an unterminated line is forbidden.
        let base = "a\nb";
        let mine = "a CHANGED\nb";
        let theirs = "a\nb CHANGED";
        assert_eq!(
            merge3(base, mine, theirs),
            Divergence::Merged("a CHANGED\nb CHANGED".to_string())
        );
    }

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

        assert!(
            p.parent() == original.parent(),
            "must sit beside the original"
        );
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

    /// Deterministic pseudo-random generator so a failure is reproducible from
    /// the seed alone. Avoids a proptest dependency for one property (§2).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
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
                // `v.len()` is deliberately in range here: an insert must be able
                // to land AFTER the last line. Without that, no generated case
                // ever appends past an unterminated final line, so the fusion
                // class stays unreachable and this property cannot see it.
                1 => v.insert(rng.pick(v.len() + 1), format!("{tag}-ins\n")),
                _ => {
                    v.remove(at);
                }
            }
        }
        let mut s = v.concat();
        // One document in four loses its trailing terminator. Without this the
        // generator cannot produce an unterminated final line, so the fusion class
        // that shape enables — a line glued from two sides, present in neither —
        // would go untested by this property and rest on one regression alone.
        if rng.pick(4) == 0 && s.ends_with('\n') {
            s.pop();
            if s.ends_with('\r') {
                s.pop();
            }
        }
        s
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
                    let base_l = split_lines(&base);
                    let mine_l = split_lines(&mine);
                    let theirs_l = split_lines(&theirs);
                    let out_l = split_lines(&out);

                    // 1. No fabricated lines. Every output line must be a WHOLE
                    //    line from one of the three inputs. This is what catches
                    //    fusion: a line glued from two others belongs to none of
                    //    them, where a substring check would have accepted it.
                    for line in &out_l {
                        assert!(
                            base_l.contains(line)
                                || mine_l.contains(line)
                                || theirs_l.contains(line),
                            "case {case}: output contains a line present in no input\n\
                             line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                        );
                    }

                    // 2. Nothing either side introduced was dropped — compared as
                    //    whole lines, not substrings.
                    for line in mine_l.iter().filter(|l| !base_l.contains(l)) {
                        assert!(
                            out_l.contains(line),
                            "case {case}: merged output dropped a line of MINE\n\
                             line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                        );
                    }
                    for line in theirs_l.iter().filter(|l| !base_l.contains(l)) {
                        assert!(
                            out_l.contains(line),
                            "case {case}: merged output dropped a line of THEIRS\n\
                             line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                        );
                    }

                    // 3. A base line neither side deleted must still be there.
                    for line in base_l
                        .iter()
                        .filter(|l| mine_l.contains(l) && theirs_l.contains(l))
                    {
                        assert!(
                            out_l.contains(line),
                            "case {case}: merged output dropped a base line both sides kept\n\
                             line: {line:?}\nmine: {mine:?}\ntheirs: {theirs:?}\nout: {out:?}"
                        );
                    }
                }
            }
        }
    }
}
