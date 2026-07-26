// Pure reconciliation policy (CLAUDE.md §3, ROADMAP Movement I.4).
//
// No DOM and no IPC, so the gate runs headlessly — the `toolbar.ts` precedent.
// `merge_external` reports what IS; this module decides what to DO, which keeps
// the "HTML never auto-merges" rule in exactly one place.
import type { MergeReport } from "./ipc";
import type { DivergedState, DocFormat } from "./ui/tabs";

export type SyncAction =
  | { kind: "none" }
  | { kind: "reload"; theirs: string }
  | { kind: "applyMerge"; merged: string; theirs: string; clean: boolean }
  | { kind: "conflict"; theirs: string; message: string };

/**
 * The bytes that stand for "my side" of the three-way merge.
 *
 * A tab that is not dirty has no edits *by definition*, so its side of the merge
 * is the merge base — never the buffer. That distinction is not cosmetic: for the
 * active tab the buffer is the live Milkdown document, and re-serializing it
 * reproduces Toril's canonical form, which for sixteen construct classes pinned
 * in `tests/roundtrip.test.ts` (CRLF endings, `*` bullets, setext headings, bare
 * autolinks, …) is *not* byte-identical to the file on disk. Feeding that to
 * `merge3` makes `mine != base` with zero user edits, so an untouched
 * Windows-authored note conflicts the moment OneDrive touches it, and an
 * untouched `*`-bulleted vault note gets a whole-file reformat merged into its
 * buffer and then written out by the next autosave tick. Comparing `base`
 * against disk short-circuits `merge3` to `TheirsOnly` and the reload is
 * byte-exact.
 *
 * `liveBuffer` returns the serialized editor for the active tab and `null` for
 * any other, and is only consulted when the tab is dirty — a clean tab never
 * pays for a serialization it must not use.
 */
export function selectMine(
  tab: { dirty: boolean; base: string; content: string },
  liveBuffer: () => string | null,
): string {
  if (!tab.dirty) return tab.base;
  return liveBuffer() ?? tab.content;
}

/**
 * Map a merge report onto an action. Total over every outcome, and fails closed:
 * anything it cannot safely apply becomes a conflict, which writes nothing.
 *
 * `dirty` is the third input the design (§5.8) calls for. With `selectMine`
 * feeding `merge3`, a clean tab can only ever produce `unchanged` or
 * `theirsOnly` — so the guard below is unreachable today and deliberately kept
 * anyway: it states the invariant *"a clean buffer has nothing to weigh against
 * disk, so disk simply wins"* in the one place policy lives, rather than leaving
 * it as an emergent property of how the caller happened to pick `mine`.
 */
export function decideAction(report: MergeReport, format: DocFormat, dirty: boolean): SyncAction {
  if (report.outcome === "unchanged") return { kind: "none" };

  // Every remaining outcome needs `theirs` — to reload, to set the new base, or
  // to park. A report without it is malformed; treat it as a conflict rather
  // than guessing, since a conflict never writes.
  const theirs = report.theirs;
  if (theirs === null) {
    return { kind: "conflict", theirs: "", message: "Changed on disk (could not read it)" };
  }

  // Checked after the malformed-report guard: an unreadable `theirs` still fails
  // closed, clean tab or not.
  if (!dirty) return { kind: "reload", theirs };

  if (report.outcome === "theirsOnly") return { kind: "reload", theirs };

  if (report.outcome === "merged") {
    // A line-level merge of two HTML documents can produce unbalanced tags,
    // which html-serializer.ts would then normalize on load — corrupting
    // silently. Markdown only (§2).
    if (format === "html") {
      return { kind: "conflict", theirs, message: "Changed on disk — HTML is not auto-merged" };
    }
    if (report.content === null) {
      return { kind: "conflict", theirs, message: "Changed on disk (merge produced nothing)" };
    }
    // If the merged result already equals disk, the buffer matches the file and
    // there is nothing left to save — mark it clean, or the tab sits dirty with
    // no pending change, which reads as a bug.
    return {
      kind: "applyMerge",
      merged: report.content,
      theirs,
      clean: report.content === theirs,
    };
  }

  return { kind: "conflict", theirs, message: "Changed on disk while you were editing" };
}

/** True while a tab must not be written. */
export function blocksWrite(tab: { diverged: DivergedState | null }): boolean {
  return tab.diverged !== null;
}

/** The tab fields every bulk-write selector reads. */
interface SavableLike {
  dirty: boolean;
  path: string | null;
  diverged: DivergedState | null;
  removedOnDisk: boolean;
}

/**
 * Dirty, path-backed, non-diverged, still-on-disk tabs — the only ones Save All
 * or autosave may write.
 *
 * Two exclusions, for two different reasons.
 *
 * **Diverged**: Save All is the real clobber vector — it loops every dirty tab,
 * so a background tab that diverged an hour ago would otherwise be overwritten
 * with no prompt ever shown (§5.5).
 *
 * **Removed on disk**: recreating a vanished file is a *creation*, and neither
 * bulk writer is aimed at it. An Obsidian rename is a delete followed by a
 * create, so the losing tab is marked `removedOnDisk` **and forced dirty** (the
 * buffer is the only copy left) — which puts it in the Save All set even though
 * the user never touched it. Ctrl+Alt+S while working on some other document
 * would then resurrect the old note beside the renamed one and the sync client
 * would propagate the duplicate everywhere. Save All being *explicit* does not
 * carry: it is a bulk convenience keystroke usually aimed at a different tab. A
 * focused File → Save still recreates the file — it goes through `persistActive`,
 * not through here.
 */
export function selectSavable<T extends SavableLike>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.dirty && t.path !== null && !blocksWrite(t) && !t.removedOnDisk);
}

/** Dirty, path-backed tabs held back by `selectSavable` because their file is gone. */
export function selectRemovedOnDisk<T extends SavableLike>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.dirty && t.path !== null && t.removedOnDisk);
}

/**
 * The Save All status line. Every exclusion is named, because "Saved 3 files"
 * while a fourth was silently refused is the quiet half-success this whole
 * feature exists to prevent — and a removal in particular needs to say what the
 * user can *do* about it, or the exclusion just looks like a lost save.
 */
export function describeSaveAll(
  saved: number,
  blocked: number,
  removedNames: readonly string[],
): string {
  const parts: string[] = [];
  if (saved > 0) parts.push(`Saved ${saved} file${saved === 1 ? "" : "s"}`);
  if (blocked > 0) parts.push(`skipped ${blocked} changed on disk`);
  if (removedNames.length > 0) {
    const shown = removedNames.slice(0, 3).join(", ");
    const rest = removedNames.length > 3 ? ` and ${removedNames.length - 3} more` : "";
    parts.push(`skipped ${shown}${rest}: removed on disk, open it and Save to recreate`);
  }
  return parts.join(" — ");
}
