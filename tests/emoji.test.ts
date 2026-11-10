// Gate for src/editor/emoji.ts: a character twemoji does not draw as an image
// (©, ®, ™ — emoji-regex matches them, twemoji leaves them as text) must stay
// ordinary text. As an upstream `emoji` node it crashed the view on load and was
// deleted on save (§3.2). Real emoji must still become emoji nodes.
import { afterEach, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { emoji } from "../src/editor/emoji";
import { useCanonical } from "../src/editor/canonical";
import { docToMarkdown, markdownToDoc } from "../src/editor/serializer";

let live: Editor | null = null;
afterEach(async () => {
  await live?.destroy();
  live = null;
  document.body.innerHTML = "";
});

async function make(md = ""): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  live = await useCanonical(
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, md);
      })
      .use(commonmark)
      .use(gfm)
      .use(emoji),
  ).create();
  return live;
}

function emojiNodes(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === "emoji") out.push(String(n.attrs.html));
  });
  return out;
}

describe("emoji: symbols twemoji leaves as text", () => {
  it("parses ©, ® and ™ as text, not emoji nodes", async () => {
    const editor = await make();
    const doc = editor.action((ctx) => ctx.get(parserCtx)("A © B ® C ™ D\n"));
    expect(emojiNodes(doc)).toEqual([]);
    expect(doc.textContent).toBe("A © B ® C ™ D");
  });

  it("still parses a real emoji as an image emoji node", async () => {
    const editor = await make();
    const doc = editor.action((ctx) => ctx.get(parserCtx)("Ship 🚀 now ™\n"));
    const nodes = emojiNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toContain("<img");
    expect(doc.textContent).toContain("™");
  });

  it("loads a document of symbols into a live editor without throwing", async () => {
    const editor = await make("# Before\n");
    expect(() => markdownToDoc(editor, "Omnipaque® and Visipaque™, © 2026.\n")).not.toThrow();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    expect(view.dom.textContent).toBe("Omnipaque® and Visipaque™, © 2026.");
    expect(docToMarkdown(editor)).toBe("Omnipaque® and Visipaque™, © 2026.\n");
  });

  // The emoji-presentation forms (U+FE0F) are what the `:tm:` shortcode and an
  // emoji keyboard produce. twemoji *does* draw those, so they stay emoji nodes —
  // the fix must not demote them — and they must survive a save byte-exact.
  it("keeps the emoji-presentation forms ©️ ®️ ™️ as image emoji that round-trip", async () => {
    const md = "Mark ©️ and ®️ and ™️ here.\n";
    const editor = await make(md);
    const nodes = editor.action((ctx) => emojiNodes(ctx.get(editorViewCtx).state.doc));
    expect(nodes).toHaveLength(3);
    for (const html of nodes) expect(html).toContain("<img");
    expect(docToMarkdown(editor)).toBe(md);
  });
});
