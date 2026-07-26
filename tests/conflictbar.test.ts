// Conflict-banner gate (ROADMAP Movement I.4, spec §5.4).
//
// The banner is plain DOM, so unlike the rest of the sync wiring it *can* be
// driven headlessly. What is pinned here is the accessibility contract, because
// it is invisible in review and silently regressed once already: the bar used to
// build a fresh `aria-live` span on every `show()`, inside a container that was
// still `hidden` at that moment — a live region assistive tech has no way to
// announce, since content present when a region is created is not a mutation and
// neither is content revealed by unhiding.
//
// Whether a screen reader actually speaks is on-device (§0). These tests pin the
// two DOM facts the announcement depends on.
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictBar } from "../src/ui/conflictbar";

function mount(): { host: HTMLElement; bar: ConflictBar } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return { host, bar: new ConflictBar(host) };
}

const live = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>("[aria-live]");

const resolveOpts = {
  name: "note.md",
  message: "Changed on disk while you were editing",
  onKeepMine: (): void => {},
  onUseTheirs: (): void => {},
} as const;

describe("ConflictBar live region", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("creates the live region up front, not on first show", () => {
    const { host } = mount();
    const region = live(host);
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the SAME live-region node across show / hide / show", () => {
    // The regression that motivated this: a per-show span means every message
    // lands in a region assistive tech has never seen before.
    const { host, bar } = mount();
    const first = live(host);

    bar.show(resolveOpts);
    expect(live(host)).toBe(first);

    bar.hide();
    expect(live(host)).toBe(first);
    expect(first?.textContent).toBe("");

    bar.show({ name: "other.md", message: "could not be read", actions: "none" });
    expect(live(host)).toBe(first);
    expect(first?.textContent).toContain("other.md");
  });

  it("unhides the container BEFORE writing the text", () => {
    // Order is the whole point: a mutation inside a `hidden` subtree is not
    // observable to assistive tech, so the text has to arrive after the unhide.
    const { host, bar } = mount();
    const container = host.querySelector<HTMLElement>(".conflict-bar");
    expect(container).not.toBeNull();

    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.attributeName === "hidden") seen.push("unhide");
        if (r.type === "childList" && r.target === live(host)) seen.push("text");
      }
    });
    observer.observe(container!, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    bar.show(resolveOpts);
    const records = observer.takeRecords();
    observer.disconnect();
    for (const r of records) {
      if (r.type === "attributes" && r.attributeName === "hidden") seen.push("unhide");
      if (r.type === "childList" && r.target === live(host)) seen.push("text");
    }

    expect(seen.indexOf("unhide")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("text")).toBeGreaterThan(seen.indexOf("unhide"));
  });
});

describe("ConflictBar rendering", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders both resolve buttons and the park reassurance", () => {
    const { host, bar } = mount();
    bar.show(resolveOpts);
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(live(host)?.textContent).toContain("the other version is saved beside it");
  });

  it("renders a notice with no buttons and no park promise", () => {
    // An `error` divergence has parked nothing, so promising otherwise invites
    // exactly the confident click that loses work.
    const { host, bar } = mount();
    bar.show({ name: "note.md", message: "could not be read", actions: "none" });
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(live(host)?.textContent).not.toContain("saved beside it");
    expect(host.querySelector(".conflict-bar")?.getAttribute("aria-label")).toBe(
      "File could not be read",
    );
  });

  it("drops the previous show's buttons when re-shown as a notice", () => {
    // `clearActions` removes every child *except* the live region; a stale
    // "Keep mine" button under an unresolvable error would be a dead control.
    const { host, bar } = mount();
    bar.show(resolveOpts);
    bar.show({ name: "note.md", message: "could not be read", actions: "none" });
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(live(host)).not.toBeNull();
  });
});
