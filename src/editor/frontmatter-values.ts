// Typed model ⇄ front-matter block text, and the reversibility check that decides
// whether typed editing may be offered at all (CLAUDE.md §3; design spec
// `docs/superpowers/specs/2026-08-17-frontmatter-properties-design.md`).
//
// `frontmatter.ts` carries the block as bytes and never parses. This module is
// the only place a parser runs, and everything it does is undoable by
// construction: a block is offered as typed rows ONLY when parsing it and
// serializing it back reproduces the original text **exactly**. Unequal ⇒ the
// strip shows raw mode over the original bytes.
//
// That check is what makes the feature safe without a comment-preserving CST. It
// fails *closed*: an anchor, a folded scalar, an unusual quoting style, a stray
// comment — anything we would reformat — is caught by construction rather than
// enumerated in advance.
//
// **Rejected: editing yaml's `parseDocument` AST**, which preserves comments,
// quoting and flow style and would let far more blocks be editable. Mutating one
// value in a document that carries a standalone comment relocates the comment
// (verified: `empty:\n# c\ndraft: true` became `empty: # c\n\ndraft: false`) —
// an unrequested rewrite of bytes the user never touched, which is the exact
// class of damage this branch exists to stop. The canonical compare below cannot
// do that, because it only ever accepts blocks that are *already* in the form it
// writes.
import { parse, stringify } from "yaml";
import type { FrontMatter, FrontMatterFormat } from "./frontmatter";

export type PropertyValue =
  | { kind: "text"; value: string }
  | { kind: "list"; value: string[] }
  | { kind: "number"; value: number }
  | { kind: "checkbox"; value: boolean }
  // ISO 8601, kept as TEXT and never a `Date`: round-tripping through `Date`
  // re-formats and applies a timezone, i.e. edits a value nobody edited.
  | { kind: "date"; value: string }
  | { kind: "datetime"; value: string };

export interface Property {
  key: string;
  value: PropertyValue;
}

/**
 * What the strip may show. `raw` is not an error state — it is the honest answer
 * for a block we cannot promise to put back, and it carries the reason so the UI
 * can say why rather than silently degrading.
 */
export type PropertyView =
  | { mode: "typed"; properties: Property[] }
  | { mode: "raw"; reason: string };

/**
 * Serializer options tuned until Obsidian's own writes pass the reversibility
 * check — the same discipline `src/editor/canonical.ts` applies to markdown. If
 * the vaults this feature targets landed in raw mode, the feature would be
 * useless in exactly the place it is aimed.
 *
 * - `nullStr: ""` writes an unset property as `key:`, which is what Obsidian
 *   writes for an unfilled property. The default `null` would fail the check on
 *   a very common shape.
 * - `lineWidth: 0` disables folding. The default wraps at 80 columns, so a long
 *   `description:` would come back folded across lines and fail the check.
 */
const YAML_OUT = { nullStr: "", lineWidth: 0 } as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** Classify one parsed value, or `null` when it has no representable type. */
function classify(value: unknown): PropertyValue | null {
  if (typeof value === "boolean") return { kind: "checkbox", value };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "number", value } : null;
  }
  if (typeof value === "string") {
    // A multi-line value (a block scalar) actually SURVIVES the reversibility
    // check — yaml re-emits `note: |` byte-exact — so this exclusion is
    // deliberate, not incidental. A typed row is a single-line control, and
    // showing a two-line value in one would eat the newlines the moment the user
    // touched it: a silent edit to a value they did not mean to change. Raw mode
    // shows it whole and editable instead.
    if (value.includes("\n")) return null;
    if (DATE.test(value)) return { kind: "date", value };
    if (DATETIME.test(value)) return { kind: "datetime", value };
    return { kind: "text", value };
  }
  // An unset property (`key:`) is an empty text value. The reverse mapping in
  // `toPlain` writes "" back as YAML's empty value, so `key:` survives; a source
  // that spells it `key: ""` re-serializes differently and lands in raw mode.
  if (value === null || value === undefined) return { kind: "text", value: "" };
  if (Array.isArray(value)) {
    // Lists are lists *of text*. A mixed-type list would need per-item typing to
    // put back, so it is not representable — raw mode, per the design.
    if (!value.every((item) => typeof item === "string")) return null;
    return { kind: "list", value: [...value] };
  }
  return null; // nested map, date object, anything else
}

/** The plain JS value a `PropertyValue` serializes from. */
function toPlain(value: PropertyValue): unknown {
  // See `classify`: "" is the unset property, written by `nullStr` as `key:`.
  if (value.kind === "text" && value.value === "") return null;
  return value.value;
}

/** The block payload (no delimiters) for a set of properties. */
export function serializeInner(properties: Property[], format: FrontMatterFormat): string {
  if (format !== "yaml") {
    throw new Error(`serializeInner: ${format} is not supported yet`);
  }
  if (properties.length === 0) return "";
  const plain: Record<string, unknown> = {};
  for (const { key, value } of properties) {
    // A duplicate key would overwrite the earlier property and the block would
    // come out one property short — a silent deletion, so it is an error here
    // rather than a shrug. The strip refuses the rename before reaching this,
    // and this is the backstop for every other caller.
    if (Object.prototype.hasOwnProperty.call(plain, key)) {
      throw new Error(`serializeInner: duplicate property "${key}"`);
    }
    plain[key] = toPlain(value);
  }
  return stringify(plain, YAML_OUT);
}

/** A complete block — delimiters included — for a set of properties. */
export function buildBlock(properties: Property[], format: FrontMatterFormat): string {
  if (format !== "yaml") {
    throw new Error(`buildBlock: ${format} is not supported yet`);
  }
  return `---\n${serializeInner(properties, format)}---\n`;
}

/**
 * Read a block as typed rows, or explain why it can only be shown raw.
 *
 * The order matters: parse, type every value, serialize back, and compare to the
 * ORIGINAL text. Only a block that survives all four is editable.
 */
export function readProperties(fm: FrontMatter): PropertyView {
  if (fm.format !== "yaml") {
    return { mode: "raw", reason: `${fm.format.toUpperCase()} properties are shown as text for now` };
  }

  let parsed: unknown;
  try {
    parsed = parse(fm.inner);
  } catch {
    // Duplicate keys land here too — `yaml` rejects them, and so should we.
    return { mode: "raw", reason: "this block is not valid YAML" };
  }

  // An empty block is zero properties, not an unreadable one — the strip shows
  // an empty list and (from step 4) an Add property button.
  if (parsed === null || parsed === undefined) {
    return fm.inner.trim() === ""
      ? { mode: "typed", properties: [] }
      : { mode: "raw", reason: "this block has no properties to show" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { mode: "raw", reason: "this block is not a set of properties" };
  }

  const properties: Property[] = [];
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const value = classify(raw);
    if (value === null) {
      return { mode: "raw", reason: `"${key}" holds a value Toril cannot edit safely` };
    }
    properties.push({ key, value });
  }

  // THE CHECK. Equal means this exact text is what our serializer produces, so
  // writing it back after an edit cannot reformat anything the user did not
  // touch. Unequal means we would rewrite bytes on save — raw mode instead.
  if (serializeInner(properties, "yaml") !== fm.inner) {
    return { mode: "raw", reason: "Toril would have to reformat this block to edit it" };
  }

  return { mode: "typed", properties };
}
