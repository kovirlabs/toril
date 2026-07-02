// Unit tests for the autosave scheduler + selection helpers (CLAUDE.md §3,
// ROADMAP Movement I.1). The scheduler is pure — all side effects injected — so
// debounce + dirty-only selection are verifiable headlessly with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveScheduler,
  type AutosaveDeps,
  type BufferLike,
  type RecoveryEntry,
  selectDirtySaved,
  snapshotDirty,
} from "../src/autosave";

function buf(over: Partial<BufferLike>): BufferLike {
  return { id: "b", path: "/a.md", name: "a.md", content: "A", format: "markdown", dirty: true, ...over };
}

function makeDeps(over: Partial<AutosaveDeps> = {}) {
  const calls = { journal: [] as RecoveryEntry[][], saves: 0 };
  const deps: AutosaveDeps = {
    snapshotDirtyBuffers: () => [],
    writeJournal: async (e) => {
      calls.journal.push(e);
    },
    saveDirtySaved: async () => {
      calls.saves += 1;
    },
    ...over,
  };
  return { deps, calls };
}

describe("selection helpers", () => {
  it("selectDirtySaved keeps dirty+path-backed, drops clean and Untitled", () => {
    const list = [
      buf({ id: "1", path: "/a.md", dirty: true }),
      buf({ id: "2", path: "/b.md", dirty: false }),
      buf({ id: "3", path: null, dirty: true }),
    ];
    expect(selectDirtySaved(list).map((b) => b.id)).toEqual(["1"]);
  });

  it("snapshotDirty includes Untitled but excludes clean, preserving format+path", () => {
    const list = [
      buf({ id: "1", path: "/a.md", dirty: true, format: "markdown" }),
      buf({ id: "2", path: null, name: "Untitled", content: "draft", dirty: true }),
      buf({ id: "3", path: "/c.html", dirty: false, format: "html" }),
    ];
    expect(snapshotDirty(list)).toEqual([
      { id: "1", path: "/a.md", name: "a.md", content: "A", format: "markdown" },
      { id: "2", path: null, name: "Untitled", content: "draft", format: "markdown" },
    ]);
  });
});

describe("AutosaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid changes into exactly one flush", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { debounceMs: 100 });
    s.notifyChange();
    s.notifyChange();
    s.notifyChange();
    expect(calls.journal).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.journal).toHaveLength(1);
  });

  it("writes the journal but never autosaves when disabled", async () => {
    const entry: RecoveryEntry = { id: "1", path: "/a.md", name: "a.md", content: "A", format: "markdown" };
    const { deps, calls } = makeDeps({ snapshotDirtyBuffers: () => [entry] });
    const s = new AutosaveScheduler(deps, { enabled: false, debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.journal).toEqual([[entry]]);
    expect(calls.saves).toBe(0);
  });

  it("autosaves when enabled", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { enabled: true, debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.saves).toBe(1);
  });

  it("clears the journal with an empty snapshot when nothing is dirty", async () => {
    const { deps, calls } = makeDeps({ snapshotDirtyBuffers: () => [] });
    const s = new AutosaveScheduler(deps, { debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.journal).toEqual([[]]);
  });

  it("setConfig can turn autosave on at runtime", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { enabled: false, debounceMs: 10 });
    s.setConfig({ enabled: true });
    await s.flush();
    expect(calls.saves).toBe(1);
  });

  it("round-trips recovery entries losslessly through JSON", () => {
    const entries: RecoveryEntry[] = [
      { id: "1", path: "/n/a.md", name: "a.md", content: "# A\n\nbody", format: "markdown" },
      { id: "2", path: null, name: "Untitled", content: "draft", format: "markdown" },
      { id: "3", path: "/n/page.html", name: "page.html", content: "<p>hi</p>", format: "html" },
    ];
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});
