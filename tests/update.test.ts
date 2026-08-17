// GATE for the update-check policy (ROADMAP Movement I.5, `feat/release-readiness`).
//
// `v1.0.0` shipped with no update path, so this is the branch that gives an
// installed copy a way forward. The rules that matter are not "does an HTTP call
// succeed" — that needs a release server — but *when Toril asks* and *when it is
// willing to interrupt someone who is writing*. Both are pure, so both are
// pinned here rather than discovered on a device a day later.
//
// The through-line: a startup check is Toril's own idea and must stay quiet; a
// manual check is the user asking a question and always gets an answer.
import { describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  decideCheck,
  decideErrorPresentation,
  decidePresentation,
  type UpdateState,
} from "../src/update";

const NOW = 1_700_000_000_000;

function state(over: Partial<UpdateState> = {}): UpdateState {
  return { enabled: true, lastCheckedAt: null, skippedVersion: null, ...over };
}

describe("decideCheck", () => {
  it("checks on first run, when there is no previous check to rate-limit against", () => {
    expect(decideCheck("startup", state(), NOW)).toEqual({ kind: "check" });
  });

  it("does not check at startup when automatic checks are off", () => {
    expect(decideCheck("startup", state({ enabled: false }), NOW)).toEqual({
      kind: "skip",
      reason: "disabled",
    });
  });

  it("rate-limits startup to once per interval", () => {
    const recent = state({ lastCheckedAt: NOW - 1000 });
    expect(decideCheck("startup", recent, NOW)).toEqual({ kind: "skip", reason: "too-soon" });
  });

  it("checks again once the interval has elapsed", () => {
    const stale = state({ lastCheckedAt: NOW - CHECK_INTERVAL_MS });
    expect(decideCheck("startup", stale, NOW)).toEqual({ kind: "check" });
  });

  // The boundary itself, not just either side of it: an off-by-one here means
  // either a double check or a day's silence, and neither is visible in use.
  it("treats exactly one interval as due, and a millisecond less as not", () => {
    expect(decideCheck("startup", state({ lastCheckedAt: NOW - CHECK_INTERVAL_MS }), NOW)).toEqual({
      kind: "check",
    });
    expect(
      decideCheck("startup", state({ lastCheckedAt: NOW - CHECK_INTERVAL_MS + 1 }), NOW),
    ).toEqual({ kind: "skip", reason: "too-soon" });
  });

  // A corrected system clock or a timezone jump can park the stored timestamp in
  // the future. Failing closed there disables update checks permanently, with no
  // symptom the user could ever notice.
  it("fails open when the clock has moved backwards", () => {
    const future = state({ lastCheckedAt: NOW + 30 * CHECK_INTERVAL_MS });
    expect(decideCheck("startup", future, NOW)).toEqual({ kind: "check" });
  });

  it("always checks when the user asks directly, whatever the state says", () => {
    const hostile = state({
      enabled: false,
      lastCheckedAt: NOW,
      skippedVersion: "9.9.9",
    });
    expect(decideCheck("manual", hostile, NOW)).toEqual({ kind: "check" });
  });
});

describe("decidePresentation", () => {
  it("offers an update found at startup", () => {
    expect(decidePresentation("startup", { version: "1.1.0" }, state())).toEqual({
      kind: "offer",
      version: "1.1.0",
    });
  });

  it("carries release notes through when the manifest has them", () => {
    const found = { version: "1.1.0", notes: "Fixes a thing" };
    expect(decidePresentation("manual", found, state())).toEqual({
      kind: "offer",
      version: "1.1.0",
      notes: "Fixes a thing",
    });
  });

  it("says nothing at startup when there is no update", () => {
    expect(decidePresentation("startup", null, state())).toEqual({ kind: "silent" });
  });

  it("says so out loud when the user asked and there is no update", () => {
    expect(decidePresentation("manual", null, state())).toEqual({ kind: "up-to-date" });
  });

  it("does not raise a version the user dismissed", () => {
    const dismissed = state({ skippedVersion: "1.1.0" });
    expect(decidePresentation("startup", { version: "1.1.0" }, dismissed)).toEqual({
      kind: "silent",
    });
  });

  // Skipping one version must not opt out of the next one — otherwise a single
  // "not now" quietly turns automatic updates off for good.
  it("still raises a newer version after an earlier one was dismissed", () => {
    const dismissed = state({ skippedVersion: "1.1.0" });
    expect(decidePresentation("startup", { version: "1.2.0" }, dismissed)).toEqual({
      kind: "offer",
      version: "1.2.0",
    });
  });

  // "Stop telling me" is not "never let me have it".
  it("shows a dismissed version again when the user asks directly", () => {
    const dismissed = state({ skippedVersion: "1.1.0" });
    expect(decidePresentation("manual", { version: "1.1.0" }, dismissed)).toEqual({
      kind: "offer",
      version: "1.1.0",
    });
  });
});

describe("decideErrorPresentation", () => {
  it("swallows a background failure", () => {
    expect(decideErrorPresentation("startup", "offline")).toEqual({ kind: "silent" });
  });

  it("reports a failure the user is waiting on", () => {
    expect(decideErrorPresentation("manual", "offline")).toEqual({
      kind: "error",
      message: "offline",
    });
  });
});
