// GATE for the HTML format (CLAUDE.md §3.2, §3.3): HTML ⇄ document must be
// lossless for the supported schema, and unsafe markup must never survive a load.
//
// Like roundtrip.test.ts we build a real Milkdown editor (the same commonmark +
// gfm presets the app uses) and go through html-serializer.ts — the single
// canonical HTML converter. Two properties per fixture:
//
//   1. Idempotency: round-tripping a parsed document again is a no-op (the
//      canonical serialized form is a fixed point — no drift across open/save).
//   2. Content survival: the structural markup of each supported construct is
//      present after a round-trip (nothing silently collapses to empty).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Editor, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "@milkdown/plugin-emoji";
import { useCanonical } from "../src/editor/canonical";
import { docToHtml, htmlToDoc } from "../src/editor/html-serializer";
import { docToMarkdown } from "../src/editor/serializer";
import { htmlConstructs } from "../src/editor/html-constructs";

// One shared editor reused across the file — mirroring the real app (a single
// long-lived editor whose content is swapped), and avoiding the parse race that
// churning many short-lived editors triggers under full-suite concurrency.
let editor: Editor;
let root: HTMLElement;

beforeAll(async () => {
  root = document.createElement("div");
  document.body.appendChild(root);
  editor = await useCanonical(
    Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .use(emoji)
      .use(htmlConstructs),
  ).create();
});

afterAll(async () => {
  await editor.destroy();
  root.remove();
});

/** Load `html` into the shared editor doc, then serialize it back to canonical HTML. */
function roundtrip(html: string): string {
  htmlToDoc(editor, html);
  return docToHtml(editor);
}

// Natural HTML input per construct. We assert convergence + survival rather than
// byte-equality, since the canonical serialized whitespace is ProseMirror's to
// decide; the safety guarantee is that re-loading the output is a fixed point.
const fixtures: Record<string, { html: string; expect: RegExp[] }> = {
  headings: { html: "<h1>H1</h1><h2>H2</h2><h3>H3</h3>", expect: [/<h1[^>]*>H1<\/h1>/, /<h2[^>]*>H2<\/h2>/, /<h3[^>]*>H3<\/h3>/] },
  paragraph: { html: "<p>Just a paragraph.</p>", expect: [/<p>Just a paragraph\.<\/p>/] },
  inlineMarks: { html: "<p>A <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p>", expect: [/<strong>bold<\/strong>/, /<em>italic<\/em>/, /<code>code<\/code>/] },
  bulletList: { html: "<ul><li>one</li><li>two</li></ul>", expect: [/<ul[^>]*>/, /<li[^>]*>/, /one/, /two/] },
  orderedList: { html: "<ol><li>first</li><li>second</li></ol>", expect: [/<ol[^>]*>/, /first/, /second/] },
  blockquote: { html: "<blockquote><p>quoted</p></blockquote>", expect: [/<blockquote>/, /quoted/] },
  codeBlock: { html: "<pre><code>const x = 1</code></pre>", expect: [/<pre>/, /const x = 1/] },
  link: { html: '<p><a href="https://example.com">example</a></p>', expect: [/<a href="https:\/\/example\.com">example<\/a>/] },
  thematicBreak: { html: "<p>above</p><hr><p>below</p>", expect: [/<hr>/, /above/, /below/] },
  table: { html: "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>", expect: [/<table>/, /A/, /B/, /1/, /2/] },
  // Richer AI-HTML constructs (DOM-only schema, html-constructs.ts).
  highlight: { html: "<p>a <mark>lit</mark> b</p>", expect: [/<mark>lit<\/mark>/] },
  subscript: { html: "<p>H<sub>2</sub>O</p>", expect: [/<sub>2<\/sub>/] },
  superscript: { html: "<p>x<sup>2</sup></p>", expect: [/<sup>2<\/sup>/] },
  callout: { html: '<div class="callout callout-warning"><p>heads up</p></div>', expect: [/class="callout callout-warning"/, /heads up/] },
  details: { html: "<details open><summary>More</summary><p>hidden</p></details>", expect: [/<details open[^>]*>/, /<summary>More<\/summary>/, /hidden/] },
  definitionList: { html: "<dl><dt>Term</dt><dd><p>Meaning</p></dd></dl>", expect: [/<dl>/, /<dt>Term<\/dt>/, /<dd>/, /Meaning/] },
};

describe("HTML round-trip (format gate)", () => {
  for (const [name, { html, expect: patterns }] of Object.entries(fixtures)) {
    it(`is idempotent & preserves content: ${name}`, () => {
      const once = roundtrip(html);
      for (const p of patterns) expect(once).toMatch(p);
      expect(roundtrip(once)).toBe(once); // fixed point — no drift
    });
  }

  it("preserves a combined document", () => {
    const doc = Object.values(fixtures)
      .map((f) => f.html)
      .join("");
    const once = roundtrip(doc);
    expect(once.trim().length).toBeGreaterThan(0);
    expect(roundtrip(once)).toBe(once);
  });
});

describe("HTML load is sanitized (§3.3)", () => {
  it("strips <script> on load", () => {
    const out = roundtrip("<p>safe</p><script>alert(1)</script>");
    expect(out).toContain("safe");
    expect(out).not.toContain("alert(1)");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("strips inline event handlers on load", () => {
    const out = roundtrip('<p onclick="steal()">click</p>');
    expect(out).toContain("click");
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out).not.toContain("steal()");
  });

  it("strips <iframe> on load", () => {
    const out = roundtrip('<p>doc</p><iframe src="https://evil.example"></iframe>');
    expect(out).toContain("doc");
    expect(out.toLowerCase()).not.toContain("<iframe");
  });
});

// Export HTML/RTF always serialize the doc to markdown (comrak), regardless of
// the tab's format — so an HTML doc holding the richer constructs must degrade to
// markdown without crashing (marks drop their wrapper, blocks render children).
describe("richer constructs degrade to markdown (§7 export path)", () => {
  it("serializes an HTML doc with callout/details/dl/mark to markdown", () => {
    htmlToDoc(
      editor,
      '<div class="callout callout-warning"><p>note <mark>hi</mark> <sub>x</sub></p></div>' +
        "<details open><summary>S</summary><p>body</p></details>" +
        "<dl><dt>Term</dt><dd><p>Def</p></dd></dl>",
    );
    const md = docToMarkdown(editor);
    // Content survives even though the wrappers have no markdown form.
    for (const text of ["note", "hi", "body", "Term", "Def"]) {
      expect(md).toContain(text);
    }
  });
});
