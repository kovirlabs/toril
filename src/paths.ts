// Pure path predicates for the controller. No DOM and no IPC, so the gate runs
// headlessly — the `sync.ts` precedent.

/**
 * Separator-normalized, with any trailing slash dropped so a prefix comparison
 * is meaningful. A lone `/` (or a bare `C:/`) keeps its root form.
 */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/**
 * True when `child` is `parent` itself, or lives underneath it.
 *
 * `notify` reports a removed *directory* as a single event carrying only the
 * directory path, so path-exact matching misses every open tab whose file lived
 * inside it — those tabs would get no signal at all that their file is gone
 * (ROADMAP Movement I.4). Comparison is exact, not case-folded: the rest of the
 * controller compares paths byte-for-byte and a looser rule here would be the
 * only place that could match two different files.
 */
export function isAtOrUnder(child: string, parent: string): boolean {
  const p = normalize(parent);
  if (p === "") return false; // an empty parent is not a directory, it is a bug
  const c = normalize(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}
