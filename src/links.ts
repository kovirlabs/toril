// Which links Toril is willing to hand to the operating system.
//
// This is a **security boundary**, not a convenience filter, and it is the
// reason opening links is a module with a gate rather than a one-line handler.
// §3.3 says an opened `.md` file is untrusted: its content can come from a
// shared vault, a sync folder, a downloaded note, or an AI assistant's output.
// Handing a href from that document to the OS shell is handing an attacker a
// primitive — the shell will happily act on far more than a web address.
//
// `sanitize.ts` already stops such a link from *executing in the webview*.
// This stops it from executing *outside* the webview, which is the strictly
// larger risk: the webview is sandboxed, the shell is not.
//
// So the rule is an **allowlist of three schemes**, not a blocklist. A
// blocklist has to anticipate every dangerous scheme the host registers —
// `file:`, `javascript:`, `vbscript:`, `data:`, `smb:`, `ms-msdt:`, `search-ms:`,
// and whatever an installed application added last week. An allowlist only has
// to know the three we actually mean, and everything invented afterwards is
// refused by default.

/** The only schemes Toril will open externally. */
const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/**
 * Whether `href` may be handed to the OS.
 *
 * Parsing rather than string-matching is deliberate: `URL` performs the same
 * normalization the OS will (case folding, whitespace and control-character
 * stripping, percent-decoding of the scheme), so a check written against the
 * raw text can be made to disagree with what actually gets opened —
 * `jAvAsCrIpT:`, `java\tscript:` and a leading newline are the classic three.
 * Anything `URL` cannot parse is refused, which also disposes of relative and
 * malformed hrefs.
 */
export function isExternallyOpenable(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return ALLOWED.has(url.protocol);
}

/**
 * Resolve the click target to a link href, or null if the click was not on one.
 *
 * Walks ancestors because a click usually lands on a text node or an inline
 * element *inside* the anchor — `<a><strong>text</strong></a>` is ordinary
 * markdown, and matching only `target.tagName === "A"` misses it.
 *
 * Separated from the DOM handler so both halves are testable: the traversal
 * runs against a jsdom fragment and the scheme rule runs against strings.
 */
export function linkHrefFrom(target: EventTarget | null): string | null {
  let node = target instanceof Element ? target : null;
  while (node) {
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      return href && href.length > 0 ? href : null;
    }
    node = node.parentElement;
  }
  return null;
}
