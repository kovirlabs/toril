//! Markdown → RTF rendering for export (CLAUDE.md §7), via comrak's AST (§2).
//!
//! RTF (Rich Text Format) is a plain-text document format that Word, LibreOffice,
//! WordPad, and TextEdit all open. We walk comrak's parsed AST and emit RTF
//! control words directly — there is no HTML/webview step, so unlike HTML export
//! this needs no DOMPurify pass (§3.3): the output is inert and we control every
//! byte. Untrusted inline HTML in the source is emitted as *escaped literal text*
//! (it is never interpreted), and all text is RTF-escaped, so a hostile `.md`
//! cannot inject RTF control words or embedded objects.
//!
//! Export is one-way (markdown → RTF), so it does not touch the single-canonical
//! serializer contract (§3.2), which governs the editor's round-trip only.

use comrak::nodes::{AstNode, ListType, NodeValue};
use comrak::{Arena, Options, parse_document};

/// Whether `markdown` plausibly opens with a YAML front-matter block: a leading
/// `---` delimiter line whose **next line is non-blank**.
///
/// comrak's `front_matter_delimiter` is unconditional — with it set, *any*
/// document whose first line is `---` has everything up to the next `---`
/// swallowed as front matter. Toril's canonical thematic break is `---`
/// (`src/editor/canonical.ts`), so a note opening with a horizontal rule and
/// containing a later one would silently lose the content in between (§3). A
/// `---` followed by a blank line (or by EOF) is a thematic break and never valid
/// YAML front matter, so that shape is the reliable discriminator. `---`
/// immediately followed by non-blank text stays front matter — it is
/// indistinguishable from the real thing, and Toril never writes that shape.
///
/// Deliberately duplicated from `mdhtml` (same doc comment there): ten
/// dependency-free lines in each crate beats inventing a shared crate for one
/// predicate, and both call sites carry their own regression tests.
fn opens_with_front_matter(markdown: &str) -> bool {
    let mut lines = markdown.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return false;
    }
    lines.next().is_some_and(|next| !next.trim().is_empty())
}

// Times New Roman (\f0, proportional) for prose, Consolas (\f1, monospace) for
// code. \fs is half-points, so \fs24 = 12pt body text.
const HEADER: &str = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n\
    {\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}\
    {\\f1\\fmodern\\fcharset0 Consolas;}}\n\
    \\f0\\fs24\n";

/// Render canonical markdown to a complete RTF document.
pub fn to_rtf(markdown: &str) -> String {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    // Only when the document really opens with front matter — otherwise a leading
    // `---` thematic break is read as a delimiter and its content dropped (§3).
    if opens_with_front_matter(markdown) {
        options.extension.front_matter_delimiter = Some("---".to_string());
    }
    let root = parse_document(&arena, markdown, &options);

    let mut w = Writer {
        out: String::from(HEADER),
        depth: 0,
    };
    w.blocks(root);
    w.out.push('}');
    w.out
}

/// Append `text` to `out` with RTF escaping. Backslash and braces are RTF
/// metacharacters; any non-ASCII char is emitted as `\uN?` (signed 16-bit
/// UTF-16 code units, so astral chars like emoji become a surrogate pair).
fn escape_into(out: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            c if (c as u32) < 0x80 => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str("\\u");
                    out.push_str(&(*unit as i16).to_string());
                    out.push('?');
                }
            }
        }
    }
}

struct Writer {
    out: String,
    /// List-nesting depth, for left-indent of list items.
    depth: i32,
}

impl Writer {
    /// Render the block-level children of `node`.
    fn blocks<'a>(&mut self, node: &'a AstNode<'a>) {
        for child in node.children() {
            self.block(child);
        }
    }

    /// Render one block-level node (paragraph, heading, list, …).
    fn block<'a>(&mut self, node: &'a AstNode<'a>) {
        match &node.data.borrow().value {
            NodeValue::FrontMatter(_) => {} // parsed, not rendered

            NodeValue::Heading(h) => {
                let fs = match h.level {
                    1 => 36,
                    2 => 32,
                    3 => 28,
                    _ => 26,
                };
                self.out.push_str(&format!("\\pard\\sa120\\b\\fs{} ", fs));
                self.inlines(node);
                self.out.push_str("\\b0\\fs24\\par\n");
            }

            NodeValue::Paragraph => {
                self.out.push_str("\\pard\\sa120 ");
                self.inlines(node);
                self.out.push_str("\\par\n");
            }

            NodeValue::CodeBlock(cb) => {
                self.out.push_str("\\pard\\sa120\\f1 ");
                // Preserve line breaks; trim the single trailing newline comrak keeps.
                let literal = cb.literal.strip_suffix('\n').unwrap_or(&cb.literal);
                let mut first = true;
                for line in literal.split('\n') {
                    if !first {
                        self.out.push_str("\\line ");
                    }
                    first = false;
                    escape_into(&mut self.out, line);
                }
                self.out.push_str("\\f0\\par\n");
            }

            NodeValue::BlockQuote => {
                self.out.push_str("\\pard\\li480\\sa120 ");
                // Render contained paragraphs' inlines, separated by \par.
                let mut first = true;
                for child in node.children() {
                    if !first {
                        self.out.push_str("\\par ");
                    }
                    first = false;
                    self.inlines(child);
                }
                self.out.push_str("\\par\n");
            }

            NodeValue::ThematicBreak => {
                self.out
                    .push_str("\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\par\\pard\\sa120\\par\n");
            }

            NodeValue::List(nl) => {
                self.depth += 1;
                let mut n = nl.start;
                for item in node.children() {
                    let marker = match nl.list_type {
                        ListType::Ordered => {
                            let m = format!("{}.\\tab ", n);
                            n += 1;
                            m
                        }
                        ListType::Bullet => "\\bullet\\tab ".to_string(),
                    };
                    self.item(item, &marker);
                }
                self.depth -= 1;
            }

            NodeValue::Item(_) | NodeValue::TaskItem(_) => {
                // Reached only if a list contains an item we route here directly;
                // normally `List` calls `item` with a computed marker.
                self.item(node, "\\bullet\\tab ");
            }

            NodeValue::Table(_) => self.table(node),

            // Any other block (e.g. an HTML block) → escaped literal paragraph.
            NodeValue::HtmlBlock(h) => {
                self.out.push_str("\\pard\\sa120\\f1 ");
                escape_into(&mut self.out, h.literal.trim_end_matches('\n'));
                self.out.push_str("\\f0\\par\n");
            }

            _ => {
                // Fallback: treat unknown block as a paragraph of its inlines.
                self.out.push_str("\\pard\\sa120 ");
                self.inlines(node);
                self.out.push_str("\\par\n");
            }
        }
    }

    /// Render a single list item with the given marker, handling nested lists.
    fn item<'a>(&mut self, node: &'a AstNode<'a>, marker: &str) {
        let li = 360 * (self.depth.max(1));
        // Task-list checkbox, if this is a GFM task item.
        let checkbox = match &node.data.borrow().value {
            NodeValue::TaskItem(state) => Some(if state.symbol.is_some() {
                "[x] "
            } else {
                "[ ] "
            }),
            _ => None,
        };
        let mut started = false;
        for child in node.children() {
            match &child.data.borrow().value {
                NodeValue::Paragraph => {
                    self.out.push_str(&format!("\\pard\\fi-360\\li{} ", li));
                    self.out.push_str(marker);
                    if let Some(cb) = checkbox {
                        self.out.push_str(cb);
                    }
                    self.inlines(child);
                    self.out.push_str("\\par\n");
                    started = true;
                }
                NodeValue::List(_) => self.block(child),
                _ => self.block(child),
            }
        }
        if !started {
            // Item with no paragraph (rare) — still emit the marker line.
            self.out
                .push_str(&format!("\\pard\\fi-360\\li{} {}\\par\n", li, marker));
        }
    }

    /// Render a GFM table as a basic RTF table (equal-width columns).
    fn table<'a>(&mut self, node: &'a AstNode<'a>) {
        let ncols = match &node.data.borrow().value {
            NodeValue::Table(t) => t.alignments.len().max(1),
            _ => 1,
        };
        // Distribute ~9360 twips (6.5in) across columns; cellx is cumulative.
        let total = 9360_i32;
        let cellx: Vec<i32> = (1..=ncols as i32)
            .map(|i| total * i / ncols as i32)
            .collect();

        for row in node.children() {
            let is_header = matches!(&row.data.borrow().value, NodeValue::TableRow(true));
            self.out.push_str("\\trowd\\trgaph108");
            for x in &cellx {
                self.out.push_str(&format!("\\cellx{}", x));
            }
            self.out.push(' ');
            for cell in row.children() {
                self.out.push_str("\\pard\\intbl ");
                if is_header {
                    self.out.push_str("\\b ");
                }
                self.inlines(cell);
                if is_header {
                    self.out.push_str("\\b0");
                }
                self.out.push_str("\\cell ");
            }
            self.out.push_str("\\row\n");
        }
        self.out.push_str("\\pard\\sa120\n");
    }

    /// Render the inline children of `node` (text + marks).
    fn inlines<'a>(&mut self, node: &'a AstNode<'a>) {
        for child in node.children() {
            self.inline(child);
        }
    }

    /// Render one inline node.
    fn inline<'a>(&mut self, node: &'a AstNode<'a>) {
        match &node.data.borrow().value {
            NodeValue::Text(t) => escape_into(&mut self.out, t),
            NodeValue::SoftBreak => self.out.push(' '),
            NodeValue::LineBreak => self.out.push_str("\\line "),
            NodeValue::Strong => {
                self.out.push_str("{\\b ");
                self.inlines(node);
                self.out.push('}');
            }
            NodeValue::Emph => {
                self.out.push_str("{\\i ");
                self.inlines(node);
                self.out.push('}');
            }
            NodeValue::Strikethrough => {
                self.out.push_str("{\\strike ");
                self.inlines(node);
                self.out.push('}');
            }
            NodeValue::Code(c) => {
                self.out.push_str("{\\f1 ");
                escape_into(&mut self.out, &c.literal);
                self.out.push('}');
            }
            NodeValue::Link(l) => {
                // A clickable RTF HYPERLINK field; the result text is the link body.
                self.out.push_str("{\\field{\\*\\fldinst HYPERLINK \"");
                escape_into(&mut self.out, &l.url);
                self.out.push_str("\"}{\\fldrslt ");
                self.inlines(node);
                self.out.push_str("}}");
            }
            NodeValue::Image(l) => {
                // We don't embed image data; emit a labelled placeholder.
                self.out.push_str("[image: ");
                self.inlines(node); // alt text
                if !l.url.is_empty() {
                    self.out.push_str(" (");
                    escape_into(&mut self.out, &l.url);
                    self.out.push(')');
                }
                self.out.push(']');
            }
            // Raw inline HTML → escaped literal text (never interpreted).
            NodeValue::HtmlInline(h) => escape_into(&mut self.out, h),
            // Anything else with children (e.g. emphasis variants) → recurse.
            _ => self.inlines(node),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rtf(md: &str) -> String {
        to_rtf(md)
    }

    #[test]
    fn wraps_a_document_with_header_and_braces() {
        let out = rtf("Hello.\n");
        assert!(out.starts_with("{\\rtf1\\ansi"));
        assert!(out.ends_with('}'));
        assert!(out.contains("\\fonttbl"));
    }

    #[test]
    fn renders_headings_bold_and_sized() {
        let out = rtf("# Title\n");
        assert!(out.contains("\\fs36"));
        assert!(out.contains("\\b"));
        assert!(out.contains("Title"));
    }

    #[test]
    fn renders_inline_marks() {
        let out = rtf("a **b** *i* ~~s~~ `c`\n");
        assert!(out.contains("{\\b b}"));
        assert!(out.contains("{\\i i}"));
        assert!(out.contains("{\\strike s}"));
        assert!(out.contains("{\\f1 c}"));
    }

    #[test]
    fn escapes_rtf_metacharacters() {
        let out = rtf("a {b} \\c\n");
        assert!(out.contains("\\{b\\}"));
        assert!(out.contains("\\\\c"));
    }

    #[test]
    fn encodes_non_ascii_as_unicode_escapes() {
        let out = rtf("café 🚀\n");
        assert!(out.contains("caf\\u233?")); // é = U+00E9 = 233
        assert!(out.contains("\\u")); // rocket → surrogate-pair \u escapes
        assert!(!out.contains("🚀")); // never the raw astral char
    }

    #[test]
    fn renders_bullet_and_ordered_lists() {
        let bullets = rtf("- one\n- two\n");
        assert!(bullets.contains("\\bullet"));
        assert!(bullets.matches("\\bullet").count() == 2);

        let ordered = rtf("1. first\n2. second\n");
        assert!(ordered.contains("1.\\tab"));
        assert!(ordered.contains("2.\\tab"));
    }

    #[test]
    fn renders_task_list_checkboxes() {
        let out = rtf("- [x] done\n- [ ] todo\n");
        assert!(out.contains("[x] "));
        assert!(out.contains("[ ] "));
    }

    #[test]
    fn renders_code_block_with_line_breaks() {
        let out = rtf("```\nline1\nline2\n```\n");
        assert!(out.contains("\\f1 line1\\line line2"));
    }

    #[test]
    fn renders_link_as_hyperlink_field() {
        let out = rtf("[text](https://example.com)\n");
        assert!(out.contains("HYPERLINK \"https://example.com\""));
        assert!(out.contains("\\fldrslt text"));
    }

    #[test]
    fn renders_table_rows_and_cells() {
        let out = rtf("| A | B |\n| - | - |\n| 1 | 2 |\n");
        assert!(out.contains("\\trowd"));
        assert!(out.contains("\\cellx"));
        assert!(out.contains("\\cell"));
        assert!(out.contains("\\row"));
    }

    #[test]
    fn raw_html_is_escaped_text_not_interpreted() {
        let out = rtf("<b>x</b>\n");
        // Emitted as literal characters; never as an RTF bold group from the tag.
        assert!(out.contains("<b>x</b>") || out.contains("<b>x</b\\>"));
        assert!(!out.contains("{\\b x}"));
    }

    #[test]
    fn front_matter_is_excluded() {
        let out = rtf("---\ntitle: secret\n---\n\n# Heading\n");
        assert!(out.contains("Heading"));
        assert!(!out.contains("secret"));
    }

    #[test]
    fn real_front_matter_is_still_stripped() {
        let out = rtf("---\ntitle: T\n---\n\nBody.\n");
        assert!(out.contains("Body."));
        assert!(!out.contains("title: T"));
    }

    #[test]
    fn leading_thematic_break_does_not_swallow_the_document() {
        // Regression: `---` is Toril's canonical thematic break, and an
        // unconditional front_matter_delimiter read a doc opening with one as
        // front matter — deleting everything up to the next `---` (§3).
        let out = rtf("---\n\nBelow.\n\n---\n\nEnd.\n");
        assert!(out.contains("Below."), "middle content dropped: {out:?}");
        assert!(out.contains("End."));
        assert_eq!(out.matches("\\brdrb").count(), 2);
    }

    #[test]
    fn asterisk_rule_equivalent_is_unchanged() {
        // Guards against over-correcting: the pre-branch rule form must render
        // exactly as the `---` form now does.
        assert_eq!(
            rtf("***\n\nBelow.\n\n***\n\nEnd.\n"),
            rtf("---\n\nBelow.\n\n---\n\nEnd.\n")
        );
    }
}
