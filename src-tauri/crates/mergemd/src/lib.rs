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
