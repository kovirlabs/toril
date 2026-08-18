// Gate for the vault-search panel (ROADMAP Movement II.6).
//
// The matching itself is `cargo test -p vaultsearch`. What is gated here is
// everything the panel decides on top of it: when a query runs, what the summary
// line admits to, that a slow answer cannot overwrite a newer one, and that a
// note's own text can never become markup.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIN_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  SearchPanel,
  shouldRun,
  summarize,
} from "../src/ui/searchpanel";
import type { SearchArgs, SearchFileHit, SearchResults } from "../src/ipc";

function hit(over: Partial<SearchFileHit> = {}): SearchFileHit {
  return {
    path: "/v/note.md",
    name: "note.md",
    matches: [
      {
        line: 3,
        segments: [
          { text: "before ", matched: false },
          { text: "needle", matched: true },
          { text: " after", matched: false },
        ],
        clippedStart: false,
        clippedEnd: false,
      },
    ],
    totalMatches: 1,
    truncated: false,
    nameMatch: false,
    ...over,
  };
}

function results(over: Partial<SearchResults> = {}): SearchResults {
  const files = over.files ?? [hit()];
  return {
    files,
    totalFiles: files.length,
    totalMatches: files.reduce((n, f) => n + f.totalMatches, 0),
    truncated: false,
    ...over,
  };
}

describe("shouldRun", () => {
  it("holds back a query too short to mean anything", () => {
    expect(shouldRun("a")).toBe(false);
    expect(shouldRun("  a  ")).toBe(false);
    expect(shouldRun("")).toBe(false);
  });

  it("runs once the query reaches the floor", () => {
    expect(shouldRun("ab")).toBe(true);
    expect("ab".length).toBe(MIN_QUERY_LENGTH);
  });

  it("counts characters, not bytes", () => {
    // Two CJK ideographs are six UTF-8 bytes and a perfectly ordinary word. A
    // byte-length floor would silently refuse to search Japanese.
    expect(shouldRun("眼鏡")).toBe(true);
  });
});

describe("summarize", () => {
  it("says nothing was found rather than showing an empty list with no words", () => {
    expect(summarize(results({ files: [], totalFiles: 0, totalMatches: 0 }))).toBe("No results");
  });

  it("counts matches and notes, singular and plural", () => {
    expect(summarize(results())).toBe("1 match in 1 note");
    expect(summarize(results({ files: [hit(), hit({ path: "/v/b.md", totalMatches: 4 })] }))).toBe(
      "5 matches in 2 notes",
    );
  });

  it("distinguishes a name-only hit from a match in the text", () => {
    const nameOnly = hit({ matches: [], totalMatches: 0, nameMatch: true });
    expect(summarize(results({ files: [nameOnly] }))).toBe("1 note by name");
  });

  it("admits when the list is capped", () => {
    // A list silently truncated at 200 reads as a complete answer. Under-reporting
    // without saying so is the failure this line exists to prevent.
    const capped = results({ files: [hit()], totalFiles: 431, totalMatches: 900, truncated: true });
    expect(summarize(capped)).toBe("900 matches in 431 notes — showing the first 1");
  });
});

describe("SearchPanel", () => {
  let el: HTMLElement;
  let search: ReturnType<typeof vi.fn>;
  let openResult: ReturnType<typeof vi.fn>;

  const input = () => el.querySelector<HTMLInputElement>(".searchpanel-input")!;
  const status = () => el.querySelector<HTMLElement>(".searchpanel-status")!;
  const type = (text: string): void => {
    input().value = text;
    input().dispatchEvent(new Event("input"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.replaceChildren(el);
    search = vi.fn(async (_args: SearchArgs) => results());
    openResult = vi.fn();
    new SearchPanel(el, {
      search: search as unknown as (a: SearchArgs) => Promise<SearchResults>,
      openResult: openResult as unknown as (p: string, q: string) => void,
    });
  });

  it("waits for typing to settle instead of querying per keystroke", async () => {
    type("nee");
    type("need");
    type("needle");
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({ text: "needle" });
  });

  it("runs immediately on Enter, even below the length floor", async () => {
    type("x");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({ text: "x" });
  });

  it("says why a short query is not running rather than looking like no results", async () => {
    type("a");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(search).not.toHaveBeenCalled();
    expect(status().textContent).toBe("Keep typing…");
  });

  it("sends the modifier flags the toggles are showing", async () => {
    el.querySelector<HTMLButtonElement>('[data-toggle="regex"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    type("^TODO");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    const last = search.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ text: "^TODO", regex: true, caseSensitive: false });
    expect(el.querySelector('[data-toggle="regex"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders a result and opens it with the query that found it", async () => {
    type("needle");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(el.querySelector(".searchpanel-filename-text")!.textContent).toBe("note.md");
    const line = el.querySelector<HTMLButtonElement>(".searchpanel-line")!;
    expect(line.dataset.line).toBe("3");
    expect(line.querySelector("mark")!.textContent).toBe("needle");
    expect(line.textContent).toContain("before needle after");

    line.click();
    // The query, not a line number: there is no line to jump to in a WYSIWYG
    // surface, so the in-document find re-locates the text in the open doc.
    expect(openResult).toHaveBeenCalledWith("/v/note.md", "needle");
  });

  it("never lets a note's own text become markup", async () => {
    // The segment text is raw bytes from a file, and an opened file is untrusted
    // (§3.3). This is the one place vault content reaches the DOM outside the
    // editor's own sanitize path.
    search.mockResolvedValue(
      results({
        files: [
          hit({
            matches: [
              {
                line: 1,
                segments: [{ text: "<img src=x onerror=alert(1)>", matched: true }],
                clippedStart: false,
                clippedEnd: false,
              },
            ],
          }),
        ],
      }),
    );
    type("img");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("mark")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("shows a bad pattern in place of results instead of throwing", async () => {
    search.mockRejectedValue(new Error("regex parse error: unclosed group"));
    type("(unclosed");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(status().textContent).toContain("unclosed group");
    expect(el.querySelectorAll(".searchpanel-file")).toHaveLength(0);
  });

  it("does not let a slow answer overwrite a newer one", async () => {
    // Queries are not guaranteed to return in the order they were asked, and the
    // failure is invisible: the panel would sit showing results for a query the
    // user has already replaced.
    let releaseSlow: (r: SearchResults) => void = () => {};
    search.mockImplementationOnce(
      () =>
        new Promise<SearchResults>((resolve) => {
          releaseSlow = resolve;
        }),
    );
    search.mockImplementationOnce(async () =>
      results({ files: [hit({ path: "/v/fast.md", name: "fast.md" })] }),
    );

    type("slow");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    type("fast");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(el.querySelector(".searchpanel-filename-text")!.textContent).toBe("fast.md");

    releaseSlow(results({ files: [hit({ path: "/v/slow.md", name: "slow.md" })] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(el.querySelector(".searchpanel-filename-text")!.textContent).toBe("fast.md");
  });

  it("clears everything when the box is emptied", async () => {
    type("needle");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(el.querySelectorAll(".searchpanel-file")).toHaveLength(1);

    type("");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(el.querySelectorAll(".searchpanel-file")).toHaveLength(0);
    expect(status().textContent).toBe("");
  });

  it("marks a clipped line without inventing text inside the segments", async () => {
    search.mockResolvedValue(
      results({
        files: [
          hit({
            matches: [
              {
                line: 1,
                segments: [{ text: "middle", matched: true }],
                clippedStart: true,
                clippedEnd: true,
              },
            ],
          }),
        ],
      }),
    );
    type("middle");
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(el.querySelectorAll(".searchpanel-clip")).toHaveLength(2);
    expect(el.querySelector("mark")!.textContent).toBe("middle");
  });
});
