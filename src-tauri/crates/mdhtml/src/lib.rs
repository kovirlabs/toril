//! Markdown → HTML rendering for export (CLAUDE.md §7), via comrak (§2).
//!
//! This produces an HTML **body fragment** from canonical markdown. The output
//! is deliberately rendered with raw HTML passed through (`render.unsafe_`),
//! because a `.md` file may legitimately contain inline HTML — and may also
//! carry *hostile* HTML (§3.3). Sanitizing is **not** done here: it is the
//! frontend `sanitize.ts` (DOMPurify) chokepoint's job, so there is exactly one
//! sanitization path. Callers MUST sanitize this string before it reaches the
//! DOM or a written file.
//!
//! Extensions match the editor's CommonMark + GFM surface (tables, strikethrough,
//! task lists, autolinks, footnotes) plus YAML front matter, which is parsed and
//! excluded from the rendered body rather than dumped as text — but only for
//! documents that actually open with front matter (`opens_with_front_matter`).

use comrak::{Options, markdown_to_html};

/// Whether `markdown` plausibly opens with a YAML front-matter block: a leading
/// `---` delimiter line whose **next line is non-blank**.
///
/// This guard exists because comrak's `front_matter_delimiter` is unconditional —
/// with it set, *any* document whose first line is `---` has everything up to the
/// next `---` swallowed as front matter. Toril's canonical thematic break is `---`
/// (`src/editor/canonical.ts`), so a note that opens with a horizontal rule and
/// contains a later one would silently lose the content in between (§3). A `---`
/// followed by a blank line (or by EOF) is a thematic break and never valid YAML
/// front matter, so that shape is the reliable discriminator.
///
/// `---` immediately followed by non-blank text is still treated as front matter:
/// it is indistinguishable from the real thing, and is what Obsidian and Jekyll
/// read it as too. Toril never *writes* that shape — it surrounds rules with blank
/// lines.
///
/// The same helper is duplicated in `mdrtf`. Ten dependency-free lines in each
/// crate is cheaper than inventing a shared crate for one predicate, and both
/// call sites carry their own regression tests. **Keep the two bodies identical** —
/// a silent divergence between HTML and RTF export would be its own bug.
fn opens_with_front_matter(markdown: &str) -> bool {
    // A UTF-8 BOM is common in Windows-authored files (the primary platform, §1)
    // and would otherwise make the first line `\u{feff}---`, hiding real front
    // matter from the check below and dumping it into the export body. comrak
    // itself tolerates the BOM, so only this predicate needs to skip it.
    let markdown = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let mut lines = markdown.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return false;
    }
    lines.next().is_some_and(|next| !next.trim().is_empty())
}

/// Render canonical markdown to an HTML body fragment (GFM + front matter).
///
/// The result is UNTRUSTED HTML — sanitize it (§3.3) before rendering/writing.
pub fn to_html(markdown: &str) -> String {
    let mut options = Options::default();
    // GFM surface — mirror the editor (§6).
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    // YAML front matter: recognised and kept out of the rendered body — but only
    // when the document really opens with one, so a leading `---` thematic break
    // is not mistaken for a delimiter and its content dropped (§3).
    if opens_with_front_matter(markdown) {
        options.extension.front_matter_delimiter = Some("---".to_string());
    }
    // Pass raw inline/block HTML through; the frontend sanitizes it (§3.3).
    options.render.r#unsafe = true;
    markdown_to_html(markdown, &options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_commonmark() {
        let out = to_html("# Title\n\nA paragraph.\n");
        assert!(out.contains("<h1>"));
        assert!(out.contains("Title"));
        assert!(out.contains("<p>A paragraph."));
    }

    #[test]
    fn renders_gfm_table() {
        let out = to_html("| A | B |\n| - | - |\n| 1 | 2 |\n");
        assert!(out.contains("<table>"));
        assert!(out.contains("<th>A</th>"));
    }

    #[test]
    fn renders_strikethrough_and_tasklist() {
        assert!(to_html("~~gone~~\n").contains("<del>"));
        let task = to_html("- [x] done\n- [ ] todo\n");
        assert!(task.contains("type=\"checkbox\""));
        assert!(task.contains("checked"));
    }

    #[test]
    fn front_matter_is_excluded_from_the_body() {
        let out = to_html("---\ntitle: secret\n---\n\n# Heading\n");
        assert!(out.contains("Heading"));
        assert!(!out.contains("title: secret")); // parsed, not dumped as text
    }

    #[test]
    fn leading_thematic_break_does_not_swallow_the_document() {
        // Regression: `---` is Toril's canonical thematic break, and an
        // unconditional front_matter_delimiter read a doc opening with one as
        // front matter — deleting everything up to the next `---` (§3).
        let out = to_html("---\n\nBelow.\n\n---\n\nEnd.\n");
        assert!(out.contains("Below."), "middle content dropped: {out:?}");
        assert!(out.contains("End."));
        assert_eq!(out.matches("<hr />").count(), 2);
    }

    #[test]
    fn asterisk_rule_equivalent_is_unchanged() {
        // Guards against over-correcting: the pre-branch canonical rule form must
        // render exactly as it always did.
        assert_eq!(
            to_html("***\n\nBelow.\n\n***\n\nEnd.\n"),
            "<hr />\n<p>Below.</p>\n<hr />\n<p>End.</p>\n"
        );
    }

    #[test]
    fn real_front_matter_is_still_stripped() {
        assert_eq!(to_html("---\ntitle: T\n---\n\nBody.\n"), "<p>Body.</p>\n");
    }

    #[test]
    fn an_unterminated_opener_keeps_the_whole_document() {
        // Parity pin for `src/editor/frontmatter.ts`, which requires a closing
        // delimiter and so keeps this text in the body. comrak agrees: with no
        // closer it abandons the front-matter read rather than swallowing to EOF.
        // If that ever changed, export would delete the opening section of any
        // note starting with a `---` rule (§3), and the splitter would not know.
        let out = to_html("---\ntitle: x\n\n# Heading\n\nBody.\n");
        assert!(out.contains("title: x"), "opening section dropped: {out:?}");
        assert!(out.contains("Heading"));
        assert!(out.contains("Body."));
    }

    #[test]
    fn a_yaml_document_end_marker_does_not_close_front_matter() {
        // Parity pin: the splitter accepts `---` as the only closer, because
        // comrak's delimiter is `---` and treats `...` as ordinary text. Widening
        // the TS side to `...` (as YAML itself allows) would desynchronize the
        // two — the strip would show properties that export renders as prose.
        let out = to_html("---\ntitle: x\n...\n\n# Heading\n");
        assert!(out.contains("title: x"), "opening section dropped: {out:?}");
        assert!(out.contains("Heading"));
    }

    #[test]
    fn a_bom_does_not_hide_front_matter_from_the_guard() {
        // Windows-authored files often carry a UTF-8 BOM; without skipping it the
        // first line is "\u{feff}---" and real front matter lands in the body.
        assert_eq!(
            to_html("\u{feff}---\ntitle: T\n---\n\nBody.\n"),
            "<p>Body.</p>\n"
        );
    }

    #[test]
    fn a_bom_does_not_widen_the_guard_onto_thematic_breaks() {
        let out = to_html("\u{feff}---\n\nBelow.\n\n---\n\nEnd.\n");
        assert!(out.contains("Below."), "middle content dropped: {out:?}");
        assert!(out.contains("End."));
    }

    #[test]
    fn raw_html_passes_through_for_downstream_sanitization() {
        // unsafe_ is on by design: legitimate inline HTML survives…
        assert!(to_html("<b>bold</b>\n").contains("<b>bold</b>"));
        // …and so does hostile HTML — which is exactly why sanitize.ts (§3.3)
        // must run on this output before it is rendered or written.
        assert!(to_html("<script>alert(1)</script>\n").contains("<script>"));
    }
}
