// Gate for src/editor/escapes.ts — verified escape minimization (CLAUDE.md §3.2).
//
// Two halves. The pure half drives `minimizeEscapes` with a fake `sameDoc`, so
// the search itself is pinned: joint verification, bisection, the parse cap,
// and that a throwing parser is never read as "equal". The property half runs
// the real canonical editor over randomized prose built from exactly the
// characters remark escapes, and asserts the only thing that matters: the saved
// file loads as the same document, and saving it again changes nothing.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "@milkdown/plugin-emoji";
import { useCanonical } from "../src/editor/canonical";
import { findCandidates, minimizeEscapes, splitBlocks } from "../src/editor/escapes";
import { docToMarkdown } from "../src/editor/serializer";

// A tiny deterministic PRNG so a failure is reproducible from its seed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("findCandidates", () => {
  it("finds escapes and autolink bracket pairs in prose", () => {
    expect(findCandidates("a \\[b] \\* <https://x.y>\n")).toEqual([
      { drop: [2] },
      { drop: [7] },
      { drop: [10, 22] },
    ]);
  });

  it("never offers an escaped backslash", () => {
    expect(findCandidates("x\\\\y and \\\\[z]")).toEqual([]);
  });

  it("skips inline code and fenced code", () => {
    const md = "`a\\[b` ``c\\*`d``\n```\n\\[lit]\n```\n> ~~~\n> \\*q\n> ~~~\nafter \\_\n";
    const found = findCandidates(md);
    expect(found).toHaveLength(1);
    expect(md[found[0].drop[0] + 1]).toBe("_");
  });

  it("ignores a backslash before a non-punctuation character", () => {
    expect(findCandidates("C:\\Users\\me\n")).toEqual([]);
  });
});

describe("splitBlocks", () => {
  it("reproduces its input exactly", () => {
    const rand = rng(7);
    const bits = ["a", "\n", "\n\n", "   \n", "```\n", "~~~\n", "> x\n", "- y\n", " "];
    for (let n = 0; n < 500; n++) {
      const md = Array.from({ length: Math.floor(rand() * 20) }, () => bits[Math.floor(rand() * bits.length)]).join("");
      expect(splitBlocks(md).join("")).toBe(md);
    }
  });

  it("keeps a fence with blank lines inside as one block", () => {
    expect(splitBlocks("p\n\n```\na\n\nb\n```\n\nq\n")).toEqual(["p\n", "\n", "```\na\n\nb\n```\n", "\n", "q\n"]);
  });
});

describe("minimizeEscapes (search)", () => {
  // Every case uses text no other case uses: the block cache is keyed on text,
  // so reusing a block would read another case's verdict.
  it("returns the input untouched, without parsing, when there is nothing to try", () => {
    let calls = 0;
    expect(minimizeEscapes("plain text\n", () => (calls++, true))).toBe("plain text\n");
    expect(calls).toBe(0);
  });

  it("costs one block parse plus one document parse when every removal is valid", () => {
    let calls = 0;
    const out = minimizeEscapes("\\[\\[a]] \\_b\\_ \\~c\n", () => (calls++, true));
    expect(out).toBe("[[a]] _b_ ~c\n");
    expect(calls).toBe(2);
  });

  it("re-verifies only the document when every block is cached", () => {
    const md = "\\[\\[cached]]\n\n\\_also\\_\n";
    minimizeEscapes(md, () => true);
    let calls = 0;
    expect(minimizeEscapes(md, () => (calls++, true))).toBe("[[cached]]\n\n_also_\n");
    expect(calls).toBe(1);
  });

  it("verifies removals jointly — interacting escapes never both go", () => {
    // Either star alone is literal; both together would be emphasis.
    const out = minimizeEscapes("\\*joint\\*\n", (c) => c.includes("\\*"));
    expect(out.match(/\\\*/g)).toHaveLength(1);
  });

  it("bisects to keep only the escapes that are needed", () => {
    const out = minimizeEscapes("\\[1] \\[2] \\- \\[3]\n", (c) => c.includes("\\-"));
    expect(out).toBe("[1] [2] \\- [3]\n");
  });

  it("falls back to a whole-document search when blocks pass but the document does not", () => {
    // Models a definition in another block turning `[ref]` into a link: standalone
    // the bracket is literal, in the document it is not.
    const md = "\\[ref] and \\_x\\_\n\n[ref]: https://e.x\n";
    const same = (c: string, r: string): boolean => r !== md || c.includes("\\[ref]");
    expect(minimizeEscapes(md, same)).toBe("\\[ref] and _x_\n\n[ref]: https://e.x\n");
  });

  it("treats a throwing parser as inequality", () => {
    const boom = (): boolean => {
      throw new Error("boom");
    };
    expect(minimizeEscapes("\\[thrown]\n", boom)).toBe("\\[thrown]\n");
  });

  it("bounds the number of parses on pathological input", () => {
    let calls = 0;
    const md = Array.from({ length: 500 }, (_, i) => `\\[p${i}]`).join(" ") + "\n";
    const out = minimizeEscapes(md, () => (calls++, false));
    expect(calls).toBeLessThanOrEqual(24 + 64);
    expect(out).toBe(md); // unverified ⇒ escape kept, which is always safe
  });
});

async function makeEditor(md: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
}

const docJson = (e: Editor): string =>
  JSON.stringify(e.action((ctx) => ctx.get(editorViewCtx).state.doc.toJSON()));

const TOKENS = [
  "a", "b", "word", " ", " ", " ", "*", "_", "~", "[", "]", "(", ")", "!", "#",
  "-", "+", "1.", "<", ">", "`", "|", ":", "[[x]]", "![[i.png]]", "[!tip]",
  "https://e.x/a_b", "\\", "&", "^", "=", "%%",
];

/** What the serializer emits before minimization — the pre-fix behavior. */
const fullyEscaped = (e: Editor): string =>
  e.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));

describe("minimizeEscapes (property, real parser)", () => {
  // The guarantee is relative, and deliberately so: the minimized file loads as
  // EXACTLY the document the fully escaped file would. Random input also hits a
  // few upstream quirks that are lossy or unstable with or without this module
  // (remark trims a space out of a strikethrough boundary; a bare URL ending in
  // `\` grows a backslash per save — CLAUDE.md §0). Comparing against the
  // escaped baseline gates *this* change without being masked by those.
  it("never loads differently from the fully escaped output, and is no less stable", async () => {
    const rand = rng(20261109);
    let minimizedSomething = 0;
    for (let n = 0; n < 200; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Array.from({ length: 1 + Math.floor(rand() * 10) }, () => TOKENS[Math.floor(rand() * TOKENS.length)]).join(""),
      );
      const input = lines.join("\n\n") + "\n";
      const label = `case ${n}: ${JSON.stringify(input)}`;

      const first = await makeEditor(input);
      const escaped = fullyEscaped(first);
      const saved = docToMarkdown(first);
      if (saved !== escaped) minimizedSomething++;

      const fromSaved = await makeEditor(saved);
      const fromEscaped = await makeEditor(escaped);
      expect(docJson(fromSaved), label).toBe(docJson(fromEscaped));

      // Stability: wherever the old serializer was idempotent, so is the new one.
      if (fullyEscaped(fromEscaped) === escaped) {
        expect(docToMarkdown(fromSaved), label).toBe(saved);
      }
      await Promise.all([first.destroy(), fromSaved.destroy(), fromEscaped.destroy()]);
    }
    // Guard against a vacuous pass (e.g. a generator that stops producing escapes).
    expect(minimizedSomething).toBeGreaterThan(100);
  }, 120_000);
});
