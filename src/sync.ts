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
 * Map a merge report onto an action. Total over every outcome, and fails closed:
 * anything it cannot safely apply becomes a conflict, which writes nothing.
 */
export function decideAction(report: MergeReport, format: DocFormat): SyncAction {
  if (report.outcome === "unchanged") return { kind: "none" };

  // Every remaining outcome needs `theirs` — to reload, to set the new base, or
  // to park. A report without it is malformed; treat it as a conflict rather
  // than guessing, since a conflict never writes.
  const theirs = report.theirs;
  if (theirs === null) {
    return { kind: "conflict", theirs: "", message: "Changed on disk (could not read it)" };
  }

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

/**
 * Dirty, path-backed, non-diverged tabs — the only ones Save All or autosave
 * may write. Save All is the real clobber vector: it loops every dirty tab, so a
 * background tab that diverged an hour ago would otherwise be overwritten with
 * no prompt ever shown (§5.5).
 */
export function selectSavable<
  T extends { dirty: boolean; path: string | null; diverged: DivergedState | null },
>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.dirty && t.path !== null && !blocksWrite(t));
}
