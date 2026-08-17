// The recent-files list (ROADMAP Movement I.5, was §13 backlog).
//
// Pure list arithmetic, kept out of the controller because every interesting
// property here is about *ordering and identity*, and both are easy to get
// subtly wrong in a way no one notices until the list is full of duplicates.
//
// **Paths only, never contents** — the same rule `session.json` already
// follows (§3.2). The list is a set of pointers to files on disk; it never
// becomes a second copy of anything.

/** How many entries the list keeps. Long enough to be useful, short enough to scan. */
export const RECENT_LIMIT = 10;

/**
 * Put `path` at the front, remove any earlier occurrence, and cap the length.
 *
 * Returns a **new array**; the caller's list is untouched. That matters because
 * the same list is read while rendering a menu, and mutating it in place turns
 * "open a file" into a visual glitch somewhere unrelated.
 *
 * Reopening a file already in the list must *move* it rather than add a second
 * entry, which is the whole reason this dedupes before it prepends.
 */
export function pushRecent(
  list: readonly string[],
  path: string,
  limit: number = RECENT_LIMIT,
): string[] {
  if (path === "") return [...list];
  return [path, ...list.filter((p) => p !== path)].slice(0, limit);
}

/**
 * Drop a path from the list — for a file that turned out to be gone.
 *
 * A recent entry that no longer resolves is worse than no entry: it offers the
 * user an action that can only fail. The controller calls this when an open
 * attempt reports the file missing.
 */
export function forgetRecent(list: readonly string[], path: string): string[] {
  return list.filter((p) => p !== path);
}

/**
 * Coerce whatever was persisted into a usable list.
 *
 * `session.json` is a file a user can edit and a file that can be truncated by
 * a crash, so this treats its contents as untrusted shape rather than assuming
 * an array of strings: a non-array, a null entry, or a number all have to
 * degrade to "no recents" instead of throwing during bootstrap, where an
 * exception would cost the user their whole restored session.
 *
 * Deduping on load as well as on push is not redundant — an older Toril, or a
 * hand-edited file, can supply a list this module never produced.
 */
export function normalizeRecent(
  value: unknown,
  limit: number = RECENT_LIMIT,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
