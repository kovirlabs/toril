// GATE for external-change reconciliation (CLAUDE.md §3, ROADMAP I.4).
//
// The rule this file protects: a conflict must never silently overwrite either
// side. That decomposes into three testable properties —
//
//   1. the outcome→action mapping is total and HTML never auto-merges;
//   2. a diverged tab is excluded from every write path;
//   3. a resolution parks the losing side BEFORE anything is overwritten.
//
// …and, since the whole-branch review, a fourth: an *unedited* tab must never
// be treated as edited. `selectMine` is where that lives.
import { describe, expect, it } from "vitest";
import {
  blocksWrite,
  decideAction,
  describeSaveAll,
  selectMine,
  selectRemovedOnDisk,
  selectSavable,
} from "../src/sync";
import type { MergeReport } from "../src/ipc";
import type { DivergedState } from "../src/ui/tabs";

const report = (r: Partial<MergeReport> & Pick<MergeReport, "outcome">): MergeReport => ({
  content: null,
  theirs: null,
  ...r,
});

describe("decideAction", () => {
  it("does nothing when disk matches the base (this is where self-writes die)", () => {
    expect(decideAction(report({ outcome: "unchanged" }), "markdown", true)).toEqual({
      kind: "none",
    });
  });

  it("reloads when only disk moved", () => {
    const a = decideAction(report({ outcome: "theirsOnly", theirs: "disk\n" }), "markdown", true);
    expect(a).toEqual({ kind: "reload", theirs: "disk\n" });
  });

  it("applies a clean merge and keeps the tab dirty", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "merged\n", theirs: "disk\n" }),
      "markdown",
      true,
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "merged\n", theirs: "disk\n", clean: false });
  });

  it("marks the tab CLEAN when the merge result already equals disk", () => {
    // Convergent edit: without this the tab sits dirty with nothing to save,
    // which reads as a bug.
    const a = decideAction(
      report({ outcome: "merged", content: "same\n", theirs: "same\n" }),
      "markdown",
      true,
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "same\n", theirs: "same\n", clean: true });
  });

  it("never auto-merges HTML — a line merge can unbalance tags", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "<p>x</p>", theirs: "<p>y</p>" }),
      "html",
      true,
    );
    expect(a.kind).toBe("conflict");
  });

  it("raises a conflict when both sides changed the same region", () => {
    const a = decideAction(report({ outcome: "conflict", theirs: "disk\n" }), "markdown", true);
    expect(a.kind).toBe("conflict");
    if (a.kind === "conflict") expect(a.theirs).toBe("disk\n");
  });

  it("falls back to conflict rather than losing data if theirs is missing", () => {
    // Defensive: a malformed report must fail closed, never silently proceed.
    const a = decideAction(
      report({ outcome: "merged", content: "x\n", theirs: null }),
      "markdown",
      true,
    );
    expect(a.kind).toBe("conflict");
  });

  it("never merges or conflicts a tab with no unsaved edits — disk just wins", () => {
    // Unreachable while `selectMine` feeds the merge (a clean tab's `mine` IS
    // `base`, so merge3 can only answer unchanged/theirsOnly). Kept as the
    // policy statement: nothing in this module may hand a clean buffer an
    // applyMerge, which would put bytes the user never typed into the document
    // AND mark it dirty for the next autosave tick to write out.
    for (const r of [
      report({ outcome: "merged", content: "merged\n", theirs: "disk\n" }),
      report({ outcome: "conflict", theirs: "disk\n" }),
      report({ outcome: "theirsOnly", theirs: "disk\n" }),
    ]) {
      expect(decideAction(r, "markdown", false)).toEqual({ kind: "reload", theirs: "disk\n" });
    }
  });

  it("still fails closed on a malformed report even for a clean tab", () => {
    const a = decideAction(report({ outcome: "conflict", theirs: null }), "markdown", false);
    expect(a.kind).toBe("conflict");
  });
});

describe("selectMine — an unedited tab is never treated as edited", () => {
  // The bug this pins: for the ACTIVE tab, `mine` used to be a fresh canonical
  // serialization of the live document with no `dirty` check. Toril's canonical
  // form differs from disk for sixteen construct classes pinned in
  // roundtrip.test.ts, so `mine != base` with zero user edits — a Windows note
  // conflicts the moment OneDrive touches it, and a `*`-bulleted vault note gets
  // a whole-file reformat merged in and then autosaved.
  const tab = (dirty: boolean) => ({ dirty, base: "one\r\ntwo\r\n", content: "stale\n" });
  const canonical = (): string => "one\ntwo\n"; // what the editor would serialize

  it("uses the merge base for a clean tab, even when the editor would serialize differently", () => {
    expect(selectMine(tab(false), canonical)).toBe("one\r\ntwo\r\n");
  });

  it("never even consults the live buffer for a clean tab", () => {
    let calls = 0;
    selectMine(tab(false), () => {
      calls++;
      return canonical();
    });
    expect(calls).toBe(0);
  });

  it("uses the live editor for a dirty active tab", () => {
    expect(selectMine(tab(true), canonical)).toBe("one\ntwo\n");
  });

  it("uses the stored buffer for a dirty tab that is not on screen", () => {
    expect(selectMine(tab(true), () => null)).toBe("stale\n");
  });
});

interface Savable {
  name: string;
  dirty: boolean;
  path: string | null;
  diverged: DivergedState | null;
  removedOnDisk: boolean;
}

const savableTab = (over: Partial<Savable> = {}): Savable => ({
  name: "a.md",
  dirty: true,
  path: "/v/a.md",
  diverged: null,
  removedOnDisk: false,
  ...over,
});

describe("write gating", () => {
  it("blocks a write while diverged", () => {
    expect(blocksWrite(savableTab())).toBe(false);
    const diverged = savableTab({ diverged: { theirs: "x", reason: "conflict", message: "m" } });
    expect(blocksWrite(diverged)).toBe(true);
  });

  it("excludes diverged tabs from Save All and autosave", () => {
    const clean = savableTab({ dirty: false });
    const untitled = savableTab({ path: null });
    const diverged = savableTab({ diverged: { theirs: "x", reason: "conflict", message: "m" } });
    const savable = savableTab();

    const out = selectSavable([clean, untitled, diverged, savable]);
    expect(out).toEqual([savable]);
  });

  it("excludes a tab whose file was removed on disk — Save All must not resurrect it", () => {
    // An Obsidian rename is remove + create. The losing tab is forced dirty
    // (its buffer is the only copy left), so it lands in the Save All set with
    // no user action; writing it recreates the old note beside the new one and
    // the sync client propagates the duplicate.
    const removed = savableTab({ name: "Meeting.md", removedOnDisk: true });
    const savable = savableTab({ name: "Other.md", path: "/v/b.md" });

    expect(selectSavable([removed, savable])).toEqual([savable]);
    expect(selectRemovedOnDisk([removed, savable])).toEqual([removed]);
  });

  it("does not report an untitled or clean tab as removed-on-disk", () => {
    // Nothing to recreate and nothing to tell the user about.
    const untitled = savableTab({ path: null, removedOnDisk: true });
    const clean = savableTab({ dirty: false, removedOnDisk: true });
    expect(selectRemovedOnDisk([untitled, clean])).toEqual([]);
  });
});

describe("Save All status line", () => {
  it("names a skipped removal and says how to act on it", () => {
    const msg = describeSaveAll(3, 0, ["Meeting.md"]);
    expect(msg).toContain("Saved 3 files");
    expect(msg).toContain("Meeting.md");
    expect(msg).toContain("Save to recreate");
  });

  it("reports both kinds of exclusion at once", () => {
    const msg = describeSaveAll(1, 2, ["Meeting.md"]);
    expect(msg).toContain("Saved 1 file —");
    expect(msg).toContain("skipped 2 changed on disk");
    expect(msg).toContain("Meeting.md");
  });

  it("summarizes a long removal list instead of listing every name", () => {
    const msg = describeSaveAll(0, 0, ["a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(msg).toContain("a.md, b.md, c.md and 2 more");
    expect(msg).not.toContain("d.md");
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeSaveAll(0, 0, [])).toBe("");
  });
});

describe("resolution ordering (the invariant that matters most)", () => {
  // resolveConflict lives in main.ts, which needs a live editor and Tauri IPC
  // (§8), so the actual sequencing it protects — park the losing side before
  // touching disk, abort the whole resolution and keep `diverged` set if the
  // park fails — is exercised on-device, not here. What IS testable is the
  // contract that ordering depends on: a diverged tab must keep refusing
  // writes until something explicitly clears `diverged`, no matter *why* it
  // diverged.
  //
  // This task's brief (written before Tasks 10-11 landed) proposed three
  // tests, all built on a `reason: "conflict"` fixture:
  //   - "keeps refusing writes while diverged" and "permits writes again once
  //     cleared" duplicate the "write gating" tests above byte-for-byte in
  //     what they exercise (same predicates, same conflict-shaped fixture,
  //     same clean-vs-diverged split) — any wrong implementation that trips
  //     them would already trip those, so repeating them adds no detection
  //     power. Not added.
  //   - "captures theirs at detection time" only asserted a value against the
  //     literal that had just constructed it — it calls no production code
  //     and cannot fail for any implementation. Vacuous. Not added.
  //
  // What genuinely isn't covered anywhere else: an `"error"` divergence
  // (Task 11) carries `theirs: ""` — resolveConflict refuses to act on it at
  // all (there is nothing to park), so blocksWrite/selectSavable are the ONLY
  // things standing between that tab and an overwrite for as long as the
  // reason stays "error". Every existing fixture in this file uses a
  // non-empty `theirs`, so an implementation that keyed off truthiness of
  // `diverged.theirs` instead of `diverged !== null` — a plausible slip,
  // since a conflict's `theirs` is normally what you'd reach for — would pass
  // every test above and still silently unblock writes on an error tab,
  // because `""` is falsy. These two tests target exactly that.

  const tab = (diverged: DivergedState | null, path = "/v/a.md"): Savable =>
    savableTab({ diverged, path });

  it("blocks writes for an unparkable divergence, not just a conflict one", () => {
    const stuck = tab({ theirs: "", reason: "error", message: "m" });
    expect(blocksWrite(stuck)).toBe(true);
    expect(selectSavable([stuck])).toEqual([]);
  });

  it("excludes an error-reason tab from Save All alongside a normal savable tab", () => {
    const stuck = tab({ theirs: "", reason: "error", message: "m" }, "/v/a.md");
    const savable = tab(null, "/v/b.md");
    expect(selectSavable([stuck, savable])).toEqual([savable]);
  });
});
