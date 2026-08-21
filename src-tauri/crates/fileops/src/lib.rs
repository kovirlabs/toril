//! Create / rename primitives for a Toril workspace (CLAUDE.md §3, ROADMAP
//! Movement II.12 `feat/sidebar-file-ops`).
//!
//! Deleting is not here — that is `trashbin`, which soft-deletes into the
//! workspace `.trash/` and can restore. What is here is everything that brings a
//! path into existence or changes which path a note lives at:
//!
//! - [`validate_name`] — the rules a single path component must satisfy.
//! - [`create_note`] / [`create_folder`] — refuse to clobber, never overwrite.
//! - [`rename`] — same parent, new name; refuses to clobber.
//! - [`available_note_name`] — pick an unused default (`Untitled 2.md`).
//! - [`descendant_files`] — the subtree a folder rename moved, so version
//!   history can follow it.
//!
//! **Two rules carry the safety, and both are enforced here rather than in the
//! caller.** Every operation requires its target to resolve *inside* the vault
//! root — the webview is untrusted (§3.3) and a crafted `invoke` must not be able
//! to write outside the folder the user opened. And every operation that creates
//! a path refuses an existing one instead of replacing it: there is no flag to
//! force it, because "rename over the note that was already there" is exactly the
//! silent loss §3 forbids. Mirrors `trashbin::move_to_trash`, which draws the
//! same containment boundary for the delete direction.
//!
//! No Tauri dependency: pure `std`, fully unit-tested.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Extensions Toril treats as a note, kept in step with `src/paths.ts`'s
/// `OPENABLE` and `tauri.conf.json`'s file associations.
const NOTE_EXTENSIONS: [&str; 4] = ["md", "markdown", "html", "htm"];

/// The extension a new note gets when the user types a bare name.
const DEFAULT_EXTENSION: &str = "md";

/// Longest single path component we will create. 255 is the limit on NTFS, ext4,
/// APFS and HFS+ alike; measured in bytes because that is what the strictest of
/// them counts.
const MAX_COMPONENT_BYTES: usize = 255;

/// Characters no path component may contain.
///
/// This is the **Windows** set, applied on every platform on purpose. Toril's
/// primary target is Windows (§1) but a vault is a plain folder that may be
/// synced from a Mac or a Linux box, so a name that is legal to create here and
/// impossible to open there is a portability bug we would be authoring into the
/// user's own files. `/` and `\` are in the set for a second reason as well:
/// they would turn one component into a path.
const FORBIDDEN_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Device names Windows reserves, which cannot be used as a file name *even with
/// an extension* — `NUL.md` is still the null device. Creating one appears to
/// succeed and then behaves like a device, so it is rejected before we try.
const RESERVED_STEMS: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Reserved device-name prefixes that take a single trailing digit (`COM1`,
/// `LPT9`). `0` is included: it is reserved on current Windows and costs nothing.
const RESERVED_NUMBERED: [&str; 2] = ["com", "lpt"];

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.to_string())
}

fn exists(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "\"{}\" already exists",
            path.file_name().unwrap_or_default().to_string_lossy()
        ),
    )
}

/// Whether `stem` is a Windows reserved device name (case-insensitive).
fn is_reserved_stem(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    if RESERVED_STEMS.contains(&lower.as_str()) {
        return true;
    }
    RESERVED_NUMBERED.iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
    })
}

/// Check that `name` is a usable single path component.
///
/// Rejects, with a message written for the user rather than the log: emptiness,
/// path separators and the other characters Windows forbids, control characters,
/// `.` / `..`, a trailing space or dot (Windows *silently strips* both, so the
/// file that appears is not the one that was asked for and the caller's returned
/// path would be a lie), Windows reserved device names, and anything over
/// [`MAX_COMPONENT_BYTES`].
pub fn validate_name(name: &str) -> io::Result<()> {
    if name.is_empty() {
        return Err(invalid("Enter a name."));
    }
    if name.trim().is_empty() {
        return Err(invalid("A name cannot be only spaces."));
    }
    if name.len() > MAX_COMPONENT_BYTES {
        return Err(invalid("That name is too long."));
    }
    if name == "." || name == ".." {
        return Err(invalid("\".\" and \"..\" are not names."));
    }
    if let Some(c) = name.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(invalid(&format!("A name cannot contain {c}")));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(invalid("A name cannot contain control characters."));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(invalid("A name cannot end with a space or a dot."));
    }
    // The stem before the *first* dot is what Windows matches a device against,
    // so `nul.md` and `nul.tar.gz` are both the null device.
    let stem = name.split('.').next().unwrap_or(name);
    if is_reserved_stem(stem) {
        return Err(invalid(&format!(
            "\"{stem}\" is a reserved name on Windows."
        )));
    }
    Ok(())
}

/// Require `inside` to resolve to a location at or under `root`. Both must exist.
///
/// `canonicalize` resolves `..` and symlinks, which is what makes this a
/// containment check rather than a string comparison, and on Windows it applies
/// the same verbatim prefix to both sides so they compare.
///
/// **It returns nothing on purpose.** The obvious shape — hand back the resolved
/// path and build on that — would be wrong on Windows, where `canonicalize`
/// returns the extended-length `\\?\C:\…` form. Every path in this app is a
/// string that has to match: the sidebar tree's paths, the tab a path opens,
/// the key a note's version history is stored under. A `\\?\` path works for
/// I/O and matches none of them, so it would silently split one note into two
/// identities. Callers therefore validate here and keep building from the
/// caller's own path spelling.
fn require_inside(root: &Path, inside: &Path) -> io::Result<()> {
    let canon_root = fs::canonicalize(root)?;
    let canon = fs::canonicalize(inside)?;
    if !canon.starts_with(&canon_root) {
        return Err(invalid("That location is outside the open folder."));
    }
    Ok(())
}

/// The name a new note gets on disk: `name` if it already carries a note
/// extension (case-insensitive), otherwise `name.md`.
///
/// The condition is "*a note* extension", not "any extension", so a name that
/// merely contains a dot still becomes a note: `Meeting 2026.08.17` →
/// `Meeting 2026.08.17.md`, where an any-extension rule would read `.17` as
/// deliberate and leave a file the sidebar cannot show (`vaultscan` lists
/// markdown only). The cost is that `notes.txt` becomes `notes.txt.md` — the
/// right trade, because New Note means a note, and a wrong-looking name is
/// visible and one rename away, while an invisible file is neither.
pub fn with_note_extension(name: &str) -> String {
    match Path::new(name).extension().and_then(OsStr::to_str) {
        Some(ext) if NOTE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) => {
            name.to_string()
        }
        _ => format!("{name}.{DEFAULT_EXTENSION}"),
    }
}

/// Create an empty note called `name` in `dir`, and return its path.
///
/// `create_new` makes the existence check and the creation one atomic operation,
/// so two racing creates cannot both believe they won and one silently truncate
/// the other's note. The file is created **empty**: a new note's first bytes are
/// whatever the user types, and writing a template here would be content they did
/// not ask for (§3).
pub fn create_note(vault_root: &Path, dir: &Path, name: &str) -> io::Result<PathBuf> {
    let file_name = with_note_extension(name);
    validate_name(&file_name)?;
    require_inside(vault_root, dir)?;
    let path = dir.join(&file_name);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => Ok(path),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(exists(&path)),
        Err(e) => Err(e),
    }
}

/// Create a folder called `name` inside `parent`, and return its path.
///
/// `create_dir` (not `create_dir_all`) so an existing folder is an error rather
/// than a silent success — the caller asked to make something new, and reporting
/// success for a folder that was already there would let the UI claim it created
/// a note's home that in fact belongs to something else.
pub fn create_folder(vault_root: &Path, parent: &Path, name: &str) -> io::Result<PathBuf> {
    validate_name(name)?;
    require_inside(vault_root, parent)?;
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => Ok(path),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(exists(&path)),
        Err(e) => Err(e),
    }
}

/// Rename `from` to `new_name` within the same parent, and return the new path.
///
/// A no-op rename (the same name, byte for byte) succeeds and returns the
/// existing path — otherwise confirming an unchanged inline edit would report a
/// clobber error for a file against itself.
///
/// **`fs::rename` overwrites an existing destination on both Unix and Windows**,
/// so the existence check below is the only thing standing between a rename and
/// a destroyed note. It is a check-then-act, and therefore racy against another
/// process creating that exact path in the window between — the race is accepted
/// (`std` exposes no atomic rename-if-absent that is portable), and it is the
/// same shape `trashbin::restore` already carries. What makes it survivable is
/// that the loser was on disk and is therefore in version history (§3): a
/// clobber is recoverable, undetected-but-recoverable being the standing edge of
/// the guarantee (CLAUDE.md §5).
///
/// A file's extension is **not** forced or preserved: renaming `note.md` to
/// `note.html` is allowed, because the bytes are untouched and it is the user's
/// file. The caller must not reinterpret an open document's format on the
/// strength of a rename — re-serializing content that did not change is the
/// unrequested rewrite this project exists to avoid.
pub fn rename(vault_root: &Path, from: &Path, new_name: &str) -> io::Result<PathBuf> {
    validate_name(new_name)?;
    require_inside(vault_root, from)?;
    let parent = from
        .parent()
        .ok_or_else(|| invalid("That item has no parent folder."))?;
    let to = parent.join(new_name);

    if to == from {
        return Ok(to);
    }
    // Case-only renames (`notes.md` → `Notes.md`) are a real thing users want, and
    // on a case-insensitive filesystem they arrive here as "destination exists" —
    // against the source file itself. Comparing *names* would not tell that apart
    // (they differ, by exactly the case being changed), so resolve the
    // destination and ask whether it is the same file: `canonicalize` returns the
    // real on-disk name, which equals the already-canonicalized `from` when the
    // two are one file. A destination that cannot be resolved is treated as a
    // genuine occupant — failing closed on an ambiguous read is the safe
    // direction when the alternative is a clobbering rename.
    if to.exists() {
        let same_file = match (fs::canonicalize(&to), fs::canonicalize(from)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same_file {
            return Err(exists(&to));
        }
    }
    fs::rename(from, &to)?;
    Ok(to)
}

/// An unused `stem`-based note name in `dir` — `Untitled.md`, else `Untitled 2.md`,
/// `Untitled 3.md`, …
///
/// Used for the default the inline rename field is pre-filled with, so pressing
/// New Note twice in a row proposes a name that will actually work rather than
/// one that fails on confirm. It is a *suggestion*: `create_note` still refuses a
/// collision, because the user can edit the field and something can appear on
/// disk between the suggestion and the create.
pub fn available_note_name(vault_root: &Path, dir: &Path, stem: &str) -> String {
    let first = format!("{stem}.{DEFAULT_EXTENSION}");
    // Containment even though this only reads: it answers "does this file
    // exist?" for any path handed to it, and the webview is untrusted (§3.3).
    // On refusal it returns the plain first candidate — the caller is only
    // pre-filling a field, and `create_note` enforces the same boundary for
    // real.
    if require_inside(vault_root, dir).is_err() {
        return first;
    }
    if !dir.join(&first).exists() {
        return first;
    }
    // Bounded so a pathological directory cannot spin forever; at that point the
    // suggestion is wrong but harmless, and `create_note` reports the collision.
    for n in 2..1000 {
        let candidate = format!("{stem} {n}.{DEFAULT_EXTENSION}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    first
}

/// Every regular file under `dir`, recursively, skipping hidden entries.
///
/// Exists so a **folder** rename can carry version history: the snapshot store is
/// keyed by a note's absolute path, so moving a folder re-keys every note beneath
/// it, and the caller needs the before-list to pair with the after-list. Hidden
/// entries are skipped for the same reason `vaultscan` skips them — `.trash/` and
/// `.obsidian/` are not the user's notes.
///
/// Unreadable subdirectories are skipped rather than failing the walk: this feeds
/// a best-effort, additive history migration (§3), and one permission-denied
/// folder must not turn a successful rename into a reported failure.
pub fn descendant_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_files(dir, &mut out);
    out.sort();
    out
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect_files(&path, out),
            Ok(t) if t.is_file() => out.push(path),
            _ => {}
        }
    }
}

/// Re-root `path` from under `old_root` to under `new_root`.
///
/// The other half of the folder-rename history migration: given the file list
/// taken before the move, this says where each one landed. Returns `None` if
/// `path` was not under `old_root`, so a caller cannot accidentally map an
/// unrelated path into the new tree.
pub fn reroot(path: &Path, old_root: &Path, new_root: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(old_root).ok()?;
    Some(new_root.join(rest))
}

#[cfg(test)]
mod tests {
    use super::*;
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
            let dir = std::env::temp_dir().join(format!("fileops-{tag}-{nanos}-{n}"));
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

    fn write_file(path: &Path, contents: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    // ---- validate_name ----------------------------------------------------

    #[test]
    fn accepts_ordinary_names() {
        for name in [
            "note.md",
            "Meeting Notes.md",
            "2026-08-17.md",
            "café ☕.md",
            "a.very.dotted.name.md",
            "-leading-dash.md",
            ".hidden.md", // legal; vaultscan just won't list it
        ] {
            assert!(validate_name(name).is_ok(), "should accept {name}");
        }
    }

    #[test]
    fn rejects_empty_and_whitespace() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
    }

    #[test]
    fn rejects_path_separators_so_a_name_cannot_become_a_path() {
        assert!(validate_name("sub/note.md").is_err());
        assert!(validate_name("sub\\note.md").is_err());
        assert!(validate_name("../escape.md").is_err());
    }

    #[test]
    fn rejects_the_windows_forbidden_set_on_every_platform() {
        for name in [
            "a<b.md", "a>b.md", "a:b.md", "a\"b.md", "a|b.md", "a?b.md", "a*b.md",
        ] {
            assert!(validate_name(name).is_err(), "should reject {name}");
        }
    }

    #[test]
    fn rejects_control_characters() {
        assert!(validate_name("note\u{0}.md").is_err());
        assert!(validate_name("note\n.md").is_err());
        assert!(validate_name("note\t.md").is_err());
    }

    #[test]
    fn rejects_dot_names_and_trailing_dot_or_space() {
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        // Windows strips these silently, so the created file would not be the
        // one we returned a path for.
        assert!(validate_name("note.").is_err());
        assert!(validate_name("note ").is_err());
        assert!(validate_name("...").is_err());
    }

    #[test]
    fn rejects_windows_reserved_device_names_with_or_without_extension() {
        for name in [
            "CON",
            "con",
            "NUL.md",
            "nul.tar.gz",
            "AUX.md",
            "prn.markdown",
            "COM1.md",
            "lpt9.md",
            "COM0.md",
        ] {
            assert!(validate_name(name).is_err(), "should reject {name}");
        }
        // Not reserved: a longer word that merely starts with one, or a
        // multi-digit port that Windows does not reserve.
        for name in ["console.md", "connection.md", "com10.md", "auxiliary.md"] {
            assert!(validate_name(name).is_ok(), "should accept {name}");
        }
    }

    #[test]
    fn rejects_an_overlong_component() {
        let long = format!("{}.md", "a".repeat(300));
        assert!(validate_name(&long).is_err());
        let ok = format!("{}.md", "a".repeat(200));
        assert!(validate_name(&ok).is_ok());
    }

    // ---- extension handling ------------------------------------------------

    #[test]
    fn appends_md_only_when_the_name_lacks_a_note_extension() {
        assert_eq!(with_note_extension("note"), "note.md");
        assert_eq!(with_note_extension("note.md"), "note.md");
        assert_eq!(with_note_extension("note.MD"), "note.MD");
        assert_eq!(with_note_extension("note.markdown"), "note.markdown");
        assert_eq!(with_note_extension("page.html"), "page.html");
        // Not a *note* extension, so it still gets one — New Note makes a note.
        assert_eq!(with_note_extension("notes.txt"), "notes.txt.md");
        // The case that rule exists for: a dotted name is not an extension.
        assert_eq!(
            with_note_extension("Meeting 2026.08.17"),
            "Meeting 2026.08.17.md"
        );
        assert_eq!(with_note_extension("v1.2.3"), "v1.2.3.md");
    }

    // ---- create_note -------------------------------------------------------

    #[test]
    fn creates_an_empty_note_and_returns_its_path() {
        let t = TempDir::new("create");
        let path = create_note(t.path(), t.path(), "First note").unwrap();

        assert_eq!(path.file_name().unwrap(), "First note.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    /// Every returned path must be spelled the way the caller spelled it.
    ///
    /// The regression this pins: containment is checked with `canonicalize`,
    /// which on Windows returns the extended-length `\\?\C:\…` form. Building
    /// the result from that would hand back a path that does real I/O fine and
    /// matches nothing else in the app — not the sidebar tree, not an open
    /// tab's path, not the note's version-history key — silently splitting one
    /// note into two identities.
    #[test]
    fn returned_paths_keep_the_callers_spelling() {
        let t = TempDir::new("spelling");
        let dir = t.path();

        let created = create_note(dir, dir, "note").unwrap();
        assert_eq!(created, dir.join("note.md"));

        let folder = create_folder(dir, dir, "sub").unwrap();
        assert_eq!(folder, dir.join("sub"));

        let renamed = rename(dir, &created, "other.md").unwrap();
        assert_eq!(renamed, dir.join("other.md"));

        for path in [&created, &folder, &renamed] {
            assert!(
                !path.to_string_lossy().contains(r"\\?\"),
                "{path:?} leaked a canonicalized prefix"
            );
        }
    }

    #[test]
    fn create_note_refuses_to_clobber_an_existing_note() {
        let t = TempDir::new("clobber");
        write_file(&t.path().join("note.md"), "precious");

        let err = create_note(t.path(), t.path(), "note.md").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(t.path().join("note.md")).unwrap(),
            "precious",
            "the existing note must be untouched"
        );
    }

    #[test]
    fn create_note_refuses_a_directory_outside_the_vault() {
        let t = TempDir::new("outside");
        let vault = t.path().join("vault");
        let elsewhere = t.path().join("elsewhere");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();

        let err = create_note(&vault, &elsewhere, "escaped.md").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(
            !elsewhere.join("escaped.md").exists(),
            "nothing may be created outside the vault"
        );
    }

    #[test]
    fn create_note_refuses_a_traversal_dressed_up_as_a_subdirectory() {
        let t = TempDir::new("traverse");
        let vault = t.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(t.path().join("elsewhere")).unwrap();

        let sneaky = vault.join("..").join("elsewhere");
        let err = create_note(&vault, &sneaky, "escaped.md").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    // ---- create_folder -----------------------------------------------------

    #[test]
    fn creates_a_folder_and_refuses_an_existing_one() {
        let t = TempDir::new("folder");
        let path = create_folder(t.path(), t.path(), "Projects").unwrap();
        assert!(path.is_dir());

        let err = create_folder(t.path(), t.path(), "Projects").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn create_folder_does_not_append_an_extension() {
        let t = TempDir::new("folder-ext");
        let path = create_folder(t.path(), t.path(), "notes").unwrap();
        assert_eq!(path.file_name().unwrap(), "notes");
    }

    // ---- rename ------------------------------------------------------------

    #[test]
    fn renames_within_the_same_parent() {
        let t = TempDir::new("rename");
        let sub = t.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        let from = sub.join("old.md");
        write_file(&from, "body");

        let to = rename(t.path(), &from, "new.md").unwrap();

        assert_eq!(to.parent().unwrap().file_name().unwrap(), "sub");
        assert_eq!(to.file_name().unwrap(), "new.md");
        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
        assert!(!from.exists());
    }

    #[test]
    fn rename_refuses_to_clobber_a_different_file() {
        let t = TempDir::new("rename-clobber");
        let from = t.path().join("a.md");
        let occupied = t.path().join("b.md");
        write_file(&from, "mine");
        write_file(&occupied, "theirs");

        let err = rename(t.path(), &from, "b.md").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "theirs");
        assert_eq!(
            fs::read_to_string(&from).unwrap(),
            "mine",
            "a refused rename must leave the source in place"
        );
    }

    #[test]
    fn renaming_to_the_same_name_is_a_no_op_not_a_collision() {
        let t = TempDir::new("rename-same");
        let from = t.path().join("note.md");
        write_file(&from, "body");

        let to = rename(t.path(), &from, "note.md").unwrap();

        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
    }

    #[test]
    fn case_only_rename_is_allowed() {
        // On a case-insensitive filesystem the destination "exists" — it is the
        // same file. Must not be reported as a collision.
        let t = TempDir::new("rename-case");
        let from = t.path().join("notes.md");
        write_file(&from, "body");

        let to = rename(t.path(), &from, "Notes.md").unwrap();

        assert_eq!(to.file_name().unwrap(), "Notes.md");
        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
    }

    #[test]
    fn rename_refuses_a_name_that_is_a_path() {
        let t = TempDir::new("rename-path");
        let from = t.path().join("note.md");
        write_file(&from, "body");

        assert!(rename(t.path(), &from, "../escaped.md").is_err());
        assert!(rename(t.path(), &from, "sub/escaped.md").is_err());
        assert!(from.exists());
    }

    #[test]
    fn rename_refuses_a_source_outside_the_vault() {
        let t = TempDir::new("rename-outside");
        let vault = t.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        let outside = t.path().join("outside.md");
        write_file(&outside, "not yours");

        let err = rename(&vault, &outside, "taken.md").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(outside.exists());
    }

    #[test]
    fn renames_a_folder_with_its_contents() {
        let t = TempDir::new("rename-dir");
        let dir = t.path().join("old");
        write_file(&dir.join("a.md"), "a");
        write_file(&dir.join("deep").join("b.md"), "b");

        let to = rename(t.path(), &dir, "new").unwrap();

        assert_eq!(fs::read_to_string(to.join("a.md")).unwrap(), "a");
        assert_eq!(fs::read_to_string(to.join("deep/b.md")).unwrap(), "b");
        assert!(!dir.exists());
    }

    // ---- available_note_name -----------------------------------------------

    #[test]
    fn suggests_the_first_unused_name() {
        let t = TempDir::new("suggest");
        let vault = t.path();
        assert_eq!(available_note_name(vault, vault, "Untitled"), "Untitled.md");

        write_file(&vault.join("Untitled.md"), "");
        assert_eq!(
            available_note_name(vault, vault, "Untitled"),
            "Untitled 2.md"
        );

        write_file(&vault.join("Untitled 2.md"), "");
        assert_eq!(
            available_note_name(vault, vault, "Untitled"),
            "Untitled 3.md"
        );
    }

    #[test]
    fn suggestion_does_not_probe_outside_the_vault() {
        let t = TempDir::new("suggest-outside");
        let vault = t.path().join("vault");
        let elsewhere = t.path().join("elsewhere");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        write_file(&elsewhere.join("Untitled.md"), "");

        // Would be `Untitled 2.md` if the existence check had run out there.
        assert_eq!(
            available_note_name(&vault, &elsewhere, "Untitled"),
            "Untitled.md"
        );
    }

    // ---- subtree walk / reroot ---------------------------------------------

    #[test]
    fn lists_descendant_files_and_skips_hidden() {
        let t = TempDir::new("walk");
        write_file(&t.path().join("a.md"), "a");
        write_file(&t.path().join("deep/b.md"), "b");
        write_file(&t.path().join(".trash/gone/c.md"), "c");
        write_file(&t.path().join(".hidden.md"), "h");

        let files = descendant_files(t.path());

        assert_eq!(files.len(), 2, "got {files:?}");
        assert!(files.iter().any(|p| p.ends_with("a.md")));
        assert!(files.iter().any(|p| p.ends_with("b.md")));
    }

    #[test]
    fn descendant_files_of_a_missing_directory_is_empty_not_an_error() {
        let t = TempDir::new("walk-missing");
        assert!(descendant_files(&t.path().join("nope")).is_empty());
    }

    #[test]
    fn reroot_maps_a_subtree_path_and_refuses_an_unrelated_one() {
        let old = Path::new("/vault/old");
        let new = Path::new("/vault/new");

        assert_eq!(
            reroot(Path::new("/vault/old/deep/b.md"), old, new),
            Some(PathBuf::from("/vault/new/deep/b.md"))
        );
        assert_eq!(reroot(Path::new("/vault/other/b.md"), old, new), None);
    }
}
