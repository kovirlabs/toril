// Gate for the typed model and the reversibility check (CLAUDE.md §3).
//
// Two questions, and the second is the one with teeth:
//   1. Do Obsidian's own writes come back as typed rows? If they did not, the
//      feature would be useless in the vaults it is aimed at.
//   2. Does anything we would REFORMAT land in raw mode instead? That is the
//      property that makes typed editing safe without a comment-preserving CST,
//      and it has to hold for constructs nobody enumerated in advance.
import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "../src/editor/frontmatter";
import { buildBlock, readProperties, serializeInner } from "../src/editor/frontmatter-values";
import type { Property } from "../src/editor/frontmatter-values";

/** Read a whole file's block the way the strip will. */
function view(file: string) {
  const fm = splitFrontMatter(file).frontMatter;
  if (!fm) throw new Error(`fixture has no front matter: ${JSON.stringify(file)}`);
  return readProperties(fm);
}

function typed(file: string): Property[] {
  const v = view(file);
  if (v.mode !== "typed") throw new Error(`expected typed rows, got raw: ${v.reason}`);
  return v.properties;
}

describe("readProperties", () => {
  describe("Obsidian's own writes are editable", () => {
    it("reads the canonical note", () => {
      expect(typed("---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n\nBody.\n")).toEqual([
        { key: "title", value: { kind: "text", value: "My Note" } },
        { key: "tags", value: { kind: "list", value: ["alpha", "beta"] } },
        { key: "draft", value: { kind: "checkbox", value: true } },
      ]);
    });

    it("types numbers, dates and datetimes", () => {
      expect(typed("---\ncount: 42\nratio: 1.5\nday: 2026-08-17\nat: 2026-08-17T14:32:05\n---\n")).toEqual([
        { key: "count", value: { kind: "number", value: 42 } },
        { key: "ratio", value: { kind: "number", value: 1.5 } },
        { key: "day", value: { kind: "date", value: "2026-08-17" } },
        { key: "at", value: { kind: "datetime", value: "2026-08-17T14:32:05" } },
      ]);
    });

    it("keeps a date as text, never a Date", () => {
      // Through a `Date` a value picks up a timezone and comes back rewritten —
      // an edit to a value nobody edited.
      const [day] = typed("---\nday: 2026-08-17\n---\n");
      expect(typeof day.value.value).toBe("string");
    });

    it("reads an unfilled property as empty text", () => {
      // Obsidian writes `key:` for a property with no value; it is very common,
      // and `nullStr` is tuned so it survives.
      expect(typed("---\ntitle: T\nsummary:\n---\n")).toEqual([
        { key: "title", value: { kind: "text", value: "T" } },
        { key: "summary", value: { kind: "text", value: "" } },
      ]);
    });

    it("reads an empty block as zero properties, not as unreadable", () => {
      expect(view("---\n---\n\nBody.\n")).toEqual({ mode: "typed", properties: [] });
    });

    it("reads an empty list", () => {
      expect(typed("---\ncssclasses: []\n---\n")).toEqual([
        { key: "cssclasses", value: { kind: "list", value: [] } },
      ]);
    });

    it("reads a long value without folding it", () => {
      // yaml wraps at 80 columns by default, which would fail the check on any
      // long description — `lineWidth: 0` is why this is editable.
      const long = "a fairly long single line value that certainly exceeds eighty characters in width";
      expect(typed(`---\ndescription: ${long}\n---\n`)).toEqual([
        { key: "description", value: { kind: "text", value: long } },
      ]);
    });

    it("reads a URL, which is punctuation-heavy but plain", () => {
      expect(typed("---\nurl: https://example.com/a?b=c\n---\n")).toEqual([
        { key: "url", value: { kind: "text", value: "https://example.com/a?b=c" } },
      ]);
    });
  });

  describe("anything we would reformat falls to raw mode", () => {
    const RAW: ReadonlyArray<readonly [string, string]> = [
      ["a standalone comment", "---\n# a comment\ntitle: T\n---\n"],
      ["a trailing comment", "---\ntitle: T # note\n---\n"],
      // Note this one passes the reversibility check — yaml re-emits it exactly.
      // It is excluded because a single-line row cannot hold it, not because we
      // would reformat it. See `classify`.
      ["a block scalar", "---\nnote: |\n  line one\n  line two\n---\n"],
      ["an anchor and alias", "---\nbase: &b\n  x: 1\nother: *b\n---\n"],
      ["a nested map", "---\nmeta:\n  author: E\n---\n"],
      ["a flow sequence", "---\ntags: [alpha, beta]\n---\n"],
      ["an unindented sequence", "---\ntags:\n- alpha\n- beta\n---\n"],
      ["single quotes", "---\nt: 'quoted'\n---\n"],
      ["unnecessary double quotes", '---\nt: "quoted"\n---\n'],
      ["a redundant number form", "---\nf: 1.50\n---\n"],
      ["a folded multi-line scalar", "---\nmulti: line one\n  continued\n---\n"],
      ["a mixed-type list", "---\ntags:\n  - alpha\n  - 2\n---\n"],
      ["invalid YAML", "---\n\tbad: [unclosed\n:: nope\n---\n"],
      ["a duplicate key", "---\ntitle: A\ntitle: B\n---\n"],
      ["a root that is not a map", "---\n- alpha\n- beta\n---\n"],
      ["an explicitly empty string", '---\nt: ""\n---\n'],
    ];

    for (const [name, file] of RAW) {
      it(`refuses typed rows for ${name}`, () => {
        const v = view(file);
        expect(v.mode).toBe("raw");
        if (v.mode === "raw") expect(v.reason.length).toBeGreaterThan(0);
      });
    }

    it("says why, in words a user can act on", () => {
      const v = view("---\n# a comment\ntitle: T\n---\n");
      expect(v.mode === "raw" && v.reason).toBe("Toril would have to reformat this block to edit it");
    });

    it("defers TOML and JSON to step 5 rather than mistyping them", () => {
      expect(view('+++\ntitle = "T"\n+++\n').mode).toBe("raw");
      expect(view('{\n  "title": "T"\n}\n').mode).toBe("raw");
    });
  });

  describe("the check is exact, not approximate", () => {
    // If `readProperties` returns typed rows, then writing those rows back must
    // reproduce the block byte-for-byte. Anything less means an edit to one
    // property silently rewrites another.
    const EDITABLE = [
      "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n",
      "---\nsummary:\n---\n",
      "---\ncount: 42\nday: 2026-08-17\n---\n",
      "---\ncssclasses: []\n---\n",
      "---\n---\n",
    ];

    for (const file of EDITABLE) {
      it(`rebuilds ${JSON.stringify(file)} byte-exact`, () => {
        const fm = splitFrontMatter(file).frontMatter!;
        expect(buildBlock(typed(file), "yaml")).toBe(fm.text);
      });
    }
  });

  describe("serializeInner", () => {
    it("writes an empty text value as an unset property", () => {
      expect(serializeInner([{ key: "a", value: { kind: "text", value: "" } }], "yaml")).toBe("a:\n");
    });

    it("writes zero properties as nothing at all", () => {
      // Not "{}" — an empty block is `---\n---\n`, matching the split fixture.
      expect(serializeInner([], "yaml")).toBe("");
      expect(buildBlock([], "yaml")).toBe("---\n---\n");
    });

    it("quotes what has to be quoted", () => {
      // The value must survive a re-read; correctness beats matching a source
      // that never looked like this anyway.
      const out = serializeInner([{ key: "a", value: { kind: "text", value: "b: c" } }], "yaml");
      expect(out.trimEnd()).toBe('a: "b: c"');
    });

    it("refuses formats it cannot write yet, rather than writing YAML into them", () => {
      expect(() => serializeInner([], "toml")).toThrow();
      expect(() => buildBlock([], "json")).toThrow();
    });
  });
});
