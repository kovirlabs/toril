// The properties strip: a collapsible band above the writing surface showing a
// document's front matter (design spec
// `docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`).
//
// It sits in the `#main` column rather than in the right rail, because front
// matter belongs to the top of the document and reads as part of it. §12b
// applies: it is a flex row in a flex column, it carries `min-height: 0`, and it
// never animates around `display: none`.
//
// Two modes, decided by `readProperties` and never by this file:
//
//   typed — rows with a control per property type. Offered ONLY for a block that
//           provably re-serializes to its exact original text.
//   raw   — a textarea over the block's own bytes, plus the reason. Not a
//           failure state: it is the honest answer for a block Toril cannot
//           promise to rewrite, and it is still fully editable.
//
// Every edit reports a **complete new block** through `onChange`. This file
// never touches the document, the tab, or disk.
import type { FrontMatter } from "../editor/frontmatter";
import type { Property, PropertyValue } from "../editor/frontmatter-values";
import { buildBlock, readProperties, serializeInner } from "../editor/frontmatter-values";

export interface PropertiesStripOptions {
  /**
   * The block was edited. `null` means the user removed the last property *and*
   * asked to drop the block; anything else is a complete replacement.
   */
  onChange(next: FrontMatter | null): void;
  /** The user expanded or collapsed the strip; persist it. */
  onToggleExpanded(expanded: boolean): void;
}

/** What the strip is showing, so `main.ts` does not have to track it. */
type Doc =
  | { kind: "hidden" } // an .html tab — front matter is a markdown concept
  | { kind: "absent" } // markdown with no block: offer to add one
  | { kind: "present"; frontMatter: FrontMatter };

const FORMAT_LABEL: Record<FrontMatter["format"], string> = {
  yaml: "YAML",
  toml: "TOML",
  json: "JSON",
};

export class PropertiesStrip {
  private readonly el: HTMLElement;
  private readonly header: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly body: HTMLDivElement;

  private doc: Doc = { kind: "hidden" };
  private expanded: boolean;

  constructor(host: HTMLElement, private readonly opts: PropertiesStripOptions, expanded = true) {
    this.expanded = expanded;

    this.el = host;
    this.el.classList.add("properties");
    this.el.hidden = true;

    this.header = document.createElement("div");
    this.header.className = "properties-header";

    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "properties-toggle";
    this.toggle.addEventListener("click", () => this.setExpanded(!this.expanded, true));
    this.header.appendChild(this.toggle);

    this.badge = document.createElement("span");
    this.badge.className = "properties-badge";
    this.header.appendChild(this.badge);

    this.body = document.createElement("div");
    this.body.className = "properties-body";

    this.el.appendChild(this.header);
    this.el.appendChild(this.body);
  }

  /** Point the strip at a document. Pass `null` for a format with no front matter. */
  setDocument(frontMatter: FrontMatter | null, supportsFrontMatter: boolean): void {
    this.doc = !supportsFrontMatter
      ? { kind: "hidden" }
      : frontMatter === null
        ? { kind: "absent" }
        : { kind: "present", frontMatter };
    this.render();
  }

  setExpanded(expanded: boolean, fromUser = false): void {
    this.expanded = expanded;
    if (fromUser) this.opts.onToggleExpanded(expanded);
    this.render();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  // ---- rendering -----------------------------------------------------------

  private render(): void {
    // Every edit re-renders the strip, which destroys the control the user is
    // typing in. Each control carries a stable id so focus lands back where it
    // was — otherwise ticking a checkbox or removing a list item silently sends
    // a keyboard user back to the top of the document.
    const active = document.activeElement;
    const focusId =
      active instanceof HTMLElement && this.el.contains(active) ? (active.dataset.focusId ?? null) : null;

    this.body.replaceChildren();

    if (this.doc.kind === "hidden") {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;

    if (this.doc.kind === "absent") {
      // No block: one muted affordance and nothing else, so an ordinary note
      // does not carry a permanent band of chrome above its first line.
      this.el.classList.add("properties-empty");
      this.header.hidden = true;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "properties-add-block";
      add.textContent = "+ Add properties";
      // The document's own format is unknown when there is none; YAML is the
      // right default (Obsidian's, and the only format the export path reads).
      add.addEventListener("click", () => this.emit(this.blockFrom([], newYamlBlock())));
      this.body.appendChild(add);
      return;
    }

    this.el.classList.remove("properties-empty");
    this.header.hidden = false;

    const fm = this.doc.frontMatter;
    const view = readProperties(fm);
    this.badge.textContent = FORMAT_LABEL[fm.format];
    this.badge.title = `Front matter is written as ${FORMAT_LABEL[fm.format]}`;

    const count = view.mode === "typed" ? view.properties.length : null;
    this.toggle.textContent = count === null ? "Properties" : `Properties (${count})`;
    this.toggle.setAttribute("aria-expanded", String(this.expanded));
    this.toggle.title = this.expanded ? "Collapse properties" : "Expand properties";

    this.body.hidden = !this.expanded;
    if (!this.expanded) return;

    if (view.mode === "raw") this.renderRaw(fm, view.reason);
    else this.renderTyped(fm, view.properties);

    this.restoreFocus(focusId);
  }

  private restoreFocus(focusId: string | null): void {
    if (focusId === null) return;
    const match = Array.from(this.body.querySelectorAll<HTMLElement>("[data-focus-id]")).find(
      (el) => el.dataset.focusId === focusId,
    );
    match?.focus();
  }

  private renderRaw(fm: FrontMatter, reason: string): void {
    const note = document.createElement("p");
    note.className = "properties-reason";
    // Said plainly, and without apology: raw mode is a correct answer, and the
    // user can still edit every byte of the block.
    note.textContent = `Shown as text — ${reason}.`;
    this.body.appendChild(note);

    const area = document.createElement("textarea");
    area.className = "properties-raw";
    area.value = fm.inner;
    area.spellcheck = false;
    area.dataset.focusId = "raw";
    area.setAttribute("aria-label", "Front matter source");
    // A textarea's value is LF-normalized by the HTML spec, so typing one
    // character into a CRLF block would come back with every line ending
    // rewritten — and the fence, which never passes through the control, would
    // keep its CRLF, leaving the block mixed. Restore the ending the block
    // actually used. Only when it was *uniformly* CRLF: a block that is already
    // mixed has no ending to restore, and guessing one would be its own rewrite.
    const restore = isCrlfOnly(fm.inner)
      ? (value: string) => value.replace(/\r?\n/g, "\r\n")
      : (value: string) => value;

    area.addEventListener("input", () => {
      // Only the payload is replaced; the fence keeps its exact bytes, so a
      // CRLF block or a `--- ` delimiter is not quietly rewritten.
      //
      // `rerender: false` — this fires on every keystroke, and rebuilding the
      // textarea under the cursor would reset the caret to the end of the text
      // on each one. It also means a block that becomes typed-able while being
      // typed does not swap the UI out mid-edit; it switches on the next load.
      const inner = restore(area.value);
      this.emit({ ...fm, inner, text: fm.opener + inner + fm.closer }, false);
    });
    this.body.appendChild(area);
  }

  private renderTyped(fm: FrontMatter, properties: Property[]): void {
    const list = document.createElement("div");
    list.className = "properties-rows";

    properties.forEach((property, index) => {
      list.appendChild(this.renderRow(fm, properties, property, index));
    });
    this.body.appendChild(list);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "properties-add";
    add.dataset.focusId = "add";
    add.textContent = "+ Add property";
    add.addEventListener("click", () => {
      const next = [...properties, { key: uniqueKey(properties), value: textValue("") }];
      this.emit(this.blockFrom(next, fm));
    });
    this.body.appendChild(add);
  }

  private renderRow(
    fm: FrontMatter,
    properties: Property[],
    property: Property,
    index: number,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "properties-row";

    const replace = (next: Property): void => {
      const updated = properties.map((p, i) => (i === index ? next : p));
      this.emit(this.blockFrom(updated, fm));
    };

    const key = document.createElement("input");
    key.type = "text";
    key.className = "properties-key";
    key.value = property.key;
    key.dataset.focusId = `key:${index}`;
    key.setAttribute("aria-label", "Property name");
    // `change`, not `input`: renaming a key re-renders the whole strip, and
    // doing that on every keystroke would pull focus out from under the user.
    key.addEventListener("change", () => {
      const renamed = key.value.trim();
      // A rename onto another property's name would collapse the two and lose
      // one of them on save. Refused outright — the re-render restores the old
      // name, so nothing is written and nothing is lost. Same for an empty name,
      // which no format can express.
      if (renamed === "" || properties.some((p, i) => i !== index && p.key === renamed)) {
        this.render();
        return;
      }
      replace({ ...property, key: renamed });
    });
    row.appendChild(key);

    row.appendChild(this.renderValue(property, index, replace));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "properties-remove";
    remove.dataset.focusId = `remove:${index}`;
    remove.textContent = "×";
    remove.title = `Remove ${property.key}`;
    remove.setAttribute("aria-label", `Remove ${property.key}`);
    remove.addEventListener("click", () => {
      const next = properties.filter((_, i) => i !== index);
      // Removing the last property leaves an EMPTY block rather than deleting
      // the block: dropping it is a bigger decision than removing a row, and
      // `---\n---\n` is a legitimate document that Obsidian also writes.
      this.emit(this.blockFrom(next, fm));
    });
    row.appendChild(remove);

    return row;
  }

  private renderValue(
    property: Property,
    index: number,
    replace: (next: Property) => void,
  ): HTMLElement {
    const { value } = property;

    if (value.kind === "checkbox") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "properties-checkbox";
      box.dataset.focusId = `value:${index}`;
      box.checked = value.value;
      box.setAttribute("aria-label", `${property.key} value`);
      box.addEventListener("change", () =>
        replace({ ...property, value: { kind: "checkbox", value: box.checked } }),
      );
      return box;
    }

    if (value.kind === "list") {
      const wrap = document.createElement("div");
      wrap.className = "properties-list";
      value.value.forEach((item, i) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "properties-item";
        input.value = item;
        input.dataset.focusId = `item:${index}:${i}`;
        input.setAttribute("aria-label", `${property.key} item ${i + 1}`);
        input.addEventListener("change", () => {
          const items = value.value.map((v, j) => (j === i ? input.value : v));
          // An emptied item is a removal — otherwise the list grows blanks that
          // serialize as empty strings nobody asked for.
          replace({ ...property, value: { kind: "list", value: items.filter((v) => v !== "") } });
        });
        wrap.appendChild(input);
      });

      const addItem = document.createElement("button");
      addItem.type = "button";
      addItem.className = "properties-add-item";
      addItem.dataset.focusId = `add-item:${index}`;
      addItem.textContent = "+";
      addItem.title = `Add to ${property.key}`;
      addItem.setAttribute("aria-label", `Add to ${property.key}`);
      addItem.addEventListener("click", () =>
        replace({ ...property, value: { kind: "list", value: [...value.value, "new"] } }),
      );
      wrap.appendChild(addItem);
      return wrap;
    }

    // text / number / date / datetime all edit as plain text. A `type=number`
    // or `type=date` control rewrites what the user typed (locale, timezone,
    // exponent forms), which is precisely the unrequested edit this branch is
    // about — so the input stays text and the TYPE is re-derived from what was
    // typed. Typing a word into a number turns the property into text, which is
    // what the user just expressed.
    const input = document.createElement("input");
    input.type = "text";
    input.className = "properties-value";
    input.value = String(value.value);
    input.dataset.focusId = `value:${index}`;
    input.setAttribute("aria-label", `${property.key} value`);
    input.addEventListener("change", () => replace({ ...property, value: retype(input.value) }));
    return input;
  }

  // ---- change plumbing -----------------------------------------------------

  /** A complete block for `properties`, keeping `fm`'s fence and gap. */
  private blockFrom(properties: Property[], fm: FrontMatter): FrontMatter {
    const inner = serializeInner(properties, fm.format);
    return { ...fm, inner, text: fm.opener + inner + fm.closer };
  }

  private emit(next: FrontMatter, rerender = true): void {
    this.doc = { kind: "present", frontMatter: next };
    if (rerender) this.render();
    this.opts.onChange(next);
  }
}

/** The shape a brand-new block starts from — YAML, empty, with a blank line after. */
function newYamlBlock(): FrontMatter {
  return {
    format: "yaml",
    text: buildBlock([], "yaml"),
    inner: "",
    opener: "---\n",
    closer: "---\n",
    // A blank line between the block and the first line of prose, which is what
    // Obsidian writes and what `frontmatter.ts` would have split back out.
    gap: "\n",
  };
}

/** True when every line ending in `text` is CRLF, and there is at least one. */
function isCrlfOnly(text: string): boolean {
  let seen = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    if (text[i - 1] !== "\r") return false;
    seen = true;
  }
  return seen;
}

function textValue(value: string): PropertyValue {
  return { kind: "text", value };
}

/** Re-derive a value's type from freshly typed text (see `renderValue`). */
function retype(raw: string): PropertyValue {
  const trimmed = raw.trim();
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return { kind: "number", value: Number(trimmed) };
  }
  if (trimmed === "true" || trimmed === "false") {
    return { kind: "checkbox", value: trimmed === "true" };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { kind: "date", value: trimmed };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return { kind: "datetime", value: trimmed };
  }
  return textValue(raw);
}

/** `property`, `property-2`, … — never a duplicate, which YAML would reject. */
function uniqueKey(existing: Property[]): string {
  const taken = new Set(existing.map((p) => p.key));
  if (!taken.has("property")) return "property";
  for (let n = 2; ; n += 1) {
    const candidate = `property-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
