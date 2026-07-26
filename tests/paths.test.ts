// Gate for the containment predicate behind directory-level removal handling
// (ROADMAP Movement I.4). `notify` reports a removed directory as one event for
// the directory path, so every open tab underneath it has to be matched by
// containment rather than equality.
import { describe, expect, it } from "vitest";
import { isAtOrUnder } from "../src/paths";

describe("isAtOrUnder", () => {
  it("matches the path itself", () => {
    expect(isAtOrUnder("/vault/note.md", "/vault/note.md")).toBe(true);
  });

  it("matches a file inside a removed directory", () => {
    expect(isAtOrUnder("/vault/daily/2026-07-25.md", "/vault/daily")).toBe(true);
    expect(isAtOrUnder("/vault/daily/deep/nested.md", "/vault/daily")).toBe(true);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(isAtOrUnder("/vault/daily-archive/old.md", "/vault/daily")).toBe(false);
    expect(isAtOrUnder("/vault/dailynotes.md", "/vault/daily")).toBe(false);
  });

  it("does not match an unrelated path, or a parent of the removed dir", () => {
    expect(isAtOrUnder("/other/note.md", "/vault")).toBe(false);
    expect(isAtOrUnder("/vault", "/vault/daily")).toBe(false);
  });

  it("tolerates a trailing separator on the removed directory", () => {
    expect(isAtOrUnder("/vault/daily/x.md", "/vault/daily/")).toBe(true);
  });

  it("handles Windows separators, including mixed ones", () => {
    expect(isAtOrUnder("C:\\vault\\daily\\x.md", "C:\\vault\\daily")).toBe(true);
    expect(isAtOrUnder("C:\\vault\\daily\\x.md", "C:/vault/daily")).toBe(true);
    expect(isAtOrUnder("C:\\vault\\x.md", "C:\\")).toBe(true);
    expect(isAtOrUnder("C:\\vaultly\\x.md", "C:\\vault")).toBe(false);
  });

  it("treats the filesystem root as containing everything", () => {
    expect(isAtOrUnder("/vault/x.md", "/")).toBe(true);
  });

  it("never matches on an empty parent", () => {
    // A malformed event must not be read as 'every open tab was deleted'.
    expect(isAtOrUnder("/vault/x.md", "")).toBe(false);
  });
});
