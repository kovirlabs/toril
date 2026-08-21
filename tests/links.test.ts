// GATE for external link opening (ROADMAP Movement I.5).
//
// This is a §3.3 security gate, not a feature test. An opened `.md` is
// untrusted — it can arrive from a shared vault, a sync folder, or an AI
// assistant — and Ctrl-clicking a link in one hands its href to the operating
// system's shell. `sanitize.ts` stops such a link executing *in* the webview;
// this stops it executing *outside* it, which is the larger risk, because the
// webview is sandboxed and the shell is not.
//
// The cases below are the ones a blocklist gets wrong. They are why the rule is
// an allowlist.
import { describe, expect, it } from "vitest";
import { isExternallyOpenable, linkHrefFrom } from "../src/links";

describe("isExternallyOpenable", () => {
  it("allows the three schemes a markdown link actually means", () => {
    expect(isExternallyOpenable("https://example.com/notes")).toBe(true);
    expect(isExternallyOpenable("http://example.com")).toBe(true);
    expect(isExternallyOpenable("mailto:someone@example.com")).toBe(true);
  });

  it("refuses script schemes", () => {
    expect(isExternallyOpenable("javascript:alert(1)")).toBe(false);
    expect(isExternallyOpenable("vbscript:msgbox(1)")).toBe(false);
    expect(isExternallyOpenable("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  // The whole reason to parse rather than string-match: the OS normalizes case,
  // interior whitespace and control characters before acting, so a raw-text
  // check can be made to disagree with what actually opens.
  it("refuses script schemes however they are spelled", () => {
    expect(isExternallyOpenable("jAvAsCrIpT:alert(1)")).toBe(false);
    expect(isExternallyOpenable("  javascript:alert(1)")).toBe(false);
    expect(isExternallyOpenable("java\tscript:alert(1)")).toBe(false);
    expect(isExternallyOpenable("java\nscript:alert(1)")).toBe(false);
    expect(isExternallyOpenable("\u0000javascript:alert(1)")).toBe(false);
  });

  // Handing these to the shell is arbitrary local execution, not navigation.
  it("refuses anything that reaches the local machine", () => {
    expect(isExternallyOpenable("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(isExternallyOpenable("file:///etc/passwd")).toBe(false);
    expect(isExternallyOpenable("smb://attacker/share")).toBe(false);
    // Windows protocol handlers used in real attacks. An allowlist refuses
    // these without ever having heard of them, which is the point.
    expect(isExternallyOpenable("ms-msdt:/id PCWDiagnostic")).toBe(false);
    expect(isExternallyOpenable("search-ms:query=x&crumb=location:\\\\attacker")).toBe(false);
  });

  it("refuses what it cannot parse, rather than guessing", () => {
    expect(isExternallyOpenable("")).toBe(false);
    expect(isExternallyOpenable("not a url")).toBe(false);
    expect(isExternallyOpenable("./relative/note.md")).toBe(false);
    expect(isExternallyOpenable("//example.com")).toBe(false);
  });
});

describe("linkHrefFrom", () => {
  function fragment(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
  }

  it("finds the href when the anchor itself is clicked", () => {
    const a = fragment('<a href="https://example.com">x</a>').querySelector("a");
    expect(linkHrefFrom(a)).toBe("https://example.com");
  });

  // `<a><strong>text</strong></a>` is ordinary markdown, and the click lands on
  // the inner element — matching only `tagName === "A"` misses every styled link.
  it("finds the href from an element inside the anchor", () => {
    const inner = fragment('<a href="https://example.com"><strong>x</strong></a>').querySelector(
      "strong",
    );
    expect(linkHrefFrom(inner)).toBe("https://example.com");
  });

  it("returns null off a link, so a plain click is never a navigation", () => {
    const p = fragment("<p>just text</p>").querySelector("p");
    expect(linkHrefFrom(p)).toBe(null);
    expect(linkHrefFrom(null)).toBe(null);
  });

  it("treats an anchor with no usable href as not a link", () => {
    const a = fragment("<a>anchor</a>").querySelector("a");
    expect(linkHrefFrom(a)).toBe(null);
    const empty = fragment('<a href="">anchor</a>').querySelector("a");
    expect(linkHrefFrom(empty)).toBe(null);
  });
});
