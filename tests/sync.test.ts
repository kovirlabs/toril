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
