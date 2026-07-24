// Line-level diff for the version-history panel (CLAUDE.md §4). Pure and
// display-only: it renders "what changed" between a stored version and the
// current buffer. Restore always uses whole content, so this diff never has to
// be authoritative — it only has to read well. Classic LCS backtrack; notes are
// small, so O(n·m) is fine.

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Split into lines, treating "" as zero lines so `"" → "x"` reads as one add. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Line diff from `oldText` to `newText`: `del` lines are only in old, `add` only
 * in new, `same` in both. Order follows the new text with deletions interleaved
 * at their original position.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "del", text: a[i] });
      i++;
    } else {
      out.push({ op: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ op: "del", text: a[i++] });
  while (j < n) out.push({ op: "add", text: b[j++] });
  return out;
}
