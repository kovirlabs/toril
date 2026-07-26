// GATE for external-change reconciliation (CLAUDE.md §3, ROADMAP I.4).
//
// The rule this file protects: a conflict must never silently overwrite either
// side. That decomposes into three testable properties —
//
//   1. the outcome→action mapping is total and HTML never auto-merges;
//   2. a diverged tab is excluded from every write path;
//   3. a resolution parks the losing side BEFORE anything is overwritten.
import { describe, expect, it } from "vitest";
import { blocksWrite, decideAction, selectSavable } from "../src/sync";
import type { MergeReport } from "../src/ipc";
import type { DivergedState } from "../src/ui/tabs";

const report = (r: Partial<MergeReport> & Pick<MergeReport, "outcome">): MergeReport => ({
  content: null,
  theirs: null,
  ...r,
});

describe("decideAction", () => {
  it("does nothing when disk matches the base (this is where self-writes die)", () => {
    expect(decideAction(report({ outcome: "unchanged" }), "markdown")).toEqual({ kind: "none" });
  });

  it("reloads when only disk moved", () => {
    const a = decideAction(report({ outcome: "theirsOnly", theirs: "disk\n" }), "markdown");
    expect(a).toEqual({ kind: "reload", theirs: "disk\n" });
  });

  it("applies a clean merge and keeps the tab dirty", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "merged\n", theirs: "disk\n" }),
      "markdown",
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "merged\n", theirs: "disk\n", clean: false });
  });

  it("marks the tab CLEAN when the merge result already equals disk", () => {
    // Convergent edit: without this the tab sits dirty with nothing to save,
    // which reads as a bug.
    const a = decideAction(
      report({ outcome: "merged", content: "same\n", theirs: "same\n" }),
      "markdown",
    );
    expect(a).toEqual({ kind: "applyMerge", merged: "same\n", theirs: "same\n", clean: true });
  });

  it("never auto-merges HTML — a line merge can unbalance tags", () => {
    const a = decideAction(
      report({ outcome: "merged", content: "<p>x</p>", theirs: "<p>y</p>" }),
      "html",
    );
    expect(a.kind).toBe("conflict");
  });

  it("raises a conflict when both sides changed the same region", () => {
    const a = decideAction(report({ outcome: "conflict", theirs: "disk\n" }), "markdown");
    expect(a.kind).toBe("conflict");
    if (a.kind === "conflict") expect(a.theirs).toBe("disk\n");
  });

  it("falls back to conflict rather than losing data if theirs is missing", () => {
    // Defensive: a malformed report must fail closed, never silently proceed.
    const a = decideAction(report({ outcome: "merged", content: "x\n", theirs: null }), "markdown");
    expect(a.kind).toBe("conflict");
  });
});

describe("write gating", () => {
  const tab = (over: Partial<{ dirty: boolean; path: string | null; diverged: unknown }> = {}) => ({
    dirty: true,
    path: "/v/a.md",
    diverged: null,
    ...over,
  }) as { dirty: boolean; path: string | null; diverged: null };

  it("blocks a write while diverged", () => {
    expect(blocksWrite(tab())).toBe(false);
    expect(
      blocksWrite(
        tab({ diverged: { theirs: "x", reason: "conflict", message: "m" } }) as never,
      ),
    ).toBe(true);
  });

  it("excludes diverged tabs from Save All and autosave", () => {
    const clean = tab({ dirty: false });
    const untitled = tab({ path: null });
    const diverged = tab({ diverged: { theirs: "x", reason: "conflict", message: "m" } }) as never;
    const savable = tab();

    const out = selectSavable([clean, untitled, diverged, savable]);
    expect(out).toEqual([savable]);
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

  const tab = (
    diverged: DivergedState | null,
    path = "/v/a.md",
  ): { dirty: boolean; path: string | null; diverged: DivergedState | null } => ({
    dirty: true,
    path,
    diverged,
  });

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
