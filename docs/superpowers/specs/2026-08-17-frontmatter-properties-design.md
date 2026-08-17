# Design — Front Matter Properties

**Branch:** `feat/frontmatter-properties`
**Date:** 2026-08-17
**Roadmap:** Movement II, branch 10 — see `ROADMAP.md`. **Pulled forward** (see below).

## Why this jumps the queue

Front matter is not "deferred, not yet lossless" (CLAUDE.md §0). It is **actively
corrupted today**, and the corruption is silent. There is no front-matter plugin
in the Milkdown stack, so an Obsidian-style block parses as *thematic break →
paragraph → bullet list → thematic break*:

```
in    ---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ndraft: true\n---
out   ---\n\ntitle: My Note\ntags:\n\n- alpha\n- beta\n  draft: true\n\n---
```

`draft: true` is absorbed as a lazy continuation **inside the `- beta` list
item**, which makes the block invalid YAML on reopen — a property vanishes.
Verified in the real app on Windows 2026-08-17, and reproducible headlessly.
`tests/roundtrip.test.ts` has no front-matter fixture, so CI is green straight
through it.

Every note with properties in an Obsidian vault is damaged by open → edit → save.
That makes this a §3 data-safety fix that happens to carry a UI, not a Movement
II convenience — so it goes before vault search and wikilinks rather than after.

## Goal

1. **Stop the corruption.** Front matter never reaches the ProseMirror doc.
2. **Edit it comfortably** — a collapsible properties strip above the writing
   surface, Obsidian's shape: typed key/value rows.
3. **Obsidian-compatible first**, with TOML (`+++`) and JSON also supported, and
   the document's own format preserved rather than converted behind the user's back.

Owner decisions (2026-08-17): strip at the top of the editor column, not a rail
tab; typed rows with a raw fallback; all three formats in this branch.

## Approach: split at the boundary, never in the schema

Front matter is **not markdown** — it is a foreign block that happens to sit in a
markdown file. So it is split off before the editor sees it and rejoined after,
rather than modelled as a Milkdown node.

```
file bytes ──split──► { block, body } ──► body   ──► markdownToDoc  ──► doc
                                          block  ──► properties strip

doc ──► docToMarkdown ──► body ──join──► file bytes
                          block ◄── properties strip
```

**`tab.content` stays the whole file, always.** The split lives inside
`loadIntoEditor` / `serializeEditor` only. Everything downstream — merge base,
3-way merge, snapshots, recovery journal, session, export — keeps operating on
complete bytes and needs no changes. This is the single most important structural
decision here; violating it would fork the meaning of "content" across half the
app.

Rejected: **a Milkdown `$node` for the block.** It would put YAML inside the
ProseMirror doc, needing a custom `toMarkdown`/`parseMarkdown` (the §0 lesson) and
sharing undo history with prose — and the user asked for a panel, which a node
does not give. The whole defect is that front matter is being treated as
document content; making it a node repeats that mistake in a nicer form.

## Preservation policy (the §3 core)

Two rules, in order:

1. **Untouched front matter is re-emitted byte-exact.** `join(split(x))` must
   equal `x` for every input, including inputs we cannot parse. The splitter
   carries the raw text and its exact delimiters; parsing is only for display.
2. **A block is only offered as typed rows when we can prove we can put it back.**
   Parse → re-serialize → compare to the original. Equal ⇒ typed rows are safe,
   because the serializer demonstrably reproduces this exact text. Unequal ⇒ the
   strip shows **raw mode** (a plain text box over the original bytes) and says
   why.

Rule 2 is what makes the feature safe without a comment-preserving CST. It fails
*closed*: an anchor, a block scalar, an unusual quoting style, a stray comment —
anything we would reformat — is detected by construction rather than enumerated
in advance. It also gives an honest canonical form: Obsidian's own writes must
pass the check, or the feature is useless in the vaults it targets, so the
serializer options are tuned until they do (the same discipline as
`src/editor/canonical.ts` for markdown).

### The split carries three pieces, not two (added in step 1)

`SplitFile` is `{ bom, frontMatter, body }`, and the block itself carries a
**`gap`** — the whitespace-only lines between the closing delimiter and the first
body line. Both exist because the editor would otherwise eat them:

- **`gap`**: the editor drops leading blank lines from a document, so the
  `---\n\n# Heading` shape Obsidian writes would come back with the body glued to
  the closer — a one-line diff on *every* note in a vault on first save.
- **`bom`**: a UTF-8 BOM is common in Windows-authored files (§1). Held apart from
  both sides it survives byte-exact and, as a bonus, stops being document content
  the way it is today.

Neither belongs to the block or the body, so they are named rather than smuggled
into one of them, and both are pinned in the gate.

## Format detection

Must agree with the Rust side. `crates/mdhtml` and `crates/mdrtf` already own
this decision for export (`opens_with_front_matter`), and comrak's
`front_matter_delimiter` is unconditional — so a *disagreement* between the TS
splitter and those guards means export silently deletes a document's opening
section. Mirror their discriminator exactly and pin the same fixtures on both
sides, each commented pointing at the other.

| Format | Opens with | Closes with | Notes |
|---|---|---|---|
| YAML | `---` + non-blank next line | `---` **only** | Obsidian/Jekyll |
| TOML | `+++` | `+++` | Hugo/Zola |
| JSON | `{` at byte 0 | matching `}` on its own line | Hugo. Brace scan must respect strings and escapes |

Hard rules, all of which have a fixture:

- Position 0 only, modulo a UTF-8 BOM (`mdrtf` has the BOM test; copy it).
- `---` followed by a **blank line is a thematic break**, not front matter. Toril's
  own canonical thematic break is `---`, so this case is common, not exotic.
- **No closing delimiter ⇒ no front matter.** Never let an unterminated opener
  swallow the document to the next `---`.
- An empty block (`---\n---\n`) is front matter with zero properties, not absence.

**Amended in step 1 (2026-08-17): `...` is not accepted as a closer.** The table
originally allowed YAML's document-end marker. comrak was probed directly, and it
renders `---\ntitle: x\n...\n` as a rule plus a paragraph — `...` is ordinary text
to the export path. Accepting it here would mean the strip showing typed
properties for a block that export renders as prose, which is precisely the
desynchronization the parity rule forbids. The probe also settled the
unterminated-opener case in our favour: with no closing `---`, comrak abandons the
front-matter read rather than swallowing to EOF, so "no closer ⇒ no front matter"
needs no change on the Rust side. Both behaviours were previously unpinned and now
have tests in `mdhtml` **and** `mdrtf`
(`an_unterminated_opener_keeps_the_whole_document`,
`a_yaml_document_end_marker_does_not_close_front_matter`).

## Files

| File | Change |
|---|---|
| `src/editor/frontmatter.ts` | **New.** The ONE splitter/joiner: `detectFormat`, `splitFrontMatter`, `joinFrontMatter`. No dependencies, no DOM. |
| `src/editor/frontmatter-values.ts` | **New.** Typed model ⇄ block text per format, plus the reversibility check. Where `yaml` / `smol-toml` are used. |
| `src/ui/properties.ts` | **New.** The collapsible strip: typed rows, raw fallback, format badge. |
| `src/main.ts` | `loadIntoEditor` / `serializeEditor` gain the split/join; property edits mark dirty through the same path as editor edits (mind `LoadEcho` — arm it with the *body*, not the file). |
| `app.html` | `<section id="properties">` in `#main`, between `#conflictbar` and `#editor`. |
| `src/styles/chrome.css` | Strip styling. §12b applies: it is a flex row in the `#main` column, `min-height: 0`, and it must not animate around `display:none`. |
| `src-tauri/src/settings.rs` + `src/ipc.ts` | `properties_expanded: Option<bool>`. |
| `tests/frontmatter.test.ts` | **New gate.** |
| `tests/roundtrip.test.ts` | **Closes the §0 to-do:** front-matter fixtures, run through split → editor → join. |
| `tests/properties.test.ts` | **New gate.** Panel behaviour in jsdom. |

## Typed model

Obsidian's property types, and no more: `text`, `list` (of text), `number`,
`checkbox`, `date`, `datetime`. Anything else — nested maps, mixed-type lists —
fails the reversibility check and lands in raw mode, which is the correct answer
rather than a limitation to apologise for.

```ts
type PropertyValue =
  | { kind: "text"; value: string }
  | { kind: "list"; value: string[] }
  | { kind: "number"; value: number }
  | { kind: "checkbox"; value: boolean }
  | { kind: "date"; value: string }      // ISO 8601, kept as text — never a Date
  | { kind: "datetime"; value: string };

interface Property { key: string; value: PropertyValue }
```

Dates stay strings. Round-tripping through `Date` re-formats and applies a
timezone, i.e. edits a value nobody edited.

## Dependencies (§2 — vetted 2026-08-17)

| Package | Version | License | Deps | Last publish | Deprecated |
|---|---|---|---|---|---|
| `yaml` (eemeli) | 2.9.0 | ISC | none | 2026-05 | no |
| `smol-toml` | 1.8.0 | BSD-3 | none | 2026-08 | no |

Both are zero-dependency and actively published. JSON needs nothing. Pin exact
versions per §2. Re-check at adoption — this table is a snapshot, not a warrant.

## Gate

`tests/frontmatter.test.ts`:
- `join(split(x)) === x` for every fixture, **including unparseable blocks** — the
  property that makes rule 1 real. Worth a randomized case or two.
- Detection: each of the three formats; `---`+blank = thematic break; no closer;
  BOM; empty block; `{` mid-file is not JSON front matter.
- Reversibility: an Obsidian-authored block passes and yields typed rows; a block
  with a comment fails and yields raw mode.
- Editing one property leaves the others' text untouched.
- The Rust-parity fixtures, mirroring `mdhtml`/`mdrtf`'s `opens_with_front_matter`.

`tests/roundtrip.test.ts`: a `frontMatter` class asserting
`join(block, roundtrip(body)) === input` — this is the gate item CLAUDE.md §8 has
carried as "add when it lands" since Phase 3.

`tests/properties.test.ts`: rows render from a parsed block; editing marks dirty;
raw mode appears for an unrepresentable block; the strip is absent for `.html`
tabs; collapse state persists.

## Sequence (each step commits green)

1. Splitter + join + detection + gate. **Ships the data-safety fix on its own** —
   at this point front matter survives untouched with no UI at all, which is
   already the most valuable half.
2. Wire into `loadIntoEditor` / `serializeEditor`; round-trip fixtures.
3. Read-only strip: show the properties, collapsed by default when absent.
4. Typed editing + raw fallback.
5. TOML + JSON.
6. On-device: open a real vault note with properties, edit, save, reopen in
   Obsidian and confirm the file is unchanged where it should be.

## Open questions

- **Adding front matter to a note that has none** — the strip needs an "add
  property" affordance, and the resulting block should be written in the vault's
  prevailing format. Defaulting to YAML is right; detecting a vault-wide default
  is out of scope here.
- **Format conversion between YAML/TOML/JSON** is deliberately *not* automatic.
  Offer it as an explicit action later; converting on save would be exactly the
  unrequested rewrite this branch exists to stop.
- **Word count** now excludes front matter (it is no longer in the doc). That
  seems right, but it is a visible change to the status bar.
