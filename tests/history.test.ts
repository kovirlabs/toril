// Version-history gate (CLAUDE.md §4, §8). The line diff and the label helpers
// are pure; the History panel is exercised in jsdom with injected fakes (no
// Tauri). The full save-if-dirty→restore→reload flow lives in main.ts and is
// GUI, so it is verified on-device — here we assert the panel calls its port.
import { beforeEach, describe, expect, it } from "vitest";
import { type DiffLine, lineDiff } from "../src/ui/linediff";
import {
  formatRelativeTime,
  formatSize,
  formatTimestamp,
  History,
  type HistoryHost,
  type HistoryPort,
} from "../src/ui/history";
import type { SnapshotMeta } from "../src/ipc";

describe("lineDiff", () => {
  const ops = (rows: DiffLine[]): string => rows.map((r) => r.op[0]).join("");

  it("marks unchanged lines as same", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { op: "same", text: "a" },
      { op: "same", text: "b" },
    ]);
  });

  it("detects an added line", () => {
    const rows = lineDiff("a\nc", "a\nb\nc");
    expect(rows).toContainEqual({ op: "add", text: "b" });
    expect(rows.filter((r) => r.op === "same").map((r) => r.text)).toEqual(["a", "c"]);
  });

  it("detects a deleted line", () => {
    const rows = lineDiff("a\nb\nc", "a\nc");
    expect(rows).toContainEqual({ op: "del", text: "b" });
  });

  it("treats empty-to-content as a single add", () => {
    expect(lineDiff("", "hello")).toEqual([{ op: "add", text: "hello" }]);
  });

  it("handles a trailing newline without spurious changes", () => {
    // "a\n" -> ["a",""]; "a\nb\n" -> ["a","b",""]: the "a" and trailing "" are
    // anchors, only "b" is added. Ops: same, add, same.
    expect(ops(lineDiff("a\n", "a\nb\n"))).toBe("sas");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;
  it("labels each tier", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2 min ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(formatRelativeTime(now - 2 * 7 * 86_400_000, now)).toBe("2 w ago");
  });
  it("never reports negative time", () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe("just now");
  });
});

describe("formatTimestamp", () => {
  // A fixed local wall-clock "now" so the test is deterministic.
  const now = new Date(2026, 6, 8, 15, 6, 40).getTime();

  it("distinguishes saves seconds apart (the whole reason for absolute time)", () => {
    // Two saves 12s apart both read '2 min ago' relatively, but must differ here.
    expect(formatRelativeTime(now - 140_000, now)).toBe(formatRelativeTime(now - 128_000, now));
    expect(formatTimestamp(now - 140_000, now)).not.toBe(formatTimestamp(now - 128_000, now));
  });

  it("shows time-only for same-day saves and a date prefix for older ones", () => {
    expect(formatTimestamp(now - 60_000, now)).not.toContain(","); // today → time only
    expect(formatTimestamp(now - 3 * 86_400_000, now)).toContain(","); // older → date, time
  });
});

describe("formatSize", () => {
  it("scales the unit", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(10 * 1024)).toBe("10 KB");
    expect(formatSize(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
  });
});

describe("History panel", () => {
  let el: HTMLElement;
  let reads: string[];
  let restores: Array<[string, string]>;
  let metas: SnapshotMeta[];
  let host: HistoryHost;

  const port = (): HistoryPort => ({
    list: () => Promise.resolve(metas),
    read: (_path, hash) => {
      reads.push(hash);
      return Promise.resolve("old\nline");
    },
    restore: (path, hash) => {
      restores.push([path, hash]);
      return Promise.resolve();
    },
  });

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    el = document.createElement("div");
    document.body.append(el);
    reads = [];
    restores = [];
    metas = [
      { hash: "aaa", saved_at: 1_700_000_000_000, size: 10 },
      { hash: "bbb", saved_at: 1_699_999_000_000, size: 20 },
    ];
    host = { now: () => 1_700_000_050_000, confirm: () => true };
  });

  it("shows an empty hint when no note is active", async () => {
    const h = new History(el, port(), host);
    await h.setActive(null, "");
    expect(el.querySelector(".history-empty")?.textContent).toBe("No note open");
  });

  it("shows 'no versions' for a note with empty history", async () => {
    metas = [];
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "buf");
    expect(el.querySelector(".history-empty")?.textContent).toBe("No versions yet");
  });

  it("renders one entry per version", async () => {
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "current");
    const entries = el.querySelectorAll(".history-entry");
    expect(entries.length).toBe(2);
    expect((entries[0] as HTMLElement).dataset.hash).toBe("aaa");
  });

  it("reads a version and renders its diff on click", async () => {
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "old\nline\nnew");
    (el.querySelector(".history-entry") as HTMLButtonElement).click();
    await flush();
    expect(reads).toEqual(["aaa"]);
    const diff = el.querySelector(".history-diff");
    expect(diff).not.toBeNull();
    // The extra "new" line is an addition in the current buffer.
    expect(diff?.querySelector('[data-op="add"]')?.textContent).toContain("new");
  });

  it("shows only one diff at a time — selecting another replaces it (no stacking)", async () => {
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "current");
    const entries = el.querySelectorAll<HTMLButtonElement>(".history-entry");
    entries[0].click();
    await flush();
    entries[1].click();
    await flush();
    expect(el.querySelectorAll(".history-diff").length).toBe(1);
    expect((el.querySelector(".history-diff") as HTMLElement).dataset.hash).toBe("bbb");
  });

  it("re-clicking the open version closes its diff", async () => {
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "current");
    const first = el.querySelector<HTMLButtonElement>(".history-entry");
    first?.click();
    await flush();
    expect(el.querySelector(".history-diff")).not.toBeNull();
    first?.click();
    await flush();
    expect(el.querySelector(".history-diff")).toBeNull();
  });

  it("restores via the port when confirmed, and not when declined", async () => {
    const h = new History(el, port(), host);
    await h.setActive("/n.md", "current");
    (el.querySelector(".history-entry") as HTMLButtonElement).click();
    await flush();

    host.confirm = () => false;
    (el.querySelector(".history-restore") as HTMLButtonElement).click();
    await flush();
    expect(restores).toEqual([]);

    host.confirm = () => true;
    (el.querySelector(".history-restore") as HTMLButtonElement).click();
    await flush();
    expect(restores).toEqual([["/n.md", "aaa"]]);
  });
});
