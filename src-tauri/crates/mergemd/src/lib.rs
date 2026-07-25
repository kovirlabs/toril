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
}
