# Design — CI PR Gates (`ci/pr-gates`)

> Toril has gates (CLAUDE.md §8) but nothing runs them. The only workflow is
> `release.yml`, which fires on a `v*` tag and builds — it never runs a test. So
> every gate is a discipline rather than a guarantee, and a regression is caught
> only if whoever is at the keyboard remembers to look.
>
> This adds a `CI` workflow that runs the gates on every pull request.

- **Date:** 2026-07-25
- **Branch:** `ci/pr-gates`, off `main`
- **Status:** approved design → implementation

---

## 1. Goal & non-goals

**Goal.** Every pull request automatically runs the gates that can run without a
human: the frontend suite, the frontend build, and the webview-free Rust crates —
on both Linux and Windows.

**Non-goals.**

- **No interactive GUI verification.** Dialogs, menus, and webview flows need a
  human driving a window (`pnpm tauri dev`). Out of reach for CI, by nature.
- **No macOS runner.** Nothing in the codebase is macOS-specific today — the
  macOS file-open handler is explicitly not yet wired (§5) — and macOS runners
  are the slowest and most expensive.
- **No Tauri app crate.** Building it needs the platform webview and its system
  dependencies. The logic crates are split out (§4) precisely so their gates run
  without that; CI uses the split rather than defeating it.
- **No `cargo clippy`.** Reasoning in §3.
- **No release or publish steps.** `release.yml` owns that and is unchanged.
- **No branch protection.** CI reports; it cannot require itself (§5).

---

## 2. Triggers & job layout

**Triggers:** `pull_request` (any base branch) and `push` to `main`. The push
trigger makes `main`'s health visible rather than assumed, and warms the pnpm and
cargo caches so PR runs start warm.

**Concurrency:** group on the ref with `cancel-in-progress: true`, so
force-pushing to a PR cancels the superseded run instead of paying for both.

**Two jobs, each matrixed across `ubuntu-latest` and `windows-latest`** — four
job-runs:

| Job | Runs |
|---|---|
| `frontend` | `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build` (Ubuntu only) |
| `crates` | `cargo test -p fsatomic -p vaultscan -p mdhtml -p mdrtf -p imgasset -p trashbin -p snapshots` → `cargo fmt --all --check` (Ubuntu only) |

**`fail-fast: false` on both matrices.** The default cancels sibling jobs on the
first failure, which would routinely hide "does this break on Windows too?" —
the one question the Windows jobs exist to answer. `release.yml` sets this for
the same reason.

### 2.1 Why the crates job names packages instead of `--workspace`

`--workspace` would pull in the Tauri app crate and therefore WebKitGTK on Linux
and WebView2 on Windows. Naming the seven logic crates keeps CI free of system
dependencies and fast, and it matches the split CLAUDE.md §4 already describes:
these crates exist so their gates run anywhere.

**All seven are named explicitly.** CLAUDE.md's §Commands block currently lists
only five — it predates `trashbin` and `snapshots` — so this branch corrects that
line too (§6). CI's list is the authoritative one.

### 2.2 Why Windows earns its slot

`pnpm install --frozen-lockfile` is the step that applies
`patches/@milkdown__preset-commonmark@7.21.1.patch`. On Windows that is a real
check, not a formality: `.gitattributes` marks `patches/** -text` specifically so
Git-for-Windows' `core.autocrlf=true` cannot CRLF-ify the patch, because pnpm's
patch parser splits on `\n` without stripping `\r` and would fail to apply it.
Nothing verifies that fix today.

If it regresses, the Windows job fails twice over: the install errors outright,
and — were it to somehow half-apply — the `preserved` fixtures in `pnpm test`
fail, since they depend on the patched serializer.

`fsatomic` also earns Windows. It implements §3.1 (a crash mid-save must never
corrupt a note) and is the one crate making real filesystem syscalls rather than
doing pure computation. Atomic replace-over-existing is where platforms diverge —
`std::fs::rename` maps to `rename(2)` on Linux but `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING` on Windows, with different behavior around open
handles. Gating the most safety-critical crate only on the platform users are not
on is the gap worth closing.

---

## 3. Mechanics

**File:** `.github/workflows/ci.yml`, `name: CI`.

Job names surface in the PR checklist as `frontend (ubuntu-latest)`,
`frontend (windows-latest)`, `crates (ubuntu-latest)`, `crates (windows-latest)`
— enough to see which half broke without opening logs.

**Reuse `release.yml`'s choices verbatim** rather than inventing new ones:

| Concern | Action |
|---|---|
| pnpm | `pnpm/action-setup@v4`, `version: 11` |
| Node | `actions/setup-node@v4`, `node-version: lts/*`, `cache: pnpm` |
| Rust | `dtolnay/rust-toolchain@stable` |
| Cargo cache | `swatinem/rust-cache@v2`, `workspaces: ./src-tauri -> target` |

**`pnpm build` is included, Ubuntu only.** `typecheck` runs `tsc --noEmit` and
never exercises the Vite bundle, so a broken `vite.config.ts`, bad import path,
or asset-resolution failure passes every other check and surfaces at
`pnpm tauri build` — when a release tag is already pushed. It costs seconds.
Ubuntu only because bundling is platform-independent.

**`cargo fmt --all --check` is included, Ubuntu only.** Fast, near-deterministic,
and CLAUDE.md §10 already requires it before every commit. It catches formatting
churn in diffs.

It is safe against the vendored `glib` where clippy is not, and the asymmetry is
worth understanding rather than rediscovering: `--all` means *all workspace
members*, and `glib` is `exclude`d from the workspace (§2), so `fmt` never sees
it. Clippy reaches it anyway because it **compiles** the dependency graph, and a
path dependency does not get `--cap-lints allow`.

**`cargo clippy` is deliberately excluded.** Two reasons, and the second is not
obvious:

1. To be more than decorative it needs `-D warnings`, and new stable Rust
   releases regularly add lints — so it fails on pull requests that changed
   nothing relevant. A red X that is routinely not the author's fault erodes
   trust in every other red X.
2. It could not use `--workspace` here anyway. The vendored `glib` (§2) is wired
   in via `[patch.crates-io]` as a **path** dependency, and path dependencies do
   not get `--cap-lints allow` the way registry dependencies do — so clippy lints
   vendored upstream code we have a standing rule never to touch, currently 34
   warnings. It would have to be scoped with the same `-p` list as the tests.

Clippy stays a pre-commit discipline per §10.

**Floating toolchains are a deliberate choice.** `dtolnay/rust-toolchain@stable`
and `node-version: lts/*` both move. That is right for a project shipping
binaries — a silently-aging toolchain is the worse failure — but it means CI can
go red on a PR that changed nothing relevant. When that happens it is a toolchain
bump, not the diff.

---

## 4. Boundaries

CI covers what runs headlessly. It does not cover:

- Interactive GUI flows — dialogs, menus, the file watcher's reload prompt, the
  history panel. These need a human and `pnpm tauri dev`.
- macOS, and the Tauri app crate on any platform.
- The packaged installers — `release.yml` builds those at tag time.

---

## 5. What CI cannot do for itself — branch protection

**A workflow reports; it does not block.** Until a branch protection rule on
`main` marks these checks required, a red X is advisory and the pull request stays
mergeable.

That is a repository settings change, and it belongs to the repository owner —
not to this branch and not to an agent. Do it after the first green run, once the
check names have rendered and can be selected by name.

**Validation.** The workflow can only be proven by a real pull request, and it
proves itself: for same-repo pull requests GitHub runs the workflow **as it exists
on the PR branch**, so this branch's own PR is the test. It is deliberately kept
off PR #25 — separate concern, and mixing a CI change into a data-safety branch
muddies both reviews.

---

## 6. Docs to update on this branch

- **CLAUDE.md §8** — the gate list reads as commands to run by hand. Note which
  are now automatic on every PR and which stay manual (interactive GUI, macOS,
  the app crate).
- **CLAUDE.md §Commands** — the logic-crate line lists five crates; `trashbin`
  and `snapshots` are missing. Correct it to the seven CI runs.
- **CLAUDE.md §9** — mention `ci.yml` beside `release.yml` so the workflow set is
  discoverable from the packaging section.

> **Merge-order note.** PR #25 (`fix/serializer-normalization`) also edits
> CLAUDE.md §8 and §Commands. Whichever merges second will need a small manual
> conflict resolution in those two spots. Keep both sets of changes — they are
> complementary, not competing.

---

## 7. Definition of done

- `.github/workflows/ci.yml` exists and runs on `pull_request` and `push` to
  `main`, with concurrency cancellation.
- Four job-runs: `frontend` and `crates`, each on `ubuntu-latest` and
  `windows-latest`, with `fail-fast: false`.
- The `crates` job names all seven logic crates and installs no system
  dependencies.
- `pnpm build` and `cargo fmt --all --check` run on Ubuntu only.
- `release.yml` is untouched.
- This branch's own PR shows four green checks.
- Docs in §6 updated.
- Branch protection is **reported to the repository owner as their action**, not
  attempted.
