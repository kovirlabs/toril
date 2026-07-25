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

/// Do two changes touch the same region? Half-open ranges, so a change ending
/// exactly where another begins is adjacent, not overlapping — those stay
/// independent. Two pure insertions at the same point are the exception: they
/// occupy no base lines but still collide.
fn overlaps(a: &Change, b: &Change) -> bool {
    let a_empty = a.base_start == a.base_end;
    let b_empty = b.base_start == b.base_end;
    if a_empty && b_empty {
        return a.base_start == b.base_start;
    }
    a.base_start < b.base_end && b.base_start < a.base_end
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
    let mine_changes = changes(&base_lines, &split_lines(mine));
    let theirs_changes = changes(&base_lines, &split_lines(theirs));

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
                out.push_str(&a);
            }
            (true, false) => out.push_str(&render(
                &base_lines,
                &mine_changes[i..mi],
                envelope.base_start,
                envelope.base_end,
            )),
            (false, true) => out.push_str(&render(
                &base_lines,
                &theirs_changes[j..tj],
                envelope.base_start,
                envelope.base_end,
            )),
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
        out.push_str(base_lines[pos]);
        pos += 1;
    }

    Divergence::Merged(out)
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
}
