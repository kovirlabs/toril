// Outline gate (CLAUDE.md §4, §8): heading extraction + active-heading logic.
// extractHeadings runs against a real Milkdown doc (like roundtrip.test.ts);
// activeHeadingIndex is pure. The DOM/scroll-spy wiring is GUI (needs the
// webview), so it is verified on-device, not here.
import { describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { activeHeadingIndex, extractHeadings, Outline, type Heading } from "../src/ui/outline";

async function makeEditor(md: string): Promise<Editor> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, md);
    })
    .use(commonmark)
    .use(gfm)
    .create();
}

function docOf(editor: Editor): ProseNode {
  let doc!: ProseNode;
  editor.action((ctx) => {
    doc = ctx.get(editorViewCtx).state.doc;
  });
  return doc;
}

describe("extractHeadings", () => {
  it("returns headings in order with level, text, and increasing pos", async () => {
    const editor = await makeEditor("# H1\n\n## H2\n\n### H3\n");
    const headings = extractHeadings(docOf(editor));
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings.map((h) => h.text)).toEqual(["H1", "H2", "H3"]);
    expect(headings[0].pos).toBeLessThan(headings[1].pos);
    expect(headings[1].pos).toBeLessThan(headings[2].pos);
    await editor.destroy();
  });

  it("is empty for a document with no headings", async () => {
    const editor = await makeEditor("Just a paragraph.\n");
    expect(extractHeadings(docOf(editor))).toEqual([]);
    await editor.destroy();
  });
});

describe("activeHeadingIndex", () => {
  const hs: Heading[] = [
    { level: 1, text: "A", pos: 5 },
    { level: 2, text: "B", pos: 12 },
    { level: 1, text: "C", pos: 30 },
  ];
  it("is -1 when the position is above the first heading", () => {
    expect(activeHeadingIndex(hs, 2)).toBe(-1);
  });
  it("returns the enclosing heading", () => {
    expect(activeHeadingIndex(hs, 5)).toBe(0); // exactly on the first
    expect(activeHeadingIndex(hs, 8)).toBe(0); // inside the first section
    expect(activeHeadingIndex(hs, 12)).toBe(1); // exactly on the second
  });
  it("returns the last heading for a position past the end", () => {
    expect(activeHeadingIndex(hs, 99)).toBe(2);
  });
  it("is -1 for an empty list", () => {
    expect(activeHeadingIndex([], 10)).toBe(-1);
  });
});

describe("Outline (render + navigate)", () => {
  it("renders one entry per heading with its text and level", async () => {
    const editor = await makeEditor("# Alpha\n\n## Beta\n");
    const editorRoot = document.createElement("div");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, editorRoot);
    const entries = panel.querySelectorAll<HTMLElement>(".outline-entry");
    expect([...entries].map((e) => e.textContent)).toEqual(["Alpha", "Beta"]);
    expect(entries[0].dataset.level).toBe("1");
    expect(entries[1].dataset.level).toBe("2");
    outline.destroy();
    await editor.destroy();
  });

  it("shows an empty-state when there are no headings", async () => {
    const editor = await makeEditor("Just text.\n");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, document.createElement("div"));
    expect(panel.querySelector(".outline-entry")).toBeNull();
    expect(panel.querySelector(".outline-empty")?.textContent).toBe("No headings");
    outline.destroy();
    await editor.destroy();
  });

  it("moves the selection into the heading when an entry is clicked", async () => {
    const editor = await makeEditor("# Alpha\n\n## Beta\n");
    const editorRoot = document.createElement("div");
    const panel = document.createElement("aside");
    const outline = new Outline(panel, editor, editorRoot);
    const entries = panel.querySelectorAll<HTMLButtonElement>(".outline-entry");
    entries[1].click(); // navigate to "Beta"

    let parentName = "";
    let parentText = "";
    editor.action((ctx) => {
      const { selection } = ctx.get(editorViewCtx).state;
      parentName = selection.$from.parent.type.name;
      parentText = selection.$from.parent.textContent;
    });
    expect(parentName).toBe("heading");
    expect(parentText).toBe("Beta");
    outline.destroy();
    await editor.destroy();
  });
});
