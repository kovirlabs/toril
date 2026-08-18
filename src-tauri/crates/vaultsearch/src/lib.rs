//! Full-text search across a Toril workspace (ROADMAP Movement II.6,
//! `feat/vault-search`).
//!
//! **The index lives in memory and nowhere else.** That is the whole design, and
//! it is a §3 decision rather than a performance one. A persistent index is a
//! second copy of the user's notes: it can drift from the vault, it can be
//! corrupted, it has to be invalidated, and it has to live somewhere — every one
//! of those is a new way for a notes app to tell you something untrue about your
//! own writing. Holding the text in RAM and rebuilding it from the vault leaves
//! the files on disk as the only source of truth, which is the same instinct that
//! put `history/` outside the vault and made snapshots additive.
//!
//! The scale says we can afford it. A personal vault is hundreds to a few
//! thousand notes — single-digit megabytes of text — and Toril already reads the
//! whole tree to draw the sidebar. Scanning that much text per query is
//! milliseconds, so there is no index structure here at all: just the documents
//! and a regex. If a vault ever arrives that this cannot hold, the answer is a
//! real inverted index, not a cache of this one.
//!
//! What is here:
//!
//! - [`Index`] — the documents, and [`Index::search`] over them.
//! - [`Index::load`] — build one by walking a vault.
//! - [`Index::upsert_from_disk`] / [`Index::remove`] — what a watcher event calls.
//!
//! **What counts as a note is `vaultscan`'s decision, not ours.** The walk goes
//! through [`vaultscan::scan`] so the index contains exactly what the sidebar
//! shows. That is not merely tidy: `vaultscan` skips hidden directories, which is
//! what keeps `.trash/` out of the results. A search that surfaced notes the user
//! had already deleted — and offered to open them — would be its own small
//! betrayal.
//!
//! No Tauri dependency: pure `std` + `regex` + `vaultscan`, fully unit-tested.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use regex::{Regex, RegexBuilder};
use serde::Serialize;

/// Largest file the index will hold.
///
/// A note is prose; anything past this is a log, a dump, or a generated file that
/// happened to land in the vault, and reading a hundred of them would cost more
/// memory than the rest of the vault combined. Skipped files are *reported*
/// ([`Index::skipped`]) rather than silently dropped — a search that quietly
/// ignores a file is worse than one that says it did.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// How much of a matching line is returned, in characters.
///
/// A minified file or a base64 data URI is one line thousands of characters long;
/// sending it to the webview to render a single row is waste. Clipped lines say
/// so ([`LineMatch::clipped_start`] / [`LineMatch::clipped_end`]).
pub const MAX_LINE_CHARS: usize = 240;

/// Default cap on files returned by one search.
pub const DEFAULT_MAX_FILES: usize = 200;

/// Default cap on matching lines returned per file.
pub const DEFAULT_MAX_MATCHES_PER_FILE: usize = 50;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// What to look for, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// The text to find. Empty means "no query" — [`Index::search`] returns
    /// nothing rather than everything, because matching every line of every note
    /// is never what an empty search box meant.
    pub text: String,
    /// Match case exactly. Off by default: the common case is not knowing.
    pub case_sensitive: bool,
    /// Require word boundaries either side, so `cat` misses `concatenate`.
    pub whole_word: bool,
    /// Treat [`Query::text`] as a regular expression rather than literal text.
    pub regex: bool,
    /// Most files to return.
    pub max_files: usize,
    /// Most matching lines to return per file.
    pub max_matches_per_file: usize,
}

impl Query {
    /// A literal, case-insensitive search with the default caps.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            max_files: DEFAULT_MAX_FILES,
            max_matches_per_file: DEFAULT_MAX_MATCHES_PER_FILE,
        }
    }

    /// Compile this query to the pattern that actually runs.
    ///
    /// A literal query is escaped, so a user searching for `a.b` or `C++` gets
    /// what they typed rather than a regex that happens to parse. Word boundaries
    /// wrap the whole pattern in a non-capturing group first — `\bfoo|bar\b`
    /// binds the alternation the wrong way round, and that would be a silently
    /// wrong result rather than an error.
    fn compile(&self) -> Result<Regex, QueryError> {
        let body = if self.regex {
            self.text.clone()
        } else {
            regex::escape(&self.text)
        };
        let pattern = if self.whole_word {
            format!(r"\b(?:{body})\b")
        } else {
            body
        };
        RegexBuilder::new(&pattern)
            .case_insensitive(!self.case_sensitive)
            // Find-in-files is line-oriented, so `^` and `$` anchor to a line
            // rather than to the whole note. Without this, `^TODO:` finds the one
            // at the top of a file and silently misses every other one — an
            // answer that looks like a working search and isn't.
            .multi_line(true)
            // A vault is the user's, not an attacker's, but the pattern comes
            // from the webview and the webview is untrusted (§3.3). A size limit
            // turns a pathological pattern into an error message instead of a
            // frozen window.
            .size_limit(1 << 20)
            .build()
            .map_err(|e| QueryError::Pattern(e.to_string()))
    }
}

/// Why a query could not run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryError {
    /// The pattern did not compile. Carries the message to show the user — a
    /// half-typed regex is the normal case here, not an exceptional one.
    Pattern(String),
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::Pattern(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for QueryError {}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// One run of text within a matching line, flagged as matched or not.
///
/// Offsets are deliberately **not** part of this API. Rust counts bytes, JS
/// counts UTF-16 code units, and every offset crossing the IPC boundary is a
/// chance to highlight half an emoji. Pre-split runs cannot be mis-indexed by the
/// caller, because there is nothing to index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Segment {
    pub text: String,
    pub matched: bool,
}

/// A line containing at least one match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based, the way every editor counts.
    pub line: u32,
    /// The line, split into matched and unmatched runs. Concatenating the
    /// segments reproduces the (possibly clipped) line exactly.
    pub segments: Vec<Segment>,
    /// Text was removed from the front to fit [`MAX_LINE_CHARS`].
    pub clipped_start: bool,
    /// Text was removed from the end to fit [`MAX_LINE_CHARS`].
    pub clipped_end: bool,
}

/// Every match in one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// File name including extension — what the results list shows.
    pub name: String,
    pub matches: Vec<LineMatch>,
    /// Matches in the file, counted before [`Query::max_matches_per_file`].
    pub total_matches: usize,
    /// The file had more matching lines than were returned.
    pub truncated: bool,
    /// The query also matched the file's own name.
    pub name_match: bool,
}

/// The answer to one search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileHit>,
    /// Files with at least one match, counted before [`Query::max_files`].
    pub total_files: usize,
    /// Matches across the whole vault, counted before either cap.
    pub total_matches: usize,
    /// More files matched than were returned.
    pub truncated: bool,
}

/// A file the index deliberately holds no text for, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedFile {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// Larger than [`MAX_FILE_BYTES`].
    TooLarge,
    /// Not valid UTF-8. Toril reads and writes UTF-8; a file that isn't cannot be
    /// opened in the editor either, so finding text in it would be a promise the
    /// rest of the app can't keep.
    NotUtf8,
    /// The read itself failed — a permission, a vanished file, a broken link.
    Unreadable,
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/// The vault's text, held in memory.
#[derive(Debug, Default)]
pub struct Index {
    /// The folder this index covers, when it was built from one. Every read from
    /// disk is confined to it — see [`Index::upsert_from_disk`].
    root: Option<PathBuf>,
    docs: BTreeMap<PathBuf, String>,
    skipped: Vec<SkippedFile>,
}

impl Index {
    /// An empty index bound to no folder.
    ///
    /// **It will not read a file.** Every disk-reading method fails closed until
    /// there is a root to confine it to, so the state an app holds before a folder
    /// is open cannot be talked into reading one.
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty index bound to `root`, without walking it yet.
    pub fn rooted(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Some(root.into()),
            ..Self::default()
        }
    }

    /// Build an index by walking `root`.
    ///
    /// Which files are eligible is [`vaultscan::scan`]'s answer, so the index and
    /// the sidebar can never disagree about what is in the vault. An unreadable
    /// *file* is recorded and skipped; only an unreadable *root* is an error,
    /// because that is the difference between "one note is odd" and "there is no
    /// vault here".
    pub fn load(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref();
        let mut index = Self::rooted(root);
        index.index_tree(root)?;
        Ok(index)
    }

    /// The folder this index covers, if any.
    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// Read every note at or under `dir` into the index.
    ///
    /// This is what a *folder* appearing means — a new directory, or the landing
    /// half of a folder rename, which the watcher reports as one event that names
    /// the folder and nothing inside it.
    pub fn index_tree(&mut self, dir: impl AsRef<Path>) -> io::Result<usize> {
        let dir = dir.as_ref();
        if !self.contains(dir) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "path is outside the indexed folder",
            ));
        }
        let tree = vaultscan::scan(dir)?;
        let mut paths = Vec::new();
        collect_files(&tree, &mut paths);
        let mut added = 0usize;
        for path in paths {
            if self.upsert_from_disk(&path) {
                added += 1;
            }
        }
        Ok(added)
    }

    /// Whether `path` is inside this index's folder, and so may be read.
    ///
    /// The webview supplies the paths that watcher updates carry, and the webview
    /// is untrusted (§3.3). Without this, a crafted call could pull any file on
    /// the machine into the index and then read it back out through a search —
    /// which is a file-disclosure hole wearing a search feature as a disguise.
    ///
    /// Resolved with `canonicalize` so a symlink or a `..` cannot walk out. The
    /// resolved form is used **only** for this comparison and never stored:
    /// on Windows it is a `\\?\C:\…` path, which matches neither the sidebar tree
    /// nor an open tab — the same trap `fileops` documents.
    fn contains(&self, path: &Path) -> bool {
        // No root, no reading. An index that has not been pointed at a folder is
        // the state the app holds before one is open, and it must not be
        // talkable into reading a file that no vault contains.
        let Some(root) = &self.root else {
            return false;
        };
        // The root is trivially inside itself, and saying so without touching the
        // disk keeps a missing folder reporting "not found" rather than the
        // containment refusal that a failed `canonicalize` would produce.
        if path == root {
            return true;
        }
        match (root.canonicalize(), path.canonicalize()) {
            (Ok(root), Ok(path)) => path.starts_with(root),
            _ => false,
        }
    }

    /// Put `content` in the index under `path`, replacing anything there.
    pub fn insert(&mut self, path: impl Into<PathBuf>, content: impl Into<String>) {
        let path = path.into();
        self.skipped.retain(|s| Path::new(&s.path) != path);
        self.docs.insert(path, content.into());
    }

    /// Re-read one file from disk — what a watcher create/modify calls.
    ///
    /// Returns whether the file is now searchable. A file that is too large or
    /// not UTF-8 is *removed* from the index and recorded in [`Index::skipped`]:
    /// whatever was held for it is no longer what is on disk, and stale text is a
    /// worse answer than no text.
    pub fn upsert_from_disk(&mut self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        if !self.contains(path) {
            return false;
        }
        match read_note(path) {
            Ok(content) => {
                self.insert(path.to_path_buf(), content);
                true
            }
            Err(reason) => {
                self.remove(path);
                self.skipped.push(SkippedFile {
                    path: path.to_string_lossy().into_owned(),
                    reason,
                });
                false
            }
        }
    }

    /// Drop one file — what a watcher remove calls, and what a rename calls for
    /// the old path.
    pub fn remove(&mut self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        self.skipped.retain(|s| Path::new(&s.path) != path);
        self.docs.remove(path).is_some()
    }

    /// Drop every file at or under `dir` — a folder rename or delete, which the
    /// watcher reports without enumerating what was inside it.
    pub fn remove_subtree(&mut self, dir: impl AsRef<Path>) -> usize {
        let dir = dir.as_ref();
        let gone: Vec<PathBuf> = self
            .docs
            .keys()
            .filter(|p| p.starts_with(dir))
            .cloned()
            .collect();
        for path in &gone {
            self.docs.remove(path);
        }
        self.skipped
            .retain(|s| !Path::new(&s.path).starts_with(dir));
        gone.len()
    }

    /// Files held.
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// Bytes of note text held — what the in-memory decision actually costs, so a
    /// caller can report it rather than guess.
    pub fn bytes(&self) -> usize {
        self.docs.values().map(|c| c.len()).sum()
    }

    /// Files the index deliberately holds no text for.
    pub fn skipped(&self) -> &[SkippedFile] {
        &self.skipped
    }

    /// Search every note.
    ///
    /// Ranking is deterministic and explainable, in this order: a file whose
    /// *name* matches comes first (you were probably looking for the note, not
    /// the sentence), then more matches before fewer, then path order. Nothing is
    /// scored — there is no relevance model to disagree with, which is the point.
    /// A find-in-files result the user cannot predict is one they cannot trust.
    pub fn search(&self, query: &Query) -> Result<SearchResults, QueryError> {
        if query.text.is_empty() {
            return Ok(SearchResults {
                files: Vec::new(),
                total_files: 0,
                total_matches: 0,
                truncated: false,
            });
        }
        let re = query.compile()?;

        let mut files: Vec<FileHit> = Vec::new();
        let mut total_matches = 0usize;

        for (path, content) in &self.docs {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Some(hit) = search_one(&re, path, &name, content, query.max_matches_per_file) {
                total_matches += hit.total_matches;
                files.push(hit);
            }
        }

        let total_files = files.len();
        files.sort_by(|a, b| {
            b.name_match
                .cmp(&a.name_match)
                .then_with(|| b.total_matches.cmp(&a.total_matches))
                .then_with(|| a.path.cmp(&b.path))
        });
        let truncated = total_files > query.max_files;
        files.truncate(query.max_files);

        Ok(SearchResults {
            files,
            total_files,
            total_matches,
            truncated,
        })
    }
}

/// Read one note, or say why it can't be read.
fn read_note(path: &Path) -> Result<String, SkipReason> {
    let meta = fs::metadata(path).map_err(|_| SkipReason::Unreadable)?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(SkipReason::TooLarge);
    }
    let bytes = fs::read(path).map_err(|_| SkipReason::Unreadable)?;
    String::from_utf8(bytes).map_err(|_| SkipReason::NotUtf8)
}

/// Flatten a `vaultscan` tree to the files in it.
fn collect_files(nodes: &[vaultscan::FileNode], out: &mut Vec<PathBuf>) {
    for node in nodes {
        if node.is_dir {
            collect_files(&node.children, out);
        } else {
            out.push(PathBuf::from(&node.path));
        }
    }
}

/// Every match in one document, or `None` if there were none.
fn search_one(
    re: &Regex,
    path: &Path,
    name: &str,
    content: &str,
    max_matches: usize,
) -> Option<FileHit> {
    let mut matches: Vec<LineMatch> = Vec::new();
    let mut total = 0usize;
    let mut matched_lines = 0usize;

    // Matches arrive in increasing offset order, so the line number is carried
    // forward rather than recounted from the start of the file for each one.
    let mut line_no: u32 = 1;
    let mut scanned = 0usize; // bytes already counted into `line_no`
    let mut current: Option<PendingLine> = None;

    for m in re.find_iter(content) {
        // An empty match (`a*` against text containing no `a`) would report a hit
        // at every position in the file. It is never what the user meant, and it
        // would drown the result list in blank rows.
        if m.start() == m.end() {
            continue;
        }
        total += 1;

        line_no += count_newlines(&content[scanned..m.start()]);
        scanned = m.start();

        let (start, end) = line_bounds(content, m.start());
        // A match running past the end of its line (a pattern spanning a newline)
        // is reported on the line it started, highlighted to the line end.
        // Splitting it across rows would claim matches on lines that hold only
        // the tail.
        let hl_end = m.end().min(end);

        match &mut current {
            Some(pending) if pending.start == start => pending.spans.push((m.start(), hl_end)),
            _ => {
                if let Some(done) = current.take() {
                    matched_lines += 1;
                    if matches.len() < max_matches {
                        matches.push(finish_line(content, done));
                    }
                }
                current = Some(PendingLine {
                    line: line_no,
                    start,
                    end,
                    spans: vec![(m.start(), hl_end)],
                });
            }
        }
    }
    if let Some(done) = current.take() {
        matched_lines += 1;
        if matches.len() < max_matches {
            matches.push(finish_line(content, done));
        }
    }

    // A note whose *name* matches is a hit even when its text does not. That is
    // usually the note the user was reaching for — and without it the name-first
    // ranking would be decoration, since a file could only ever rank by a name it
    // had already had to match on content to appear at all.
    // `is_match` would be the obvious call, and it is wrong here for the same
    // reason the loop above skips zero-width hits: a pattern that can match
    // nothing matches every name in the vault, and every note becomes a result.
    let name_match = re.find(name).is_some_and(|m| m.start() != m.end());
    if total == 0 && !name_match {
        return None;
    }
    Some(FileHit {
        path: path.to_string_lossy().into_owned(),
        name: name.to_string(),
        truncated: matched_lines > matches.len(),
        total_matches: total,
        name_match,
        matches,
    })
}

/// One line's matches, accumulated while its spans are still arriving.
struct PendingLine {
    line: u32,
    /// Byte offset of the line's first character.
    start: usize,
    /// Byte offset just past the line's last character.
    end: usize,
    spans: Vec<(usize, usize)>,
}

fn count_newlines(s: &str) -> u32 {
    s.bytes().filter(|b| *b == b'\n').count() as u32
}

/// Byte range of the line containing `offset`, excluding the newline itself.
fn line_bounds(content: &str, offset: usize) -> (usize, usize) {
    let start = content[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = content[offset..]
        .find('\n')
        .map_or(content.len(), |i| offset + i);
    // A CRLF file leaves the \r at the end of every line. It is not something the
    // user typed, and it renders as a stray box in the results list.
    let end = if end > start && content.as_bytes()[end - 1] == b'\r' {
        end - 1
    } else {
        end
    };
    (start, end)
}

/// Turn one line's collected spans into the segments the caller renders.
fn finish_line(content: &str, pending: PendingLine) -> LineMatch {
    let PendingLine {
        line,
        start,
        end,
        spans,
    } = pending;

    // Clip a long line to a window around its first match, so a minified file
    // does not send a megabyte to the webview to draw one row.
    let first = spans.first().map(|s| s.0).unwrap_or(start);
    let (win_start, win_end, clipped_start, clipped_end) = clip_window(content, start, end, first);

    let mut segments: Vec<Segment> = Vec::new();
    let mut cursor = win_start;
    for (s, e) in spans {
        let s = s.clamp(win_start, win_end);
        let e = e.clamp(win_start, win_end);
        if e <= cursor {
            continue;
        }
        if s > cursor {
            push_segment(&mut segments, &content[cursor..s], false);
        }
        push_segment(&mut segments, &content[s..e], true);
        cursor = e;
    }
    if cursor < win_end {
        push_segment(&mut segments, &content[cursor..win_end], false);
    }

    LineMatch {
        line,
        segments,
        clipped_start,
        clipped_end,
    }
}

fn push_segment(segments: &mut Vec<Segment>, text: &str, matched: bool) {
    if text.is_empty() {
        return;
    }
    // Adjacent runs of the same kind are one run — overlapping spans would
    // otherwise produce a stutter of tiny segments.
    if let Some(last) = segments.last_mut()
        && last.matched == matched
    {
        last.text.push_str(text);
        return;
    }
    segments.push(Segment {
        text: text.to_string(),
        matched,
    });
}

/// The slice of a line to actually return, centred on `focus`.
fn clip_window(
    content: &str,
    start: usize,
    end: usize,
    focus: usize,
) -> (usize, usize, bool, bool) {
    let line = &content[start..end];
    if line.chars().count() <= MAX_LINE_CHARS {
        return (start, end, false, false);
    }
    // Leave a quarter of the window as lead-in, so the match is not flush against
    // the left edge with no context in front of it.
    let lead = MAX_LINE_CHARS / 4;
    let focus_chars = content[start..focus].chars().count();
    let first_char = focus_chars.saturating_sub(lead);
    let win_start = start + char_offset(line, first_char);
    let win_end = start + char_offset(line, first_char + MAX_LINE_CHARS);
    (win_start, win_end, win_start > start, win_end < end)
}

/// Byte offset of the `n`th character of `s`, clamped to its end.
fn char_offset(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Same shape as `vaultscan`'s, plus a counter: these tests build several
    // vaults each and the nanosecond clock is not guaranteed to have moved.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = N.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("vaultsearch-{nanos}-{n}"));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    /// An index over in-memory documents, so the matching tests never touch disk.
    fn index_of(docs: &[(&str, &str)]) -> Index {
        let mut index = Index::new();
        for (path, content) in docs {
            index.insert(PathBuf::from(path), *content);
        }
        index
    }

    /// The full text of a line's segments — what the user would see rendered.
    fn line_text(m: &LineMatch) -> String {
        m.segments.iter().map(|s| s.text.as_str()).collect()
    }

    /// Just the highlighted runs.
    fn highlighted(m: &LineMatch) -> Vec<&str> {
        m.segments
            .iter()
            .filter(|s| s.matched)
            .map(|s| s.text.as_str())
            .collect()
    }

    // -----------------------------------------------------------------
    // What the query means
    // -----------------------------------------------------------------

    #[test]
    fn finds_literal_text_ignoring_case_by_default() {
        let index = index_of(&[("/v/a.md", "The Quick brown fox\nsecond line")]);
        let r = index.search(&Query::new("quick")).unwrap();
        assert_eq!(r.total_files, 1);
        assert_eq!(r.total_matches, 1);
        assert_eq!(r.files[0].matches[0].line, 1);
        assert_eq!(highlighted(&r.files[0].matches[0]), vec!["Quick"]);
    }

    #[test]
    fn case_sensitive_search_respects_case() {
        let index = index_of(&[("/v/a.md", "Quick quick QUICK")]);
        let mut q = Query::new("quick");
        q.case_sensitive = true;
        let r = index.search(&q).unwrap();
        assert_eq!(r.total_matches, 1);
        assert_eq!(highlighted(&r.files[0].matches[0]), vec!["quick"]);
    }

    #[test]
    fn whole_word_does_not_match_inside_a_word() {
        let index = index_of(&[("/v/a.md", "concatenate the cat")]);
        let mut q = Query::new("cat");
        q.whole_word = true;
        assert_eq!(index.search(&q).unwrap().total_matches, 1);

        // ...and without the flag it does.
        assert_eq!(index.search(&Query::new("cat")).unwrap().total_matches, 2);
    }

    #[test]
    fn whole_word_binds_an_alternation_as_a_group() {
        // `\bfoo|bar\b` parses as `(\bfoo)|(bar\b)`, which matches the `bar`
        // inside `sandbar`. The non-capturing group in `compile` is what stops
        // it, and the failure mode is a wrong answer rather than an error — so
        // without a test nothing would ever notice.
        let index = index_of(&[("/v/a.md", "sandbar foobar\nfoo bar")]);
        let mut q = Query::new("foo|bar");
        q.regex = true;
        q.whole_word = true;
        let r = index.search(&q).unwrap();
        assert_eq!(r.total_matches, 2, "only the standalone foo and bar");
        assert_eq!(r.files[0].matches[0].line, 2);
    }

    #[test]
    fn a_literal_query_is_not_a_regex() {
        let index = index_of(&[("/v/a.md", "axb and a.b")]);
        let r = index.search(&Query::new("a.b")).unwrap();
        assert_eq!(r.total_matches, 1, "the dot is a dot, not any-character");
        assert_eq!(highlighted(&r.files[0].matches[0]), vec!["a.b"]);
    }

    #[test]
    fn a_literal_query_that_is_invalid_regex_still_works() {
        // The obvious implementation — hand the text to the regex engine — turns
        // a search for `C++` into a compile error in the user's face.
        let index = index_of(&[("/v/a.md", "written in C++ mostly")]);
        assert_eq!(index.search(&Query::new("C++")).unwrap().total_matches, 1);
    }

    #[test]
    fn regex_mode_runs_the_pattern() {
        let index = index_of(&[("/v/a.md", "TODO: one\nDONE: two\nTODO: three")]);
        let mut q = Query::new("^TODO:");
        q.regex = true;
        let r = index.search(&q).unwrap();
        assert_eq!(r.total_matches, 2);
        assert_eq!(r.files[0].matches[1].line, 3);
    }

    #[test]
    fn an_invalid_pattern_is_an_error_the_user_can_read() {
        let index = index_of(&[("/v/a.md", "anything")]);
        let mut q = Query::new("(unclosed");
        q.regex = true;
        match index.search(&q) {
            Err(QueryError::Pattern(msg)) => assert!(!msg.is_empty()),
            other => panic!("expected a pattern error, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_query_matches_nothing_rather_than_everything() {
        let index = index_of(&[("/v/a.md", "some text"), ("/v/b.md", "more text")]);
        let r = index.search(&Query::new("")).unwrap();
        assert!(r.files.is_empty());
        assert_eq!(r.total_matches, 0);
    }

    #[test]
    fn a_pattern_that_can_match_nothing_does_not_flood_the_results() {
        // `x*` matches the empty string at every position. Left alone that is one
        // hit per byte of the vault, every one of them blank.
        let index = index_of(&[("/v/a.md", "nothing to see")]);
        let mut q = Query::new("x*");
        q.regex = true;
        let r = index.search(&q).unwrap();
        assert_eq!(r.total_matches, 0);
        assert!(r.files.is_empty());
    }

    // -----------------------------------------------------------------
    // What comes back
    // -----------------------------------------------------------------

    #[test]
    fn segments_reproduce_the_line_and_mark_every_match() {
        let index = index_of(&[("/v/a.md", "tea and tea and coffee")]);
        let r = index.search(&Query::new("tea")).unwrap();
        let m = &r.files[0].matches[0];
        assert_eq!(line_text(m), "tea and tea and coffee");
        assert_eq!(highlighted(m), vec!["tea", "tea"]);
        assert_eq!(r.total_matches, 2);
    }

    #[test]
    fn several_matches_on_one_line_are_one_row() {
        let index = index_of(&[("/v/a.md", "a a a\nb\na a")]);
        let r = index.search(&Query::new("a")).unwrap();
        assert_eq!(r.files[0].matches.len(), 2, "two lines, not five rows");
        assert_eq!(r.files[0].total_matches, 5);
        assert_eq!(r.files[0].matches[0].line, 1);
        assert_eq!(r.files[0].matches[1].line, 3);
    }

    #[test]
    fn line_numbers_are_one_based_and_survive_blank_lines() {
        let index = index_of(&[("/v/a.md", "one\n\n\nfour\n\nsix")]);
        let r = index.search(&Query::new("six")).unwrap();
        assert_eq!(r.files[0].matches[0].line, 6);
    }

    #[test]
    fn a_crlf_note_does_not_return_the_carriage_return() {
        // Toril normalizes CRLF on save, but it does not rewrite a file it has
        // only searched — so a Windows-authored vault reaches this code as-is.
        let index = index_of(&[("/v/a.md", "alpha\r\nbeta\r\ngamma")]);
        let r = index.search(&Query::new("beta")).unwrap();
        let m = &r.files[0].matches[0];
        assert_eq!(line_text(m), "beta");
        assert_eq!(m.line, 2);
    }

    #[test]
    fn a_match_spanning_a_newline_stays_on_its_own_line() {
        let index = index_of(&[("/v/a.md", "start\nend")]);
        let mut q = Query::new("start\\nend");
        q.regex = true;
        let r = index.search(&q).unwrap();
        let m = &r.files[0].matches[0];
        assert_eq!(m.line, 1);
        assert_eq!(line_text(m), "start");
        assert_eq!(highlighted(m), vec!["start"]);
    }

    #[test]
    fn a_very_long_line_is_clipped_around_its_match() {
        let filler = "x".repeat(2000);
        let content = format!("{filler}NEEDLE{filler}");
        let index = index_of(&[("/v/a.md", content.as_str())]);
        let r = index.search(&Query::new("NEEDLE")).unwrap();
        let m = &r.files[0].matches[0];
        assert!(m.clipped_start && m.clipped_end);
        assert_eq!(line_text(m).chars().count(), MAX_LINE_CHARS);
        assert_eq!(
            highlighted(m),
            vec!["NEEDLE"],
            "the match survives clipping"
        );
    }

    #[test]
    fn a_short_line_is_not_marked_clipped() {
        let index = index_of(&[("/v/a.md", "just a line")]);
        let r = index.search(&Query::new("line")).unwrap();
        let m = &r.files[0].matches[0];
        assert!(!m.clipped_start && !m.clipped_end);
    }

    #[test]
    fn clipping_a_line_of_multibyte_text_does_not_split_a_character() {
        // Clipping by bytes would panic on a char boundary, and a vault of
        // Japanese or emoji notes is not exotic.
        let filler = "日".repeat(2000);
        let content = format!("{filler}めがね{filler}");
        let index = index_of(&[("/v/a.md", content.as_str())]);
        let r = index.search(&Query::new("めがね")).unwrap();
        let m = &r.files[0].matches[0];
        assert_eq!(line_text(m).chars().count(), MAX_LINE_CHARS);
        assert_eq!(highlighted(m), vec!["めがね"]);
    }

    #[test]
    fn case_insensitive_matching_is_not_ascii_only() {
        let index = index_of(&[("/v/a.md", "the ÉCOLE closed")]);
        let r = index.search(&Query::new("école")).unwrap();
        assert_eq!(highlighted(&r.files[0].matches[0]), vec!["ÉCOLE"]);
    }

    // -----------------------------------------------------------------
    // Ranking and caps
    // -----------------------------------------------------------------

    #[test]
    fn a_file_whose_name_matches_ranks_first() {
        let index = index_of(&[
            ("/v/other.md", "recipes recipes recipes recipes"),
            ("/v/recipes.md", "one mention"),
        ]);
        let r = index.search(&Query::new("recipes")).unwrap();
        assert_eq!(r.files[0].name, "recipes.md");
        assert!(r.files[0].name_match);
        assert!(!r.files[1].name_match, "despite having four more matches");
    }

    #[test]
    fn a_name_only_hit_is_still_a_hit() {
        // Searching for a note by its title is what people actually do, and the
        // note is rarely obliged to say its own name in its own text.
        let index = index_of(&[("/v/Grocery list.md", "milk\neggs")]);
        let r = index.search(&Query::new("grocery")).unwrap();
        assert_eq!(r.total_files, 1);
        assert!(r.files[0].name_match);
        assert!(r.files[0].matches.is_empty());
        assert_eq!(r.files[0].total_matches, 0);
        assert_eq!(r.total_matches, 0, "a name is not a line of the note");
    }

    #[test]
    fn otherwise_more_matches_rank_first_then_path_order() {
        let index = index_of(&[
            ("/v/b.md", "hit"),
            ("/v/a.md", "hit"),
            ("/v/c.md", "hit hit hit"),
        ]);
        let r = index.search(&Query::new("hit")).unwrap();
        let order: Vec<&str> = r.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(order, vec!["c.md", "a.md", "b.md"]);
    }

    #[test]
    fn caps_truncate_but_report_the_real_totals() {
        let index = index_of(&[
            ("/v/a.md", "hit\nhit\nhit\nhit"),
            ("/v/b.md", "hit"),
            ("/v/c.md", "hit"),
        ]);
        let mut q = Query::new("hit");
        q.max_files = 2;
        q.max_matches_per_file = 2;
        let r = index.search(&q).unwrap();

        assert_eq!(r.files.len(), 2);
        assert_eq!(r.total_files, 3, "counted before the cap, not after");
        assert!(r.truncated);
        assert_eq!(r.total_matches, 6);

        let a = &r.files[0];
        assert_eq!(a.matches.len(), 2);
        assert_eq!(a.total_matches, 4);
        assert!(a.truncated);
        assert!(!r.files[1].truncated);
    }

    // -----------------------------------------------------------------
    // Loading a vault, and keeping up with it
    // -----------------------------------------------------------------

    #[test]
    fn load_indexes_the_notes_the_sidebar_shows() {
        let t = TempDir::new();
        let root = &t.0;
        write(&root.join("a.md"), "alpha");
        write(&root.join("sub/b.markdown"), "alpha");
        write(&root.join("notes.txt"), "alpha"); // not a note
        write(&root.join("assets/pic.png"), "alpha"); // not a note

        let index = Index::load(root).unwrap();
        assert_eq!(index.len(), 2);
        assert_eq!(index.search(&Query::new("alpha")).unwrap().total_files, 2);
    }

    #[test]
    fn a_deleted_note_is_not_searchable_from_the_trash() {
        // `.trash/` is where a delete puts a note, and `vaultscan` skips hidden
        // directories — so this holds because the walk is shared rather than
        // reimplemented. Surfacing a note the user deleted, and offering to open
        // it, would be its own small betrayal; pinned here so a future private
        // walk cannot quietly reintroduce it.
        let t = TempDir::new();
        let root = &t.0;
        write(&root.join("kept.md"), "secret plans");
        write(&root.join(".trash/abc/deleted.md"), "secret plans");
        write(&root.join(".obsidian/workspace.json"), "secret plans");

        let index = Index::load(root).unwrap();
        assert_eq!(index.len(), 1);
        let r = index.search(&Query::new("secret plans")).unwrap();
        assert_eq!(r.total_files, 1);
        assert_eq!(r.files[0].name, "kept.md");
    }

    #[test]
    fn a_file_outside_the_vault_is_never_read() {
        // The paths that watcher updates carry come from the webview, and the
        // webview is untrusted (§3.3). Without the containment check this is a
        // file-disclosure hole wearing a search feature as a disguise: pull any
        // file on the machine into the index, then read it back out as results.
        let vault = TempDir::new();
        let elsewhere = TempDir::new();
        write(&vault.0.join("mine.md"), "in the vault");
        let secret = elsewhere.0.join("secrets.md");
        write(&secret, "passphrase");

        let mut index = Index::load(&vault.0).unwrap();
        assert!(!index.upsert_from_disk(&secret));
        assert!(index.index_tree(&elsewhere.0).is_err());
        assert_eq!(index.len(), 1);
        assert!(
            index
                .search(&Query::new("passphrase"))
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[test]
    fn an_index_with_no_folder_reads_nothing_at_all() {
        // This is the state the app holds before a folder is open, and it is the
        // one a crafted call would find first. Fail closed: no root, no reading.
        let t = TempDir::new();
        let path = t.0.join("note.md");
        write(&path, "text");

        let mut index = Index::new();
        assert!(!index.upsert_from_disk(&path));
        assert!(index.index_tree(&t.0).is_err());
        assert!(index.is_empty());
    }

    #[test]
    fn a_traversal_out_of_the_vault_is_refused() {
        let vault = TempDir::new();
        let elsewhere = TempDir::new();
        write(&vault.0.join("mine.md"), "in the vault");
        write(&elsewhere.0.join("secrets.md"), "passphrase");

        let mut index = Index::load(&vault.0).unwrap();
        // Dressed up as a path inside the vault, which a lexical check would let
        // through.
        let dressed = vault
            .0
            .join("..")
            .join(elsewhere.0.file_name().expect("temp dir has a name"));
        assert!(!index.upsert_from_disk(dressed.join("secrets.md")));
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn index_tree_picks_up_a_folder_that_appeared() {
        // A folder rename lands as one event naming the folder — nothing inside
        // it is ever mentioned.
        let t = TempDir::new();
        let root = &t.0;
        write(&root.join("top.md"), "text");
        let mut index = Index::load(root).unwrap();
        assert_eq!(index.len(), 1);

        write(&root.join("moved/a.md"), "text");
        write(&root.join("moved/deep/b.md"), "text");
        assert_eq!(index.index_tree(root.join("moved")).unwrap(), 2);
        assert_eq!(index.search(&Query::new("text")).unwrap().total_files, 3);
    }

    #[test]
    fn a_missing_root_is_an_error() {
        let missing = std::env::temp_dir().join("vaultsearch-does-not-exist-at-all");
        assert!(Index::load(&missing).is_err());
    }

    #[test]
    fn an_oversized_file_is_skipped_and_said_so() {
        let t = TempDir::new();
        let root = &t.0;
        write(&root.join("small.md"), "needle");
        write(
            &root.join("huge.md"),
            &"needle ".repeat((MAX_FILE_BYTES as usize / 7) + 10),
        );

        let index = Index::load(root).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index.skipped().len(), 1);
        assert_eq!(index.skipped()[0].reason, SkipReason::TooLarge);
        assert!(index.skipped()[0].path.ends_with("huge.md"));
    }

    #[test]
    fn a_file_that_is_not_utf8_is_skipped_and_said_so() {
        let t = TempDir::new();
        fs::write(t.0.join("bad.md"), [0xff, 0xfe, 0x00, 0x41]).unwrap();

        let index = Index::load(&t.0).unwrap();
        assert!(index.is_empty());
        assert_eq!(index.skipped()[0].reason, SkipReason::NotUtf8);
    }

    #[test]
    fn upsert_replaces_the_text_and_clears_a_previous_skip() {
        let t = TempDir::new();
        let path = t.0.join("note.md");

        fs::write(&path, [0xff, 0xfe]).unwrap();
        let mut index = Index::rooted(&t.0);
        assert!(!index.upsert_from_disk(&path));
        assert_eq!(index.skipped().len(), 1);

        // The user fixed the file. The skip must not outlive its reason.
        write(&path, "now readable");
        assert!(index.upsert_from_disk(&path));
        assert!(index.skipped().is_empty());
        assert_eq!(
            index.search(&Query::new("readable")).unwrap().total_files,
            1
        );
    }

    #[test]
    fn a_file_that_becomes_unreadable_loses_its_stale_text() {
        // Stale text is a worse answer than no text: it sends the user to a line
        // that no longer says what the result claimed it said.
        let t = TempDir::new();
        let path = t.0.join("note.md");
        write(&path, "original words");
        let mut index = Index::rooted(&t.0);
        assert!(index.upsert_from_disk(&path));

        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(!index.upsert_from_disk(&path));
        assert!(
            index
                .search(&Query::new("original"))
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[test]
    fn remove_drops_one_file_and_reports_whether_it_was_there() {
        let mut index = index_of(&[("/v/a.md", "text")]);
        assert!(index.remove(Path::new("/v/a.md")));
        assert!(!index.remove(Path::new("/v/a.md")));
        assert!(index.is_empty());
    }

    #[test]
    fn removing_a_folder_removes_everything_under_it() {
        // A folder rename or delete arrives as one event about the folder; the
        // watcher never enumerates what was inside it.
        let mut index = index_of(&[
            ("/v/projects/a.md", "text"),
            ("/v/projects/deep/b.md", "text"),
            ("/v/projects-other/c.md", "text"),
            ("/v/top.md", "text"),
        ]);
        assert_eq!(index.remove_subtree(Path::new("/v/projects")), 2);
        assert_eq!(
            index.len(),
            2,
            "a sibling sharing a name prefix is not a child"
        );
        let r = index.search(&Query::new("text")).unwrap();
        let names: Vec<&str> = r.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"c.md") && names.contains(&"top.md"));
    }

    #[test]
    fn bytes_reports_what_the_in_memory_choice_costs() {
        let index = index_of(&[("/v/a.md", "12345"), ("/v/b.md", "678")]);
        assert_eq!(index.bytes(), 8);
    }
}
