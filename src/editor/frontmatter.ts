// The ONE front-matter splitter/joiner. No dependencies, no DOM, no IPC — the
// `paths.ts` / `sync.ts` precedent, so the gate runs headlessly.
//
// Front matter is *not markdown*: it is a foreign block that happens to sit at
// the top of a markdown file. Toril has no front-matter plugin, so today an
// Obsidian block reaches ProseMirror as thematic break → paragraph → bullet list
// → thematic break, and a trailing key is absorbed as a lazy continuation inside
// the previous list item — invalid YAML on reopen, so a property silently
// vanishes (CLAUDE.md §3). The fix is to split the block off *before* the editor
// sees it and rejoin it after, never to model it in the schema.
//
// `tab.content` stays the whole file. This split lives only inside
// `loadIntoEditor` / `serializeEditor`, so merge, snapshots, recovery, session
// and export keep operating on complete bytes.
//
// **Rule 1 (§3):** `joinFrontMatter(splitFrontMatter(x)) === x` for every input,
// including blocks we cannot parse. Nothing here parses anything — the block is
// carried as bytes, and `frontmatter-values.ts` is the only place a parser runs.

/** U+FEFF, built from its code point so the source carries no invisible char. */
const BOM = String.fromCharCode(0xfeff);

export type FrontMatterFormat = "yaml" | "toml" | "json";

export interface FrontMatter {
  format: FrontMatterFormat;
  /**
   * The block byte-exact: the opening delimiter through the closing delimiter's
   * line terminator. Concatenating this back is what makes rule 1 hold.
   */
  text: string;
  /**
   * The payload a parser for `format` accepts. For YAML and TOML that is the
   * text *between* the delimiter lines; for JSON the delimiters are the object's
   * own braces, so `inner` is the object itself. Display and typed editing only.
   */
  inner: string;
  /**
   * The whitespace-only lines between the closing delimiter and the first line
   * of the body, byte-exact.
   *
   * They belong to neither side, and they have to be kept *somewhere*: the
   * editor drops leading blank lines from a document, so a block followed by a
   * blank line (the shape Obsidian writes) would otherwise come back with the
   * body glued to the closer and every note in a vault would show a one-line
   * diff on first save.
   */
  gap: string;
}

export interface SplitFile {
  /**
   * A UTF-8 BOM if the file opened with one, else `""`. Kept out of both the
   * block and the body — common in Windows-authored files (§1), and it would
   * otherwise hide a real `---` opener *and* enter the document as content.
   */
  bom: string;
  frontMatter: FrontMatter | null;
  /** Everything after the block and its gap. The only part the editor sees. */
  body: string;
}

interface Line {
  /** The line without its terminator. */
  content: string;
  /** `"\r\n"`, `"\n"`, or `""` at a final line with no terminator. */
  terminator: string;
  /** Index just past the terminator — where the next line starts. */
  end: number;
}

/** Read the line starting at `start`, preserving its exact terminator. */
function readLine(text: string, start: number): Line {
  const nl = text.indexOf("\n", start);
  if (nl === -1) {
    return { content: text.slice(start), terminator: "", end: text.length };
  }
  const crlf = nl > start && text[nl - 1] === "\r";
  return {
    content: text.slice(start, crlf ? nl - 1 : nl),
    terminator: crlf ? "\r\n" : "\n",
    end: nl + 1,
  };
}

interface Span {
  /** Where the payload starts (past the opening delimiter line). */
  innerStart: number;
  /** Where the payload ends (at the start of the closing delimiter line). */
  innerEnd: number;
  /** Index just past the closing delimiter's line terminator. */
  end: number;
}

/**
 * Find a `delimiter`-fenced block at position 0.
 *
 * `requireNonBlankSecondLine` is the YAML discriminator, and it is the whole
 * reason this is not a two-line function: Toril's canonical thematic break is
 * `---` (`canonical.ts`), so a note opening with a horizontal rule must not be
 * read as front matter and have its first section swallowed. `---` followed by a
 * blank line is a thematic break and is never valid front matter; `---`
 * immediately followed by text is indistinguishable from the real thing, and is
 * what Obsidian and Jekyll read it as too.
 *
 * **This mirrors `opens_with_front_matter` in `crates/mdhtml` and
 * `crates/mdrtf`** (which gate comrak's unconditional `front_matter_delimiter`
 * for export). Those two and this must agree exactly: if this keeps a block in
 * the body that export treats as front matter, export deletes the document's
 * opening section. The `rust parity` fixtures in `tests/frontmatter.test.ts` and
 * the front-matter tests in both crates pin the same cases from both directions.
 *
 * A missing closing delimiter means **no front matter**, so an unterminated
 * opener can never swallow the document down to the next `---`.
 */
function scanFenced(text: string, delimiter: string, requireNonBlankSecondLine: boolean): Span | null {
  const opener = readLine(text, 0);
  if (opener.content.trimEnd() !== delimiter) return null;
  // No terminator means the opener is the entire file, so there is no closer.
  if (opener.terminator === "") return null;

  const innerStart = opener.end;
  if (requireNonBlankSecondLine && readLine(text, innerStart).content.trim() === "") {
    return null;
  }

  let pos = innerStart;
  while (pos < text.length) {
    const line = readLine(text, pos);
    if (line.content.trimEnd() === delimiter) {
      return { innerStart, innerEnd: pos, end: line.end };
    }
    // A final line with no terminator cannot be followed by anything.
    if (line.terminator === "") break;
    pos = line.end;
  }
  return null;
}

/**
 * Find a JSON object at position 0, closing on a `}` that is the last non-blank
 * character of its line (Hugo's shape).
 *
 * The brace scan honours strings and escapes, so a `}` inside a value does not
 * end the block. Balance alone is not enough: without the end-of-line rule, an
 * ordinary note that happens to start with `{` would take an arbitrary prefix of
 * the prose as front matter.
 */
function scanJson(text: string): Span | null {
  if (text[0] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let close = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const nl = text.indexOf("\n", close);
  const tail = nl === -1 ? text.slice(close + 1) : text.slice(close + 1, nl);
  if (tail.trim() !== "") return null;

  // The braces are part of the payload a JSON parser needs, so `inner` spans
  // them; `text` runs to the end of the closing line like the fenced formats.
  return { innerStart: 0, innerEnd: close + 1, end: nl === -1 ? text.length : nl + 1 };
}

/** Index of the first line at or after `start` that is not whitespace-only. */
function endOfGap(text: string, start: number): number {
  let pos = start;
  for (;;) {
    if (pos >= text.length) return pos;
    const line = readLine(text, pos);
    if (line.content.trim() !== "") return pos;
    if (line.terminator === "") return text.length;
    pos = line.end;
  }
}

/**
 * Split a file into its BOM, its front-matter block (if any) and the markdown
 * body. Lossless by construction — see rule 1 in the module header.
 */
export function splitFrontMatter(file: string): SplitFile {
  const bom = file.startsWith(BOM) ? BOM : "";
  const rest = bom === "" ? file : file.slice(BOM.length);

  const candidates: ReadonlyArray<[FrontMatterFormat, () => Span | null]> = [
    // YAML is the only format the export path recognises, so it is tried first;
    // the openers are mutually exclusive anyway.
    ["yaml", () => scanFenced(rest, "---", true)],
    // `+++` has no meaning in markdown, so there is no rule/front-matter
    // ambiguity to guard against and a blank first line is allowed.
    ["toml", () => scanFenced(rest, "+++", false)],
    ["json", () => scanJson(rest)],
  ];

  for (const [format, scan] of candidates) {
    const span = scan();
    if (span === null) continue;
    const gapEnd = endOfGap(rest, span.end);
    return {
      bom,
      frontMatter: {
        format,
        text: rest.slice(0, span.end),
        inner: rest.slice(span.innerStart, span.innerEnd),
        gap: rest.slice(span.end, gapEnd),
      },
      body: rest.slice(gapEnd),
    };
  }

  return { bom, frontMatter: null, body: rest };
}

/**
 * Rejoin what `splitFrontMatter` separated, with `body` free to have been
 * through the editor. Pass a modified block by spreading the split:
 * `joinFrontMatter({ ...split, body: serialized })`.
 */
export function joinFrontMatter(split: SplitFile): string {
  const { bom, frontMatter, body } = split;
  if (frontMatter === null) return bom + body;

  // `splitFrontMatter` only ever omits the terminator at EOF, where gap and body
  // are both empty, so this cannot fire on a round trip — it guards a block
  // *rebuilt* by the properties strip. Gluing the closer to the first body line
  // would make the block unparseable and eat a heading, which is precisely the
  // corruption this module exists to stop.
  const needsTerminator =
    !frontMatter.text.endsWith("\n") && (frontMatter.gap !== "" || body !== "");
  const block = needsTerminator ? `${frontMatter.text}\n` : frontMatter.text;

  return bom + block + frontMatter.gap + body;
}

/**
 * The format of the block `splitFrontMatter` would find, or `null` for none.
 * Defined in terms of the splitter so the two can never disagree.
 */
export function detectFormat(file: string): FrontMatterFormat | null {
  return splitFrontMatter(file).frontMatter?.format ?? null;
}
