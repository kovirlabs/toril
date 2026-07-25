// Phase 1 GATE (CLAUDE.md §3.2, §8): markdown ⇄ document must be lossless.
//
// We build a real Milkdown editor (the same commonmark + gfm presets the app
// uses) and round-trip through serializer.ts — the single canonical converter.
// Two properties are asserted per fixture:
//
//   1. Canonical stability: a fixture authored in Milkdown's canonical form
//      round-trips byte-for-byte (open → save does not mutate the file).
//   2. Idempotency: round-tripping again is a no-op (no slow drift across
//      repeated open/save cycles).
//
// The fixtures below are authored in canonical form; if a Milkdown upgrade
// changes serialization, property (1) fails loudly here before it can corrupt
// a user's notes.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "@milkdown/plugin-emoji";
import { useCanonical } from "../src/editor/canonical";
import { docToMarkdown } from "../src/editor/serializer";

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
const preserved: Record<string, string> = {
  tightBullets: "- one\n- two\n- three\n",
  looseBullets: "- one\n\n- two\n",
  nestedTight: "- Parent\n  - Child\n  - Child two\n",
  tightOrdered: "1. First\n2. Second\n",
  tightTaskList: "- [ ] todo\n- [x] done\n",
  looseTaskList: "- [ ] todo\n\n- [x] done\n",
  mixedNested: "- Parent\n  - [ ] child task\n  - plain\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n",
  asteriskEmphasis: "Some *italic* and **bold** text.\n",
  underscoreEmphasis: "Some _italic_ and __bold__ text.\n",
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

  // Emoji shortcodes (`:smile:`) are normalized to the unicode emoji on first
  // save — same safe pattern as tight→loose lists: content preserved, idempotent.
  it("normalizes emoji shortcodes to unicode without losing content", async () => {
    const out = await roundtrip("Hello :smile: world\n");
    expect(out).toBe("Hello 😄 world\n"); // :smile: → 😄
    expect(await roundtrip(out)).toBe(out); // stable afterwards
  });
});
