<!--
Thanks for contributing. CONTRIBUTING.md has the full guide; this template only
asks for what CI can't work out on its own.

CI already runs pnpm typecheck/test/build and the Rust logic crates on Ubuntu and
Windows, so there's no need to paste test output — just make sure the checks are
green.
-->

## What and why

<!-- What changed, and what problem it solves. Link the issue if there is one. -->

## Data safety

<!--
CLAUDE.md §3 is non-negotiable: atomic saves, one canonical representation per
format, opened files are untrusted. Delete this section if the change can't
touch any of them (docs, CI, styling).
-->

- [ ] Touches saving, the serializers, or sanitization — and I've said how below
- [ ] Adds or changes a Tauri command (the §5 contract is updated in this PR)

## Verification beyond CI

<!--
The part that matters most. CI can't drive a window, so say what you exercised by
hand and — just as usefully — what you didn't. "Unverified: the reload prompt, no
Windows machine" is a genuinely helpful sentence, not an admission.
-->

- **Verified in a live window** (`pnpm tauri dev`):
- **Not verified:**

## Docs

- [ ] `CLAUDE.md` updated if this changes the command contract (§5), the
      milestones (§8), or any data-safety behavior (§3)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if users would notice this

<!--
Commits follow Conventional Commits (feat:, fix:, docs:, chore:, ci:). One
logical change per branch, opened against main.
-->
