// Unit tests for the tab state machine (CLAUDE.md §4). The deactivate→activate
// ordering matters: it is how the controller persists the outgoing document
// before loading the next, so no two buffers diverge (§3.2).
import { beforeEach, describe, expect, it } from "vitest";
import { type TabState, TabManager } from "../src/ui/tabs";

function setup() {
  const container = document.createElement("div");
  const events: string[] = [];
  const closeRequests: TabState[] = [];
  const tm = new TabManager(container, {
    onActivate: (t) => events.push(`activate:${t.name}`),
    onDeactivate: (t) => events.push(`deactivate:${t.name}`),
    onCloseRequest: (t) => closeRequests.push(t),
  });
  return { tm, container, events, closeRequests };
}

describe("TabManager", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("opens a tab and activates it", () => {
    const t = h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    expect(h.tm.active()).toBe(t);
    expect(h.events).toEqual(["activate:a.md"]);
    expect(h.container.querySelectorAll(".tab")).toHaveLength(1);
  });

  it("deactivates the old tab before activating the new one", () => {
    h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.tm.open({ path: "/b.md", name: "b.md", content: "B" });
    expect(h.events).toEqual(["activate:a.md", "deactivate:a.md", "activate:b.md"]);
    expect(h.tm.active()?.name).toBe("b.md");
  });

  it("re-activates an existing tab instead of duplicating it", () => {
    h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.tm.open({ path: "/b.md", name: "b.md", content: "B" });
    h.events.length = 0;
    const again = h.tm.open({ path: "/a.md", name: "a.md", content: "A (stale)" });
    expect(h.tm.list()).toHaveLength(2);
    expect(h.tm.active()).toBe(again);
    expect(h.events).toEqual(["deactivate:b.md", "activate:a.md"]);
  });

  it("activating the already-active tab fires no lifecycle callbacks", () => {
    h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.events.length = 0;
    h.tm.setActive(h.tm.active()!.id);
    expect(h.events).toEqual([]);
  });

  it("closing the active tab activates a neighbor (without deactivating the closed one)", () => {
    h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    const b = h.tm.open({ path: "/b.md", name: "b.md", content: "B" });
    h.events.length = 0;
    h.tm.close(b.id);
    expect(h.tm.list()).toHaveLength(1);
    expect(h.tm.active()?.name).toBe("a.md");
    expect(h.events).toEqual(["activate:a.md"]);
  });

  it("closing the last tab leaves no active tab", () => {
    const a = h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.tm.close(a.id);
    expect(h.tm.list()).toHaveLength(0);
    expect(h.tm.active()).toBeUndefined();
  });

  it("reflects the dirty flag in the rendered label", () => {
    const a = h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.tm.setDirty(a.id, true);
    const label = h.container.querySelector(".tab-label");
    expect(label?.textContent).toBe("• a.md");
    expect(h.container.querySelector(".tab")?.getAttribute("data-dirty")).toBe("true");
  });

  it("updates path and name on save-as", () => {
    const a = h.tm.open({ path: null, name: "Untitled", content: "" });
    h.tm.setPath(a.id, "/notes/new.md", "new.md");
    expect(h.tm.byPath("/notes/new.md")).toBe(a);
    expect(a.name).toBe("new.md");
  });

  it("seeds base from the content a tab opened with", () => {
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "hello\n" });
    expect(tab.base).toBe("hello\n");
    expect(tab.diverged).toBeNull();
  });

  it("tracks base independently of the buffer", () => {
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "hello\n" });
    tab.content = "hello edited\n";
    expect(tab.base).toBe("hello\n"); // base is what disk had, not the buffer

    h.tm.setBase(tab.id, "hello edited\n"); // as a save would
    expect(tab.base).toBe("hello edited\n");
  });

  it("stores and clears divergence", () => {
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "x\n" });
    h.tm.setDiverged(tab.id, {
      theirs: "y\n",
      reason: "conflict",
      message: "changed on disk",
    });
    expect(tab.diverged?.theirs).toBe("y\n");
    h.tm.setDiverged(tab.id, null);
    expect(tab.diverged).toBeNull();
  });

  it("opens with the file present on disk", () => {
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "x\n" });
    expect(tab.removedOnDisk).toBe(false);
  });

  it("stores and clears the removed-on-disk flag", () => {
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "x\n" });
    h.tm.setRemovedOnDisk(tab.id, true);
    expect(tab.removedOnDisk).toBe(true);
    h.tm.setRemovedOnDisk(tab.id, false);
    expect(tab.removedOnDisk).toBe(false);
  });

  it("keeps removal orthogonal to divergence", () => {
    // A deleted file has no `theirs` to weigh against, so nothing needs
    // resolving: `blocksWrite` stays false and an explicit save recreates it.
    // Only unattended writes consult the flag.
    const tab = h.tm.open({ path: "/v/a.md", name: "a.md", content: "x\n" });
    h.tm.setRemovedOnDisk(tab.id, true);
    expect(tab.diverged).toBeNull();

    h.tm.setDiverged(tab.id, { theirs: "y\n", reason: "conflict", message: "m" });
    h.tm.setRemovedOnDisk(tab.id, false);
    expect(tab.diverged?.theirs).toBe("y\n"); // clearing one leaves the other
  });
});

// A document the editor cannot load must never become the active tab. The
// controller's onActivate throws *after* the editor's state was replaced but
// before the screen redrew, so a tab left active there is the worst of both:
// the user sees the previous note, while Save (which does not need a dirty tab)
// writes the editor's half-loaded text over the file that failed to open.
describe("TabManager: an activation that throws", () => {
  function failing(badName: string) {
    const container = document.createElement("div");
    const events: string[] = [];
    const tm = new TabManager(container, {
      onActivate: (t) => {
        events.push(`activate:${t.name}`);
        if (t.name === badName) throw new RangeError("cannot load");
      },
      onDeactivate: (t) => events.push(`deactivate:${t.name}`),
      onCloseRequest: () => {},
    });
    return { tm, container, events };
  }

  it("keeps the previous tab active, reloads it, and rethrows", () => {
    const h = failing("bad.md");
    const a = h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    h.events.length = 0;
    expect(() => h.tm.open({ path: "/bad.md", name: "bad.md", content: "B" })).toThrow("cannot load");
    expect(h.tm.active()).toBe(a);
    // deactivate a (flush), try bad, then reload a — the editor holds bad's
    // half-loaded state until a is put back.
    expect(h.events).toEqual(["deactivate:a.md", "activate:bad.md", "activate:a.md"]);
    expect(h.container.querySelector('.tab[data-active="true"]')?.textContent).toContain("a.md");
  });

  it("never flushes the editor into the tab that failed to load", () => {
    const h = failing("bad.md");
    h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    try {
      h.tm.open({ path: "/bad.md", name: "bad.md", content: "B" });
    } catch {
      /* expected */
    }
    const bad = h.tm.byPath("/bad.md");
    h.events.length = 0;
    h.tm.open({ path: "/c.md", name: "c.md", content: "C" });
    // Only the tab that was really active is flushed; bad.md's buffer is untouched.
    expect(h.events).toEqual(["deactivate:a.md", "activate:c.md"]);
    expect(bad?.content).toBe("B");
  });

  it("leaves no tab active when there was none to fall back to", () => {
    const h = failing("bad.md");
    expect(() => h.tm.open({ path: "/bad.md", name: "bad.md", content: "B" })).toThrow();
    expect(h.tm.active()).toBeUndefined();
  });

  it("restores the active tab when switching to an existing tab fails", () => {
    const h = failing("bad.md");
    const a = h.tm.open({ path: "/a.md", name: "a.md", content: "A" });
    try {
      h.tm.open({ path: "/bad.md", name: "bad.md", content: "B" });
    } catch {
      /* expected */
    }
    const bad = h.tm.byPath("/bad.md")!;
    expect(() => h.tm.setActive(bad.id)).toThrow();
    expect(h.tm.active()).toBe(a);
  });
});
