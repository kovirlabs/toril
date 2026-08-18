// Vault search panel — the rail's third tab (ROADMAP Movement II.6).
//
// Distinct from `search.ts`, which finds text inside the note that is open. This
// finds it across every note in the folder, and the two meet at one point: a
// result opens its note and hands the query to the in-document bar, so the match
// is highlighted by the machinery that already knows how to highlight it.
//
// The matching itself lives in Rust (`crates/vaultsearch`); this file is the
// query box, the results list, and the rules for what to say about them. Those
// rules — the debounce, the summary line, the empty and error states — are pure
// functions exported separately from the DOM, so the gate tests them headlessly
// (the `toolbar.ts` pattern).

import type { SearchArgs, SearchFileHit, SearchResults } from "../ipc";

/** How long typing settles before a query runs. */
export const SEARCH_DEBOUNCE_MS = 180;

/** Shortest query that runs on its own. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Whether `text` should run as a query.
 *
 * A single character matches most of a vault and costs a full scan to say so.
 * The floor is a length in *characters*, not bytes, so one CJK ideograph — a
 * perfectly ordinary two-character word in Japanese — is not held to a rule
 * written for Latin text.
 */
export function shouldRun(text: string): boolean {
  return [...text.trim()].length >= MIN_QUERY_LENGTH;
}

/**
 * The line under the query box.
 *
 * It reports what was *found*, not what was shown, and says so explicitly when
 * those differ. A results list silently capped at 200 reads as a complete answer,
 * and a search that quietly under-reports is worse than one that admits a limit.
 */
export function summarize(results: SearchResults): string {
  const { totalFiles, totalMatches, truncated, files } = results;
  if (totalFiles === 0) return "No results";

  const notes = `${totalFiles} ${totalFiles === 1 ? "note" : "notes"}`;
  const head =
    totalMatches === 0
      ? `${notes} by name`
      : `${totalMatches} ${totalMatches === 1 ? "match" : "matches"} in ${notes}`;
  return truncated ? `${head} — showing the first ${files.length}` : head;
}

/** What the panel needs from the rest of the app. */
export interface SearchPanelCallbacks {
  /** Run a query. Rejects with the engine's message on a malformed pattern. */
  search(args: SearchArgs): Promise<SearchResults>;
  /** Open `path` and highlight `query` inside it. */
  openResult(path: string, query: string): void;
}

type ToggleName = "caseSensitive" | "wholeWord" | "regex";

const TOGGLES: { name: ToggleName; label: string; title: string }[] = [
  { name: "caseSensitive", label: "Aa", title: "Match case" },
  { name: "wholeWord", label: "ab", title: "Whole word" },
  { name: "regex", label: ".*", title: "Regular expression" },
];

export class SearchPanel {
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly toggleButtons = new Map<ToggleName, HTMLButtonElement>();
  private readonly flags: Record<ToggleName, boolean> = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Increments per run, so a slow answer cannot overwrite a newer one. */
  private generation = 0;
  private lastQuery = "";

  constructor(
    private readonly el: HTMLElement,
    private readonly cb: SearchPanelCallbacks,
  ) {
    this.el.classList.add("searchpanel");

    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "searchpanel-input";
    this.input.placeholder = "Search notes";
    this.input.setAttribute("aria-label", "Search notes");

    const toggles = document.createElement("div");
    toggles.className = "searchpanel-toggles";
    for (const { name, label, title } of TOGGLES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "searchpanel-toggle";
      btn.textContent = label;
      btn.title = title;
      btn.dataset.toggle = name;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => this.toggle(name));
      this.toggleButtons.set(name, btn);
      toggles.append(btn);
    }

    this.status = document.createElement("p");
    this.status.className = "searchpanel-status";
    // Results replace themselves as the user types, so a screen reader has to be
    // told rather than left to notice.
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");

    this.list = document.createElement("div");
    this.list.className = "searchpanel-results";

    const head = document.createElement("div");
    head.className = "searchpanel-head";
    head.append(this.input, toggles);
    this.el.append(head, this.status, this.list);

    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // An explicit ask runs now, and runs even a one-character query — the
        // length floor exists to stop typing from thrashing the vault, not to
        // overrule someone who meant it.
        e.preventDefault();
        this.run(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clear();
      }
    });
  }

  /** Focus the query box — what selecting the tab does. */
  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /**
   * Re-run the current query.
   *
   * Called when the index changes underneath a shown result set: a note that has
   * been edited, renamed or deleted since the search ran would otherwise sit
   * there claiming a match it no longer has.
   */
  refresh(): void {
    if (this.lastQuery) this.run(true);
  }

  destroy(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private toggle(name: ToggleName): void {
    this.flags[name] = !this.flags[name];
    this.toggleButtons.get(name)?.setAttribute("aria-pressed", String(this.flags[name]));
    // Only re-run something that has already run: flipping a toggle with an
    // empty box is a preference, not a question.
    if (this.lastQuery) this.run(true);
  }

  private clear(): void {
    this.input.value = "";
    this.lastQuery = "";
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.generation++; // abandon anything in flight
    this.status.textContent = "";
    this.list.replaceChildren();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), SEARCH_DEBOUNCE_MS);
  }

  /** Run the query in the box. `force` runs it regardless of the length floor. */
  private run(force = false): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const text = this.input.value.trim();
    const generation = ++this.generation;

    if (text === "") {
      this.clear();
      return;
    }
    if (!force && !shouldRun(text)) {
      // Too short to run on its own, but Enter still forces it — so say why
      // rather than appearing to have found nothing.
      this.status.textContent = "Keep typing…";
      this.list.replaceChildren();
      return;
    }
    this.lastQuery = text;

    void this.cb
      .search({ text, ...this.flags })
      .then((results) => {
        // A stale answer must never overwrite a newer one; queries are not
        // guaranteed to come back in the order they were asked.
        if (generation !== this.generation) return;
        this.status.textContent = summarize(results);
        this.render(results, text);
      })
      .catch((err: unknown) => {
        if (generation !== this.generation) return;
        // A half-typed regular expression is the normal case here, not a
        // failure — report it in place of results rather than as an alert.
        this.status.textContent = String(err instanceof Error ? err.message : err);
        this.list.replaceChildren();
      });
  }

  private render(results: SearchResults, query: string): void {
    this.list.replaceChildren();
    for (const file of results.files) {
      this.list.append(this.renderFile(file, query));
    }
  }

  private renderFile(file: SearchFileHit, query: string): HTMLElement {
    const group = document.createElement("section");
    group.className = "searchpanel-file";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "searchpanel-filename";
    header.title = file.path;
    header.dataset.nameMatch = String(file.nameMatch);
    header.addEventListener("click", () => this.cb.openResult(file.path, query));

    const name = document.createElement("span");
    name.className = "searchpanel-filename-text";
    name.textContent = file.name;
    const count = document.createElement("span");
    count.className = "searchpanel-count";
    count.textContent = file.totalMatches > 0 ? String(file.totalMatches) : "name";
    header.append(name, count);
    group.append(header);

    for (const match of file.matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "searchpanel-line";
      row.dataset.line = String(match.line);
      row.addEventListener("click", () => this.cb.openResult(file.path, query));

      const num = document.createElement("span");
      num.className = "searchpanel-lineno";
      num.textContent = String(match.line);
      row.append(num);

      const text = document.createElement("span");
      text.className = "searchpanel-linetext";
      if (match.clippedStart) text.append(ellipsis());
      for (const seg of match.segments) {
        if (seg.matched) {
          const mark = document.createElement("mark");
          mark.textContent = seg.text;
          text.append(mark);
        } else {
          // textContent, never innerHTML: a note is untrusted (§3.3), and this
          // is its raw text arriving straight from disk.
          text.append(document.createTextNode(seg.text));
        }
      }
      if (match.clippedEnd) text.append(ellipsis());
      row.append(text);
      group.append(row);
    }

    if (file.truncated) {
      const more = document.createElement("p");
      more.className = "searchpanel-more";
      more.textContent = `and more in this note`;
      group.append(more);
    }
    return group;
  }
}

/** The marker for text a long line had removed, kept out of the segment text. */
function ellipsis(): HTMLElement {
  const el = document.createElement("span");
  el.className = "searchpanel-clip";
  el.textContent = "…";
  return el;
}
