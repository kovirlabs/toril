// Verified escape minimization for the canonical serializer (CLAUDE.md §3.2).
//
// remark-stringify escapes defensively: every `[`, `*`, `_`, `~` in prose gets a
// backslash whether or not it could ever be read as syntax. That is safe but it
// rewrites the user's file — and for Obsidian vaults it is *destructive*:
// `[[Note]]` becomes `\[\[Note]]`, which Obsidian renders as literal text, so
// every wikilink, image embed (`![[x.png]]`) and callout (`> [!tip]`) in an
// edited note silently breaks.
//
// This module removes the escapes that are not needed, and it decides "not
// needed" by **proof, not by rule**: a removal is kept only if the candidate
// markdown parses to exactly the same document as the fully escaped output. The
// escaping rules of CommonMark + GFM (flanking delimiter runs, reference labels,
// task-list markers, list bullets at line start, autolink-literal boundaries…)
// are never re-implemented here, so they cannot be re-implemented wrongly. The
// worst a bug in candidate extraction can do is cost a parse.
//
// Pure — no DOM, no Milkdown — so the search is gated headlessly with a fake
// `sameDoc` (tests/escapes.test.ts); `serializer.ts` supplies the real parser.

/** One removable piece of the serializer's output: the indices to delete. */
interface Candidate {
  readonly drop: readonly number[];
}

/**
 * Upper bound on whole-document parses in the fallback search. It only bounds
 * pathological input — anything not yet verified when it is hit keeps its
 * escape, which is always safe.
 */
const MAX_PARSES = 64;

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

// `<https://…>`, `<mailto:…>`, `<www.…>` and `<a@b.c>` — the forms remark emits
// for a link whose text equals its URL. Removing both brackets yields the bare
// form Obsidian writes; GFM's autolink-literal parse decides if that holds.
const AUTOLINK = /<((?:https?:\/\/|mailto:|www\.)[^\s<>]+|[^\s@<>]+@[^\s@<>]+\.[^\s<>]+)>/g;

// A fence opener/closer, allowing for blockquote and list-item prefixes.
const FENCE = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;

/**
 * Collect candidate removals outside code. Code is skipped only to save parses:
 * a backslash inside a code span or fence is content, so removing it would be
 * rejected by verification anyway.
 */
export function findCandidates(md: string): Candidate[] {
  const out: Candidate[] = [];
  let fence: string | null = null;
  let lineStart = 0;

  for (const line of md.split("\n")) {
    const m = FENCE.exec(line);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
    } else {
      scanLine(line, lineStart, out);
    }
    lineStart += line.length + 1;
  }
  return out;
}

function scanLine(line: string, offset: number, out: Candidate[]): void {
  const code = codeSpans(line);
  const inCode = (i: number): boolean => code.some(([s, e]) => i >= s && i < e);

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "\\") continue;
    const next = line[i + 1];
    if (next === undefined || !ASCII_PUNCT.test(next)) continue;
    if (!inCode(i) && next !== "\\") out.push({ drop: [offset + i] });
    i++; // the escaped character is consumed either way (`\\` pairs too)
  }

  AUTOLINK.lastIndex = 0;
  for (let m = AUTOLINK.exec(line); m !== null; m = AUTOLINK.exec(line)) {
    const start = m.index;
    const end = start + m[0].length - 1;
    if (inCode(start) || line[start - 1] === "\\") continue;
    out.push({ drop: [offset + start, offset + end] });
  }
}

/** [start, end) of each inline code span on a line (backtick runs of equal length). */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`" || (i > 0 && line[i - 1] === "\\")) {
      i++;
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    const run = "`".repeat(n);
    let j = line.indexOf(run, i + n);
    while (j !== -1 && (line[j + n] === "`" || line[j - 1] === "`")) {
      j = line.indexOf(run, j + 1);
    }
    if (j === -1) {
      i += n;
      continue;
    }
    spans.push([i, j + n]);
    i = j + n;
  }
  return spans;
}

function apply(md: string, candidates: readonly Candidate[], chosen: Iterable<number>): string {
  const drop = new Set<number>();
  for (const c of chosen) for (const i of candidates[c].drop) drop.add(i);
  if (drop.size === 0) return md;
  let s = "";
  for (let i = 0; i < md.length; i++) if (!drop.has(i)) s += md[i];
  return s;
}

/**
 * Remove every candidate whose removal `same` accepts, verifying each accepted
 * group *jointly* with all previously accepted ones — so interacting removals
 * (`\*a\*`: either star alone is literal, both together are emphasis) can never
 * both slip through. Groups are bisected on failure; once `budget` parses are
 * spent, everything still unverified keeps its escape, which is always safe.
 */
function search(md: string, same: (candidate: string) => boolean, budget: number): string {
  const candidates = findCandidates(md);
  if (candidates.length === 0) return md;

  const accepted: number[] = [];
  let parses = 0;
  const test = (group: readonly number[]): boolean => {
    if (parses >= budget) return false;
    parses++;
    try {
      return same(apply(md, candidates, [...accepted, ...group]));
    } catch {
      return false; // a parser failure is never evidence of equality
    }
  };
  const bisect = (group: readonly number[]): void => {
    if (group.length === 0) return;
    if (test(group)) {
      accepted.push(...group);
      return;
    }
    if (group.length === 1) return;
    const mid = group.length >> 1;
    bisect(group.slice(0, mid));
    bisect(group.slice(mid));
  };
  bisect(candidates.map((_, i) => i));
  return apply(md, candidates, accepted);
}

/**
 * Split markdown into top-level blocks at blank lines outside fences, keeping
 * every separator so `join("")` reproduces the input exactly. A block is a
 * *unit of cheap verification*, not a claim that blocks parse independently —
 * they do not always (loose lists, reference definitions), which is why the
 * whole document is verified again afterwards.
 */
export function splitBlocks(md: string): string[] {
  const parts: string[] = [];
  let fence: string | null = null;
  let current = "";
  let blank = false;
  for (const line of md.split(/(?<=\n)/)) {
    const isBlank = fence === null && /^[ \t]*\n?$/.test(line);
    if (isBlank !== blank && current !== "") {
      parts.push(current);
      current = "";
    }
    blank = isBlank;
    current += line;
    const m = FENCE.exec(line);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/** Budgets: per block (small parses), and for the whole-document fallback. */
const BLOCK_PARSES = 24;

// Block → minimized block. Minimizing a block depends only on its own text (it
// is verified standalone, against itself), so between keystrokes every block but
// the one being edited is a cache hit and costs no parse at all.
const blockCache = new Map<string, string>();
const BLOCK_CACHE_MAX = 2000;

/**
 * Return `md` with every escape (and autolink bracket pair) removed that can be
 * removed without changing the parsed document.
 *
 * `same(candidate, reference)` must answer whether `candidate` parses to the
 * same document as `reference`. Two passes:
 *
 * 1. **Per block**, each block verified standalone against its own escaped text
 *    — small parses, memoized.
 * 2. **Whole document**, one parse: the joined result against `md`. This is the
 *    proof that matters; pass 1 only proposes. If it fails (a block whose
 *    meaning depends on another — a `[label]` that a definition elsewhere turns
 *    into a link, a loose list split across blocks), fall back to searching the
 *    whole document directly, within `MAX_PARSES`.
 */
export function minimizeEscapes(md: string, same: (candidate: string, reference: string) => boolean): string {
  if (findCandidates(md).length === 0) return md;

  const blocks = splitBlocks(md).map((block) => {
    const hit = blockCache.get(block);
    if (hit !== undefined) return hit;
    const minimized = search(block, (c) => same(c, block), BLOCK_PARSES);
    if (blockCache.size >= BLOCK_CACHE_MAX) blockCache.clear();
    blockCache.set(block, minimized);
    return minimized;
  });
  const joined = blocks.join("");
  if (joined === md) return md;

  try {
    if (same(joined, md)) return joined;
  } catch {
    // fall through to the whole-document search
  }
  return search(md, (c) => same(c, md), MAX_PARSES);
}
