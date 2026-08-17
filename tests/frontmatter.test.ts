// Gate for the front-matter splitter (CLAUDE.md §3 — see
// `docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`).
//
// The load-bearing property is rule 1: `join(split(x)) === x` for EVERY input,
// including blocks nothing can parse. Everything else here — detection, anatomy,
// Rust parity — protects a *specific* way that property could be satisfied
// uselessly (e.g. by never detecting a block at all).
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  joinFrontMatter,
  splitFrontMatter,
  type FrontMatterFormat,
} from "../src/editor/frontmatter";

const BOM = String.fromCharCode(0xfeff);

/** `[name, file, expected format]` — one table drives losslessness and detection. */
const FIXTURES: ReadonlyArray<readonly [string, string, FrontMatterFormat | null]> = [
  // --- YAML: the Obsidian shapes this branch exists for -------------------
  [
    "obsidian note",
    "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n\n# Heading\n\nBody.\n",
    "yaml",
  ],
  ["block with no gap before the body", "---\ntitle: T\n---\n# Heading\n", "yaml"],
  ["empty block", "---\n---\n\nBody.\n", "yaml"],
  ["block is the whole file", "---\ntitle: T\n---\n", "yaml"],
  ["no trailing newline at all", "---\ntitle: T\n---", "yaml"],
  ["several blank lines of gap", "---\ntitle: T\n---\n\n\n\nBody.\n", "yaml"],
  ["gap is the rest of the file", "---\ntitle: T\n---\n\n\n", "yaml"],
  ["BOM then a block", `${BOM}---\ntitle: T\n---\n\nBody.\n`, "yaml"],
  ["CRLF throughout", "---\r\ntitle: T\r\n---\r\n\r\n# Heading\r\n", "yaml"],
  ["trailing spaces on both delimiters", "--- \ntitle: T\n--- \n\nBody.\n", "yaml"],
  ["a later `---` in the body is not the closer", "---\na: 1\n---\n\nBody.\n\n---\n\nMore.\n", "yaml"],

  // --- YAML we can never offer as typed rows, but must still preserve -----
  ["comment inside the block", "---\n# a comment\ntitle: T\n---\n\nBody.\n", "yaml"],
  ["block scalar", "---\nnote: |\n  line one\n  line two\n---\n\nBody.\n", "yaml"],
  ["anchor and alias", "---\nbase: &b {x: 1}\nother: *b\n---\n\nBody.\n", "yaml"],
  ["nested map", "---\nmeta:\n  author: E\n  deep:\n    x: 1\n---\n\nBody.\n", "yaml"],
  ["outright invalid YAML", "---\n\tbad: [unclosed\n:: nope\n---\n\nBody.\n", "yaml"],

  // --- Not front matter, and the reasons must stay distinct ---------------
  ["plain note", "# Heading\n\nBody.\n", null],
  ["leading thematic break", "---\n\nBody.\n", null],
  ["canonical rule pair", "---\n\nA.\n\n---\n\nB.\n", null],
  ["unterminated opener", "---\ntitle: x\n\n# Heading\n", null],
  ["opener is the entire file", "---", null],
  ["opener plus newline only", "---\n", null],
  ["`...` is not a closer", "---\ntitle: x\n...\n\n# Heading\n", null],
  ["indented opener", "  ---\ntitle: x\n---\n", null],
  ["four dashes", "----\ntitle: x\n----\n", null],
  ["block starts on line 2", "\n---\ntitle: T\n---\n", null],
  ["BOM then a thematic break", `${BOM}---\n\nBody.\n`, null],
  ["empty file", "", null],
  ["single newline", "\n", null],

  // --- TOML --------------------------------------------------------------
  ["toml block", '+++\ntitle = "T"\ntags = ["a", "b"]\n+++\n\nBody.\n', "toml"],
  ["toml empty block", "+++\n+++\n\nBody.\n", "toml"],
  ["toml opening on a blank line", '+++\n\ntitle = "T"\n+++\n\nBody.\n', "toml"],
  ["toml unterminated", '+++\ntitle = "T"\n\nBody.\n', null],

  // --- JSON --------------------------------------------------------------
  ["json block", '{\n  "title": "T"\n}\n\nBody.\n', "json"],
  ["json one-liner", '{"title": "T"}\n\nBody.\n', "json"],
  ["json nested object", '{\n  "meta": { "x": 1 }\n}\n\nBody.\n', "json"],
  ["json brace inside a string", '{\n  "title": "a } b"\n}\n\nBody.\n', "json"],
  ["json escaped quote before a brace", '{\n  "title": "a \\" }"\n}\n\nBody.\n', "json"],
  ["json unbalanced", '{\n  "title": "T"\n\nBody.\n', null],
  ["json closer not alone on its line", '{"a": 1} and prose\n\nBody.\n', null],
  ["a brace mid-file is not front matter", "# Heading\n\n{\n  \"a\": 1\n}\n", null],
];

describe("splitFrontMatter / joinFrontMatter", () => {
  describe("rule 1: the split is lossless", () => {
    for (const [name, file] of FIXTURES) {
      it(`re-emits ${name} byte-exact`, () => {
        expect(joinFrontMatter(splitFrontMatter(file))).toBe(file);
      });
    }

    it("survives randomized documents built from delimiter-like lines", () => {
      // The fixtures cover shapes we thought of. This covers the ones we did
      // not: unbalanced delimiters, delimiters mid-document, ragged endings.
      const pieces = [
        "---",
        "+++",
        "---\r",
        "...",
        "{",
        "}",
        "",
        "   ",
        "title: T",
        'x = "1"',
        "# Heading",
        "- item",
        "\ttab",
      ];
      // A Lehmer generator, so a failure is reproducible rather than flaky — a
      // losslessness bug must be debuggable, not just detected. The multiplier
      // is small enough that `seed * 48271` stays exact in a double; a textbook
      // LCG constant would silently lose precision and shrink the cycle.
      let seed = 20260817;
      const next = () => {
        seed = (seed * 48271) % 2147483647;
        return seed / 2147483647;
      };
      let blocksFound = 0;
      for (let i = 0; i < 2000; i += 1) {
        const lines: string[] = [];
        const count = Math.floor(next() * 8);
        for (let j = 0; j < count; j += 1) {
          lines.push(pieces[Math.floor(next() * pieces.length)]);
        }
        const file = lines.join("\n") + (next() < 0.5 ? "\n" : "");
        const withBom = next() < 0.2 ? BOM + file : file;
        const split = splitFrontMatter(withBom);
        if (split.frontMatter !== null) blocksFound += 1;
        expect(joinFrontMatter(split), `case ${i}: ${JSON.stringify(withBom)}`).toBe(withBom);
      }
      // Losslessness is trivially true if nothing is ever detected, so the fuzz
      // has to prove it exercised the interesting branch.
      expect(blocksFound).toBeGreaterThan(50);
    });
  });

  describe("detection", () => {
    for (const [name, file, format] of FIXTURES) {
      it(`reads ${name} as ${format ?? "no front matter"}`, () => {
        expect(detectFormat(file)).toBe(format);
      });
    }
  });

  describe("anatomy", () => {
    it("splits an Obsidian note into block, gap and body", () => {
      const split = splitFrontMatter("---\ntitle: T\ntags:\n  - a\n---\n\n# Heading\n\nBody.\n");
      expect(split.bom).toBe("");
      expect(split.frontMatter).toEqual({
        format: "yaml",
        text: "---\ntitle: T\ntags:\n  - a\n---\n",
        inner: "title: T\ntags:\n  - a\n",
        opener: "---\n",
        closer: "---\n",
        gap: "\n",
      });
      expect(split.body).toBe("# Heading\n\nBody.\n");
    });

    it("keeps opener + inner + closer equal to the block, for every fixture", () => {
      // The invariant the properties strip rebuilds through: replace the payload,
      // keep the fence's exact bytes (CRLF, a trailing space after `---`, the
      // JSON brace that is both delimiter and payload).
      for (const [name, file] of FIXTURES) {
        const fm = splitFrontMatter(file).frontMatter;
        if (!fm) continue;
        expect(fm.opener + fm.inner + fm.closer, name).toBe(fm.text);
      }
    });

    it("splits the delimiters off a CRLF block and a padded one", () => {
      const crlf = splitFrontMatter("---\r\ntitle: T\r\n---\r\n").frontMatter!;
      expect([crlf.opener, crlf.closer]).toEqual(["---\r\n", "---\r\n"]);
      const padded = splitFrontMatter("--- \ntitle: T\n--- \n").frontMatter!;
      expect([padded.opener, padded.closer]).toEqual(["--- \n", "--- \n"]);
      const json = splitFrontMatter('{\n  "a": 1\n}\n').frontMatter!;
      expect([json.opener, json.inner, json.closer]).toEqual(["", '{\n  "a": 1\n}', "\n"]);
    });

    it("keeps the BOM out of both the block and the body", () => {
      const split = splitFrontMatter(`${BOM}---\ntitle: T\n---\n\nBody.\n`);
      expect(split.bom).toBe(BOM);
      expect(split.frontMatter?.text.startsWith("---")).toBe(true);
      expect(split.body).toBe("Body.\n");
    });

    it("keeps the BOM out of the body when there is no front matter", () => {
      // Otherwise it enters the ProseMirror doc as content.
      const split = splitFrontMatter(`${BOM}# Heading\n`);
      expect(split).toEqual({ bom: BOM, frontMatter: null, body: "# Heading\n" });
    });

    it("preserves CRLF terminators inside the block", () => {
      const split = splitFrontMatter("---\r\ntitle: T\r\n---\r\n\r\nBody.\r\n");
      expect(split.frontMatter?.text).toBe("---\r\ntitle: T\r\n---\r\n");
      expect(split.frontMatter?.inner).toBe("title: T\r\n");
      expect(split.frontMatter?.gap).toBe("\r\n");
      expect(split.body).toBe("Body.\r\n");
    });

    it("reports an empty block as front matter with no properties", () => {
      // Distinct from absence: the strip must show an empty block, not hide.
      const split = splitFrontMatter("---\n---\n\nBody.\n");
      expect(split.frontMatter?.inner).toBe("");
      expect(split.body).toBe("Body.\n");
    });

    it("hands JSON its braces, because that is what a JSON parser needs", () => {
      const split = splitFrontMatter('{\n  "title": "T"\n}\n\nBody.\n');
      expect(split.frontMatter?.inner).toBe('{\n  "title": "T"\n}');
      expect(split.body).toBe("Body.\n");
    });

    it("gives the body to the editor without the front matter", () => {
      // The corruption this branch fixes: these lines used to reach ProseMirror.
      const split = splitFrontMatter("---\ntitle: My Note\ntags:\n  - alpha\ndraft: true\n---\n\n# H\n");
      expect(split.body).not.toContain("draft: true");
      expect(split.body).toBe("# H\n");
    });
  });

  describe("join", () => {
    it("substitutes a serialized body", () => {
      const split = splitFrontMatter("---\ntitle: T\n---\n\n# Old\n");
      expect(joinFrontMatter({ ...split, body: "# New\n\nMore.\n" })).toBe(
        "---\ntitle: T\n---\n\n# New\n\nMore.\n",
      );
    });

    it("substitutes a rebuilt block, keeping the gap", () => {
      const split = splitFrontMatter("---\ntitle: T\n---\n\n# H\n");
      const frontMatter = { ...split.frontMatter!, text: "---\ntitle: T2\n---\n", inner: "title: T2\n" };
      expect(joinFrontMatter({ ...split, frontMatter })).toBe("---\ntitle: T2\n---\n\n# H\n");
    });

    it("returns the body unchanged when there is no block", () => {
      expect(joinFrontMatter({ bom: "", frontMatter: null, body: "# H\n" })).toBe("# H\n");
    });

    it("never glues a rebuilt block's closer onto the body", () => {
      // A block rebuilt by the properties strip could arrive without a trailing
      // newline; concatenating blind would make it unparseable and eat the
      // heading — exactly the corruption this module exists to stop.
      expect(
        joinFrontMatter({
          bom: "",
          frontMatter: { format: "yaml", text: "---\ntitle: T\n---", inner: "title: T\n", gap: "" },
          body: "# H\n",
        }),
      ).toBe("---\ntitle: T\n---\n# H\n");
    });
  });

  // These mirror `an_unterminated_opener_keeps_the_whole_document` and
  // `a_yaml_document_end_marker_does_not_close_front_matter` (plus the BOM and
  // thematic-break tests) in `crates/mdhtml` and `crates/mdrtf`. comrak's
  // `front_matter_delimiter` is unconditional, so `opens_with_front_matter`
  // guards it on the export side; if that guard and this splitter disagree,
  // export deletes a document's opening section (§3). Change one, change both.
  describe("parity with the Rust export guard", () => {
    const AGREED: ReadonlyArray<readonly [string, boolean]> = [
      ["---\ntitle: T\n---\n\nBody.\n", true],
      [`${BOM}---\ntitle: T\n---\n\nBody.\n`, true],
      ["---\n\nBody.\n\n---\n\nEnd.\n", false],
      [`${BOM}---\n\nBody.\n\n---\n\nEnd.\n`, false],
      ["---\ntitle: x\n\n# Heading\n\nBody.\n", false], // no closer
      ["---\ntitle: x\n...\n\n# Heading\n", false], // `...` is not a closer
      ["***\n\nBody.\n\n***\n\nEnd.\n", false],
    ];

    for (const [file, isFrontMatter] of AGREED) {
      it(`agrees on ${JSON.stringify(file)}`, () => {
        expect(detectFormat(file) === "yaml").toBe(isFrontMatter);
      });
    }
  });
});
