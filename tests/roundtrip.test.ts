// Phase 1 GATE (CLAUDE.md §3.2, §8): markdown ⇄ document must be lossless.
//
// We build a real Milkdown editor through src/editor/canonical.ts — the same
// canonical form the app ships — and round-trip through serializer.ts, the single
// canonical converter. Three fixture classes, each asking a different question:
//
//   1. `fixtures`  — canonical input round-trips byte-for-byte and is idempotent.
//   2. `preserved` — HUMAN/Obsidian-authored input round-trips byte-for-byte.
//                    This is the class with teeth: the canonical fixtures are
//                    authored in our own output form, so they can only confirm
//                    that canonical input stays canonical. A serializer bug that
//                    rewrote every bullet line in a vault stayed green for 133
//                    tests because nothing asked this question.
//   3. `normalized` — input we legitimately rewrite, pinned to its EXACT output.
//                    Not bugs: the node records no original syntax. Keeping the
//                    list executable is what lets sync-coexistence reason about
//                    its conflict rate.
//
// If a Milkdown upgrade changes serialization, this fails loudly here before it
// can reformat a user's notes.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "@milkdown/plugin-emoji";
import { useCanonical } from "../src/editor/canonical";
import { docToMarkdown } from "../src/editor/serializer";
import { joinFrontMatter, splitFrontMatter } from "../src/editor/frontmatter";

/** Parse `md` into a real editor doc, then serialize it back to markdown. */
async function roundtrip(md: string): Promise<string> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
  const out = docToMarkdown(editor);
  await editor.destroy();
  root.remove();
  return out;
}

// Authored in Toril's canonical serialization (src/editor/canonical.ts): `-`
// bullets and `---` thematic breaks, matching what Obsidian writes. Milkdown
// still emits *loose* lists here; the `preserved` class added later covers tight.
const fixtures: Record<string, string> = {
  headings: "# H1\n\n## H2\n\n### H3\n",
  inlineMarks: "A paragraph with **bold**, *italic*, and `inline code`.\n",
  unorderedList: "- Item one\n\n- Item two\n",
  nestedList: "- Parent\n\n  - Child\n\n  - Child two\n",
  orderedList: "1. First\n\n2. Second\n",
  blockquote: "> A quote.\n",
  codeFence: "```js\nconst x = 1\n```\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n",
  link: "[example](https://example.com)\n",
  gfmTable: "| A | B |\n| - | - |\n| 1 | 2 |\n",
  gfmTaskList: "- [ ] todo\n\n- [x] done\n",
  gfmStrikethrough: "~~struck~~\n",
  // Phase 3: emoji canonical form is the unicode char (shortcodes normalize to it;
  // see the normalization test below). Math is deferred — its plugin is deprecated (§8).
  emoji: "Ship it 🚀 now\n",
};

// Human/Obsidian-authored input that must survive a round-trip untouched. This
// class is the point of the gate: the `fixtures` above are authored in Toril's
// own canonical form, so they can only ever confirm that canonical input stays
// canonical — they cannot observe human input being mangled.
//
// Verified with teeth, not just by construction: reverting the two patched
// `toMarkdown` runners in the installed Milkdown bundle and rerunning this class
// failed exactly `tightBullets`, `nestedTight`, `tightTaskList`, and `mixedNested`
// (6 others still passed) — so those four are load-bearing, not incidental.
const preserved: Record<string, string> = {
  tightBullets: "- one\n- two\n- three\n",
  looseBullets: "- one\n\n- two\n",
  nestedTight: "- Parent\n  - Child\n  - Child two\n",
  tightOrdered: "1. First\n2. Second\n",
  tightTaskList: "- [ ] todo\n- [x] done\n",
  looseTaskList: "- [ ] todo\n\n- [x] done\n",
  mixedNested: "- Parent\n  - [ ] child task\n  - plain\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n", // deliberate overlap with `fixtures`
  asteriskEmphasis: "Some *italic* and **bold** text.\n",
  underscoreEmphasis: "Some _italic_ and __bold__ text.\n",
};

// Input that Toril legitimately rewrites. Each entry pins the EXACT output, so
// the residual reformatting is executable rather than prose — `feat/sync-coexistence`
// reasons about its conflict rate from this list. These are not bugs: the node
// carries no record of its original syntax, and fixing that would mean threading
// original-markup attributes through every node (CLAUDE.md §11).
const normalized: Record<string, [input: string, output: string]> = {
  setextHeading: ["Title\n=====\n\nBody text.\n", "# Title\n\nBody text.\n"],
  indentedCode: ["    const x = 1\n", "```\nconst x = 1\n```\n"],
  tildeFence: ["~~~js\nconst x = 1\n~~~\n", "```js\nconst x = 1\n```\n"],
  hardBreakSpaces: ["line one  \nline two\n", "line one\\\nline two\n"],
  linkReference: [
    "See [example][ex].\n\n[ex]: https://example.com\n",
    "See [example](https://example.com).\n",
  ],
  asteriskBullets: ["* one\n* two\n", "- one\n- two\n"],
  asteriskRule: ["Above.\n\n***\n\nBelow.\n", "Above.\n\n---\n\nBelow.\n"],
  underscoreRule: ["Above.\n\n___\n\nBelow.\n", "Above.\n\n---\n\nBelow.\n"],
  tablePadding: ["| A | B |\n|---|---|\n| 1 | 2 |\n", "| A | B |\n| - | - |\n| 1 | 2 |\n"],
  intrawordUnderscore: [
    "A literal asterisk \\* and an underscore_in_word here.\n",
    "A literal asterisk \\* and an underscore\\_in\\_word here.\n",
  ],
  emojiShortcode: ["Hello :smile: world\n", "Hello 😄 world\n"],
  // An UNUSED link reference definition is DELETED — the one place the rewrite
  // drops authored bytes rather than reshaping them. Pre-existing remark
  // behavior, not introduced by the canonical form; tracked in CLAUDE.md §0.
  unusedLinkDefinition: ["Some text.\n\n[ex]: https://example.com\n", "Some text.\n"],
  // THE MOST CONSEQUENTIAL ENTRY. Windows is Toril's primary platform (§1), and a
  // CRLF-authored note has 100% of its lines rewritten to LF on first save — so
  // this single normalization dominates the conflict rate that feat/sync-coexistence
  // reasons about, far more than any construct-level reformat below.
  crlfLineEndings: ["- one\r\n- two\r\n", "- one\n- two\n"],
  bareAutolink: ["Visit https://example.com today.\n", "Visit <https://example.com> today.\n"],
  plusBullets: ["+ one\n+ two\n", "- one\n- two\n"],
  parenOrderedMarker: ["1) one\n2) two\n", "1. one\n2. two\n"],
  overIndentedNesting: ["- Parent\n    - Child\n", "- Parent\n  - Child\n"],
};

// 4. `frontMatter` — WHOLE-FILE round trip, the trip main.ts actually performs:
//    split the block off, round-trip only the body, rejoin. This is the gate item
//    CLAUDE.md §8 has carried as "add when front matter lands" since Phase 3.
//
//    Before the splitter existed, every one of these files was *corrupted*: with
//    no front-matter plugin the block parsed as rule/paragraph/list, and a key
//    after a list value was absorbed as a lazy continuation inside the previous
//    list item — invalid YAML on reopen, so the property vanished in Obsidian.
const frontMatterPreserved: Record<string, string> = {
  obsidianNote: "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n\n# Heading\n\nBody.\n",
  noGapBeforeBody: "---\ntitle: T\n---\n# Heading\n",
  emptyBlock: "---\n---\n\nBody.\n",
  severalBlankLinesOfGap: "---\ntitle: T\n---\n\n\n\nBody.\n",
  // A properties-only note (an Obsidian index/stub) has an EMPTY body, so this
  // pins that an empty document serializes to "" and adds no stray newline.
  frontMatterOnly: "---\ntitle: T\ntags:\n  - alpha\n---\n",
  frontMatterOnlyWithTrailingBlank: "---\ntitle: T\n---\n\n",
  withBom: `${String.fromCharCode(0xfeff)}---\ntitle: T\n---\n\nBody.\n`,
  // Blocks no serializer could reproduce still survive: the block is bytes here.
  yamlComment: "---\n# a comment\ntitle: T\n---\n\nBody.\n",
  blockScalar: "---\nnote: |\n  line one\n  line two\n---\n\nBody.\n",
  invalidYaml: "---\n\tbad: [unclosed\n:: nope\n---\n\nBody.\n",
  toml: '+++\ntitle = "T"\ntags = ["a", "b"]\n+++\n\nBody.\n',
  json: '{\n  "title": "T"\n}\n\nBody.\n',
  // A note that opens with a rule is NOT front matter, and must keep behaving as
  // it did before the splitter existed (the §3 regression `mdhtml` also pins).
  leadingThematicBreak: "---\n\nBody.\n\n---\n\nEnd.\n",
  // Tight bullets in the body still survive — the split must not disturb the
  // `preserved` class's guarantee for the part it does hand to the editor.
  bodyWithTightList: "---\ntitle: T\n---\n\n- one\n- two\n- three\n",
};

const frontMatterNormalized: Record<string, [input: string, output: string]> = {
  // A CRLF note keeps CRLF *inside the block* (it is re-emitted byte-exact) while
  // the body converts to LF like any other body, so the file ends up mixed. That
  // is deliberate and strictly better than the alternatives: normalizing the block
  // would rewrite bytes nobody edited, and YAML/TOML/JSON parsers all accept
  // either ending. See `crlfLineEndings` above for the body-side rule.
  crlfNote: ["---\r\ntitle: T\r\n---\r\n\r\n- one\r\n- two\r\n", "---\r\ntitle: T\r\n---\r\n\r\n- one\n- two\n"],
  // The body still normalizes exactly as it does without a block.
  bodyNormalization: ["---\ntitle: T\n---\n\n* one\n* two\n", "---\ntitle: T\n---\n\n- one\n- two\n"],
};

describe("round-trip fidelity (Phase 1 gate)", () => {
  for (const [name, md] of Object.entries(fixtures)) {
    it(`is canonical & stable: ${name}`, async () => {
      const once = await roundtrip(md);
      expect(once).toBe(md); // (1) lossless on canonical input
      const twice = await roundtrip(once);
      expect(twice).toBe(once); // (2) idempotent
    });
  }

  for (const [name, md] of Object.entries(preserved)) {
    it(`preserves human-authored input: ${name}`, async () => {
      const once = await roundtrip(md);
      expect(once).toBe(md); // (1) the file is not rewritten
      const twice = await roundtrip(once);
      expect(twice).toBe(once); // (2) idempotent
    });
  }

  it("preserves a combined document losslessly", async () => {
    const doc = Object.values(fixtures).join("\n");
    const once = await roundtrip(doc);
    const twice = await roundtrip(once);
    expect(twice).toBe(once);
    // sanity: nothing collapsed to empty
    expect(once.trim().length).toBeGreaterThan(0);
  });

  for (const [name, [input, output]] of Object.entries(normalized)) {
    it(`normalizes to an exact, stable form: ${name}`, async () => {
      const once = await roundtrip(input);
      expect(once).toBe(output); // (1) the exact rewrite, not merely "something"
      expect(await roundtrip(once)).toBe(once); // (2) idempotent — no slow drift
    });
  }

  describe("front matter (whole file)", () => {
    /** Exactly what main.ts does: split, round-trip the body, rejoin. */
    async function roundtripFile(file: string): Promise<string> {
      const split = splitFrontMatter(file);
      return joinFrontMatter({ ...split, body: await roundtrip(split.body) });
    }

    for (const [name, file] of Object.entries(frontMatterPreserved)) {
      it(`preserves the whole file: ${name}`, async () => {
        const once = await roundtripFile(file);
        expect(once).toBe(file);
        expect(await roundtripFile(once)).toBe(once); // idempotent
      });
    }

    for (const [name, [input, output]] of Object.entries(frontMatterNormalized)) {
      it(`normalizes to an exact, stable form: ${name}`, async () => {
        const once = await roundtripFile(input);
        expect(once).toBe(output);
        expect(await roundtripFile(once)).toBe(once);
      });
    }

    it("no longer absorbs a trailing key into the previous list item", async () => {
      // The exact corruption that pulled this branch forward: `draft: true` used
      // to land nested under `- beta`, which is invalid YAML, so Obsidian dropped
      // the property on reopen. Asserted on the shape, not just on equality above,
      // so the reason this class exists cannot be deleted by accident.
      const file = "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n\nBody.\n";
      expect(await roundtripFile(file)).toBe(file);
      // And the pre-splitter path still demonstrates the damage, so the fixture
      // is not merely passing because the input was already canonical markdown.
      expect(await roundtrip(file)).toContain("  draft: true");
    });
  });
});
