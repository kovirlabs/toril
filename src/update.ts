// Update-check policy (ROADMAP Movement I.5).
//
// `v1.0.0` shipped with no update path at all, so every installed copy is
// stranded on the version it was installed with. This module is the decision
// layer that fixes that — *when* Toril asks whether a newer build exists, and
// *whether* the answer is worth interrupting the user for.
//
// It is deliberately pure: no DOM, no `invoke`, no clock of its own. The network
// call lives in `ipc.ts` and the banner in `ui/updatebar.ts`, so the rules below
// are gated headlessly (§8) rather than discovered by waiting a day for a timer
// to elapse on a device.
//
// **Toril notifies; it never installs behind you.** There is no silent
// download-and-replace: this is an editor that holds unsaved buffers, and §3
// says the user's writing outranks convenience. Swapping the binary under a live
// document to save someone two clicks is not a trade we make. The plugin *can*
// auto-install; we don't call it that way.
//
// No telemetry either — the check is a plain GET for a static manifest. Nothing
// about the user, the vault, or the session goes with it.

/** How long a startup check stays satisfied. Once a day is plenty for an editor. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * What triggered the check, which is the single input that changes every rule
 * below.
 *
 * `"startup"` is Toril's own idea and must stay quiet: rate-limited, skippable,
 * silent when there is nothing to say. `"manual"` is the user asking a direct
 * question via Help → Check for Updates, and a direct question always gets a
 * direct answer — it ignores the interval, ignores a previous skip, and reports
 * "you are up to date" and failures out loud. Collapsing the two is how update
 * checkers end up either nagging or appearing broken.
 */
export type UpdateTrigger = "startup" | "manual";

/** The persisted half of the policy's input. */
export interface UpdateState {
  /** Whether automatic startup checks are on. */
  enabled: boolean;
  /** Epoch ms of the last completed check, or null if never. */
  lastCheckedAt: number | null;
  /** A version the user dismissed, which startup will not raise again. */
  skippedVersion: string | null;
}

export type CheckDecision =
  | { kind: "check" }
  | { kind: "skip"; reason: "disabled" | "too-soon" };

/**
 * Decide whether to ask the network at all.
 *
 * Note the clock handling: a `lastCheckedAt` in the *future* counts as due. A
 * timezone change or a corrected system clock can otherwise park that timestamp
 * years ahead and silently disable update checks forever — the failure mode is
 * invisible, so it fails open instead.
 */
export function decideCheck(
  trigger: UpdateTrigger,
  state: UpdateState,
  now: number,
  intervalMs: number = CHECK_INTERVAL_MS,
): CheckDecision {
  if (trigger === "manual") return { kind: "check" };
  if (!state.enabled) return { kind: "skip", reason: "disabled" };
  if (state.lastCheckedAt === null) return { kind: "check" };
  const elapsed = now - state.lastCheckedAt;
  if (elapsed < 0) return { kind: "check" }; // clock moved back — see above
  return elapsed >= intervalMs ? { kind: "check" } : { kind: "skip", reason: "too-soon" };
}

/** What the network said. `null` from the plugin means "no update available". */
export interface UpdateFound {
  version: string;
  /** Release notes, when the manifest carries them. */
  notes?: string;
}

export type Presentation =
  | { kind: "offer"; version: string; notes?: string }
  | { kind: "up-to-date" }
  | { kind: "error"; message: string }
  | { kind: "silent" };

/**
 * Decide what the user sees once the check returns.
 *
 * The asymmetry is the whole point. A startup check that finds nothing, or
 * fails, says nothing — a failed background request is Toril's problem, not the
 * writer's, and an editor that pops "could not reach the update server" over a
 * paragraph is worse than one that quietly tries again tomorrow. A manual check
 * reports every outcome, because silence in answer to a direct question reads as
 * a broken button.
 */
export function decidePresentation(
  trigger: UpdateTrigger,
  result: UpdateFound | null,
  state: UpdateState,
): Presentation {
  if (result === null) {
    return trigger === "manual" ? { kind: "up-to-date" } : { kind: "silent" };
  }
  // A version the user already dismissed stays dismissed for automatic checks
  // only: skipping is "stop telling me", not "never let me have it".
  if (trigger === "startup" && result.version === state.skippedVersion) {
    return { kind: "silent" };
  }
  return { kind: "offer", version: result.version, notes: result.notes };
}

/**
 * Presentation for a check that threw.
 *
 * Split from {@link decidePresentation} rather than folded in as a third result
 * shape, because the caller reaches it from a `catch` and there is no
 * {@link UpdateFound} to pass. Same asymmetry: loud when asked, silent when not.
 */
export function decideErrorPresentation(
  trigger: UpdateTrigger,
  message: string,
): Presentation {
  return trigger === "manual" ? { kind: "error", message } : { kind: "silent" };
}
