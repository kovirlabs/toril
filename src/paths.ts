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

/**
 * The extensions Toril will open — the same set `tauri.conf.json` registers as
 * file associations, kept in step with it.
 *
 * An **allowlist**, because this gates drag-and-drop: a drop is the one open
 * path where the user never picked from a filter, so anything on the desktop
 * can land on the window. `formatForPath` in `main.ts` is not a substitute — it
 * answers "how do I parse this?" and answers "markdown" for everything it does
 * not recognise, which is the right default once a file is known to be text and
 * exactly the wrong one for deciding whether to open a dropped `.exe` at all.
 */
const OPENABLE = /\.(md|markdown|html?)$/i;

/** Whether a dropped or forwarded path is one Toril should open. */
export function isOpenablePath(path: string): boolean {
  return OPENABLE.test(path);
}

/**
 * Narrow a drop to the files Toril can open, preserving order.
 *
 * Returns everything openable rather than just the first: dropping a selection
 * of notes should open the selection. Non-matching entries are dropped
 * silently here — the caller reports the count, because "3 of 5 opened" is the
 * useful message and this function has no business composing it.
 */
export function selectOpenable(paths: readonly string[]): string[] {
  return paths.filter(isOpenablePath);
}
