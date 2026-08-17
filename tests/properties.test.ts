// Gate for the properties strip (design spec
// `docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`).
//
// The strip never touches the document, the tab or disk: it renders a block and
// reports a **complete new block** back. So the question this asks is whether
// what it reports would rewrite anything the user did not touch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitFrontMatter } from "../src/editor/frontmatter";
import type { FrontMatter } from "../src/editor/frontmatter";
import { PropertiesStrip } from "../src/ui/properties";

function block(file: string): FrontMatter {
  const fm = splitFrontMatter(file).frontMatter;
  if (!fm) throw new Error(`fixture has no front matter: ${JSON.stringify(file)}`);
  return fm;
}

interface Harness {
  host: HTMLElement;
  strip: PropertiesStrip;
  changes: (FrontMatter | null)[];
  toggles: boolean[];
}

function mount(expanded = true): Harness {
  const host = document.createElement("section");
  document.body.appendChild(host);
  const changes: (FrontMatter | null)[] = [];
  const toggles: boolean[] = [];
  const strip = new PropertiesStrip(
    host,
    { onChange: (next) => changes.push(next), onToggleExpanded: (v) => toggles.push(v) },
    expanded,
  );
  return { host, strip, changes, toggles };
}

const OBSIDIAN = "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n\nBody.\n";

function rows(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(".properties-row"));
}

function keyInput(host: HTMLElement, index: number): HTMLInputElement {
  return rows(host)[index].querySelector<HTMLInputElement>(".properties-key")!;
}

function valueInput(host: HTMLElement, index: number): HTMLInputElement {
  return rows(host)[index].querySelector<HTMLInputElement>(".properties-value, .properties-checkbox")!;
}

/** Type into a control and fire the event the strip listens for. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("PropertiesStrip", () => {
  describe("what it shows", () => {
    it("renders a row per property, with the format badge", () => {
      const { host, strip } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      expect(host.hidden).toBe(false);
      expect(rows(host)).toHaveLength(3);
      expect(keyInput(host, 0).value).toBe("title");
      expect(valueInput(host, 0).value).toBe("My Note");
      expect(host.querySelector(".properties-badge")?.textContent).toBe("YAML");
    });

    it("renders a list value as one control per item", () => {
      const { host, strip } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      const items = rows(host)[1].querySelectorAll<HTMLInputElement>(".properties-item");
      expect(Array.from(items).map((i) => i.value)).toEqual(["alpha", "beta"]);
    });

    it("renders a boolean as a checkbox", () => {
      const { host, strip } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      const box = rows(host)[2].querySelector<HTMLInputElement>(".properties-checkbox");
      expect(box?.checked).toBe(true);
    });

    it("is hidden entirely for a format with no front matter (.html tabs)", () => {
      const { host, strip } = mount();
      strip.setDocument(null, false);
      expect(host.hidden).toBe(true);
    });

    it("offers to add properties when a markdown note has none", () => {
      const { host, strip } = mount();
      strip.setDocument(null, true);
      expect(host.hidden).toBe(false);
      expect(host.querySelector(".properties-add-block")).not.toBeNull();
      // …and shows no header, so an ordinary note carries no band of chrome.
      expect(host.querySelector<HTMLElement>(".properties-header")?.hidden).toBe(true);
    });
  });

  describe("raw mode", () => {
    const COMMENTED = "---\n# a comment\ntitle: T\n---\n\nBody.\n";

    it("shows the block's own bytes, and says why", () => {
      const { host, strip } = mount();
      strip.setDocument(block(COMMENTED), true);
      const area = host.querySelector<HTMLTextAreaElement>(".properties-raw");
      expect(area?.value).toBe("# a comment\ntitle: T\n");
      expect(host.querySelector(".properties-reason")?.textContent).toContain("reformat");
      expect(rows(host)).toHaveLength(0);
    });

    it("restores CRLF endings a textarea strips out", () => {
      // A textarea's value is LF-normalized by spec, so without this one typed
      // character rewrites every line ending in a Windows-authored block — and
      // leaves it mixed, since the fence never passes through the control.
      const { host, strip, changes } = mount();
      strip.setDocument(block("---\r\ntitle: T\r\ntags: x\r\n---\r\n\r\nBody.\r\n"), true);
      const area = host.querySelector<HTMLTextAreaElement>(".properties-raw")!;
      area.value = "title: T2\ntags: x\n"; // what the DOM hands back
      area.dispatchEvent(new Event("input"));
      expect(changes.at(-1)?.text).toBe("---\r\ntitle: T2\r\ntags: x\r\n---\r\n");
    });

    it("leaves an LF block on LF", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block("---\n# c\ntitle: T\n---\n"), true);
      const area = host.querySelector<HTMLTextAreaElement>(".properties-raw")!;
      area.value = "# c\ntitle: T2\n";
      area.dispatchEvent(new Event("input"));
      expect(changes.at(-1)?.text).toBe("---\n# c\ntitle: T2\n---\n");
    });

    it("does not rebuild the textarea while it is being typed in", () => {
      // Re-rendering on every keystroke would reset the caret to the end.
      const { host, strip } = mount();
      strip.setDocument(block(COMMENTED), true);
      const before = host.querySelector(".properties-raw");
      before?.dispatchEvent(new Event("input"));
      expect(host.querySelector(".properties-raw")).toBe(before);
    });
  });

  describe("editing reports a complete block", () => {
    it("changes one value and leaves the others' text alone", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      type(valueInput(host, 0), "Renamed");
      expect(changes.at(-1)?.text).toBe("---\ntitle: Renamed\ntags:\n  - alpha\n  - beta\ndraft: true\n---\n");
    });

    it("keeps a padded fence's exact bytes", () => {
      // `--- ` with a trailing space still has a canonical payload, so it is
      // typed mode — and the fence must come back with its space, since the
      // rebuild goes through the block's own opener/closer rather than "---\n".
      const { host, strip, changes } = mount();
      strip.setDocument(block("--- \ntitle: T\n--- \n\nBody.\n"), true);
      type(valueInput(host, 0), "T2");
      expect(changes.at(-1)?.text).toBe("--- \ntitle: T2\n--- \n");
    });

    it("renames a key in place, keeping its position", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      type(keyInput(host, 0), "heading");
      expect(changes.at(-1)?.text.startsWith("---\nheading: My Note\n")).toBe(true);
    });

    it("refuses a rename onto another property, rather than losing one", () => {
      // Two properties with one name would collapse to one on serialize — a
      // silent deletion. The strip refuses and restores the old name.
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      type(keyInput(host, 0), "draft");
      expect(changes).toHaveLength(0);
      expect(keyInput(host, 0).value).toBe("title");
    });

    it("refuses an empty key", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      type(keyInput(host, 0), "   ");
      expect(changes).toHaveLength(0);
      expect(keyInput(host, 0).value).toBe("title");
    });

    it("toggles a checkbox", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      const box = valueInput(host, 2);
      box.checked = false;
      box.dispatchEvent(new Event("change"));
      expect(changes.at(-1)?.text).toContain("draft: false");
    });

    it("re-derives the type from what was typed", () => {
      // A text input is used for every scalar on purpose (a number/date control
      // rewrites what the user typed), so the type follows the text.
      const { host, strip, changes } = mount();
      strip.setDocument(block("---\ncount: 1\n---\n"), true);
      type(valueInput(host, 0), "not a number");
      expect(changes.at(-1)?.text).toBe("---\ncount: not a number\n---\n");
    });

    it("removes a property, leaving an empty block rather than deleting it", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block("---\ntitle: T\n---\n"), true);
      host.querySelector<HTMLButtonElement>(".properties-remove")!.click();
      expect(changes.at(-1)?.text).toBe("---\n---\n");
    });

    it("adds a property with a name that cannot collide", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block("---\nproperty: a\n---\n"), true);
      host.querySelector<HTMLButtonElement>(".properties-add")!.click();
      expect(changes.at(-1)?.text).toBe("---\nproperty: a\nproperty-2:\n---\n");
    });

    it("creates a YAML block for a note that had none, with a blank line after", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(null, true);
      host.querySelector<HTMLButtonElement>(".properties-add-block")!.click();
      expect(changes.at(-1)).toMatchObject({ format: "yaml", text: "---\n---\n", gap: "\n" });
    });

    it("edits a list item, and drops one emptied to nothing", () => {
      const { host, strip, changes } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      const items = rows(host)[1].querySelectorAll<HTMLInputElement>(".properties-item");
      type(items[1], "");
      expect(changes.at(-1)?.text).toContain("tags:\n  - alpha\n");
      expect(changes.at(-1)?.text).not.toContain("beta");
    });
  });

  describe("focus survives the re-render an edit causes", () => {
    it("puts focus back on the control that was edited", () => {
      // Every edit rebuilds the rows; without this a keyboard user is thrown to
      // the top of the document each time they tick a checkbox.
      const { host, strip } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      const box = valueInput(host, 2);
      box.focus();
      box.checked = false;
      box.dispatchEvent(new Event("change"));
      expect(document.activeElement).toBe(valueInput(host, 2));
      expect(document.activeElement).not.toBe(box); // genuinely a new element
    });
  });

  describe("collapse", () => {
    it("hides the rows but keeps the header", () => {
      const { host, strip } = mount(false);
      strip.setDocument(block(OBSIDIAN), true);
      expect(host.querySelector<HTMLElement>(".properties-body")?.hidden).toBe(true);
      expect(host.querySelector<HTMLElement>(".properties-header")?.hidden).toBe(false);
      expect(host.hidden).toBe(false);
    });

    it("reports a user toggle so it can be persisted, but not a restore", () => {
      const { host, strip, toggles } = mount();
      strip.setDocument(block(OBSIDIAN), true);
      host.querySelector<HTMLButtonElement>(".properties-toggle")!.click();
      expect(toggles).toEqual([false]);
      expect(strip.isExpanded()).toBe(false);

      // Restoring persisted state is not a user edit — §12b, "derived, never
      // stored": writing it back would make a restore look like a choice.
      strip.setExpanded(true);
      expect(toggles).toEqual([false]);
    });
  });

  it("never reports a change for merely being shown", () => {
    // Rendering must not mark the document dirty; only a user edit may.
    const { strip, changes } = mount();
    strip.setDocument(block(OBSIDIAN), true);
    strip.setDocument(block("---\ntitle: T\n---\n"), true);
    strip.setDocument(null, true);
    strip.setDocument(null, false);
    expect(changes).toHaveLength(0);
  });

  it("does not throw on a block it cannot type", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, strip } = mount();
    strip.setDocument(block("---\n\tbad: [unclosed\n:: nope\n---\n"), true);
    expect(host.querySelector(".properties-raw")).not.toBeNull();
    spy.mockRestore();
  });
});
