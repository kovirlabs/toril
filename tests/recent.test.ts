// GATE for the recent-files list (ROADMAP Movement I.5).
//
// Small surface, but every property here has a failure mode that is invisible
// until the list is already wrong: a missing dedupe fills it with one file, a
// mutating push corrupts a menu being rendered elsewhere, and a load that
// throws on a hand-edited session.json costs the user their restored session.
import { describe, expect, it } from "vitest";
import { RECENT_LIMIT, forgetRecent, normalizeRecent, pushRecent } from "../src/recent";

describe("pushRecent", () => {
  it("puts the newest file first", () => {
    expect(pushRecent(["/b.md"], "/a.md")).toEqual(["/a.md", "/b.md"]);
  });

  // Reopening a file must move it, not add a second copy — otherwise the list
  // fills with whatever you are working on today.
  it("moves an existing entry instead of duplicating it", () => {
    expect(pushRecent(["/a.md", "/b.md", "/c.md"], "/c.md")).toEqual([
      "/c.md",
      "/a.md",
      "/b.md",
    ]);
  });

  it("caps the list", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i++) list = pushRecent(list, `/n${i}.md`);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe(`/n${RECENT_LIMIT + 4}.md`);
  });

  it("drops the oldest entry when it caps, not the newest", () => {
    const full = Array.from({ length: RECENT_LIMIT }, (_, i) => `/n${i}.md`);
    const next = pushRecent(full, "/new.md");
    expect(next[0]).toBe("/new.md");
    expect(next).not.toContain(`/n${RECENT_LIMIT - 1}.md`);
  });

  // The same array is read while rendering the File menu; mutating in place
  // turns "open a file" into a glitch somewhere unrelated.
  it("does not mutate the list it was given", () => {
    const original = ["/a.md"];
    const copy = [...original];
    pushRecent(original, "/b.md");
    expect(original).toEqual(copy);
  });

  it("ignores an empty path rather than storing one", () => {
    expect(pushRecent(["/a.md"], "")).toEqual(["/a.md"]);
  });
});

describe("forgetRecent", () => {
  // An entry that no longer resolves is worse than no entry: it offers an
  // action that can only fail.
  it("removes a path that turned out to be gone", () => {
    expect(forgetRecent(["/a.md", "/b.md"], "/a.md")).toEqual(["/b.md"]);
  });

  it("is a no-op for a path that was never there", () => {
    expect(forgetRecent(["/a.md"], "/z.md")).toEqual(["/a.md"]);
  });
});

describe("normalizeRecent", () => {
  it("keeps a well-formed list", () => {
    expect(normalizeRecent(["/a.md", "/b.md"])).toEqual(["/a.md", "/b.md"]);
  });

  // Bootstrap reads this. Throwing here costs the user the whole restored
  // session over a malformed field.
  it("degrades to empty rather than throwing on junk", () => {
    expect(normalizeRecent(null)).toEqual([]);
    expect(normalizeRecent(undefined)).toEqual([]);
    expect(normalizeRecent("not a list")).toEqual([]);
    expect(normalizeRecent(42)).toEqual([]);
    expect(normalizeRecent({ 0: "/a.md" })).toEqual([]);
  });

  it("skips entries that are not usable paths", () => {
    expect(normalizeRecent(["/a.md", null, 7, "", "/b.md"])).toEqual(["/a.md", "/b.md"]);
  });

  // An older Toril, or a hand-edited file, can supply a list this module never
  // produced — so loading dedupes too.
  it("dedupes a list it did not produce, keeping the first occurrence", () => {
    expect(normalizeRecent(["/a.md", "/b.md", "/a.md"])).toEqual(["/a.md", "/b.md"]);
  });

  it("caps an over-long stored list", () => {
    const long = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => `/n${i}.md`);
    expect(normalizeRecent(long)).toHaveLength(RECENT_LIMIT);
  });
});
