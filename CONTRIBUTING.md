# Contributing to Toril

Thanks for your interest in Toril — a MarkText-style WYSIWYG markdown editor built on
**Tauri + TypeScript + Milkdown**. This guide covers how to set up, what the
non-negotiable rules are, and how to get a change merged.

> **Read [`CLAUDE.md`](./CLAUDE.md) first.** It is the authoritative design document:
> the decided stack (§2), the data-safety rules (§3), the backend↔frontend command
> contract (§5), the milestone plan (§8), and the project conventions (§10). This file
> is the human-friendly front door; `CLAUDE.md` is the source of truth when the two
> seem to disagree.

---

## The Kovir Labs ethos

Toril is a [Kovir Labs](https://github.com/kovirlabs) project. Kovir Labs exists to fill in the gaps others overlook, and every contribution is weighed against these principles:

- **Write once, benefit all.** Build tools that can serve almost anyone in a field, not one client. Keep a generic core and put anything specific to an organization into configuration instead of custom code.
- **Focus on the underserved.** That means organizations and sectors that need help and development, and technology that needs help and development.
- **Find the efficiencies nobody has built yet.** Look for the gains that haven't been made in a sector or a software stack, and make them.

The principles stay firm. Ideas, features and approaches are open to anyone, as long as they respect the principles. They are also the filter for choosing which work to take on, whether it's our idea or a contributor's.

---

## Scope

Toril is, for now, a focused **markdown** editor. The roadmap runs through Phase 4 (§8):
MarkText parity, then polish and a Windows release. Multi-format editing (JSON/XML/YAML/…)
is a deliberately **deferred** future idea (§12), not current work — please don't open PRs
that build it into the current milestones.

If you're unsure whether something is in scope, open a
[Discussion](https://github.com/kovirlabs/toril/discussions) or an issue before writing code.

---

## Prerequisites

- **Rust** stable (via [`rustup`](https://rustup.rs/)) — the crates use **edition 2024**.
- **Node.js** LTS and **pnpm** (enable it with `corepack enable pnpm`).
- Platform webview toolchain for running/building the app:
  - **Windows:** Microsoft C++ Build Tools (MSVC) + the WebView2 runtime (preinstalled on Win11).
  - **Linux:** `libwebkit2gtk-4.1-dev` + `pkg-config` (plus `libappindicator3-dev`, `librsvg2-dev`, `patchelf` for bundling).
  - **macOS:** Xcode command-line tools.

### Build-environment note (important)

The Rust **app** crate links against the system webview. On a machine *without* those deps,
you can still do most contribution work — the frontend (`pnpm build` / `test` / `typecheck`)
and the logic crates (`fsatomic`, `vaultscan`) build and test fine. Only `pnpm tauri dev`,
`pnpm tauri build`, and a full `cargo build` need the webview toolchain. **GUI flows
(dialogs, tabs, sidebar, watcher reloads) must be verified in a real window** on a
webview-capable machine before claiming they work.

---

## Getting started

```bash
pnpm install            # first time
pnpm tauri dev          # run the app (opens the window)

pnpm test               # vitest — round-trip + tabs + security (jsdom)
pnpm typecheck          # tsc --noEmit (TS strict)
pnpm build              # tsc + vite build (frontend only)

cd src-tauri && cargo test -p fsatomic -p vaultscan   # logic crates (no webview needed)
cd src-tauri && cargo fmt --all && cargo clippy        # clean before every commit
```

Project layout is documented in `CLAUDE.md` §4 (frontend at the repo root in `src/`,
Rust backend in `src-tauri/`).

---

## The non-negotiable rules

These come from `CLAUDE.md` §3 (Data Safety) and §10. A change that violates any of them
will not be merged, no matter how nice the feature is. This is a notes app — the user's
writing is the only thing that truly matters.

1. **Atomic saves.** Never write a file in place. Writes go through the `fsatomic` crate
   (temp file + fsync + atomic rename). A crash mid-save must never corrupt a note.
2. **One canonical markdown representation.** All markdown ⇄ document conversion goes through
   **`src/editor/serializer.ts`** and nowhere else. Never introduce a second conversion path
   or keep two diverging buffers.
3. **Treat opened/pasted content as untrusted.** Anything rendered in the webview must pass
   through `src/sanitize.ts`. A `.md` file can carry hostile HTML.
4. **All disk I/O lives in Rust.** The frontend never touches the filesystem directly — it
   calls a Tauri command via `src/ipc.ts`. New backend calls go in the command contract (§5).
5. **Keep `.md` files plain and portable.** When two designs compete, prefer the one that
   stays Obsidian-vault compatible (no proprietary container, no sidecar lock-in).

If a feature would compromise data safety, the feature loses.

---

## Dependencies

- **Pin everything.** `Cargo.lock` is committed; `package.json` uses exact versions. Upgrade
  deliberately, never on a whim.
- **Only healthy packages** (§2/§10). Never add a dependency that is deprecated, unmaintained,
  or low-reputation — check the npm/crates.io `deprecated` flag, recent publish history, and
  publisher reputation before adding. If a feature's *only* viable dependency is unhealthy,
  **defer the feature** (note it in §8) rather than shipping the bad dep.
- **Don't touch `src-tauri/third-party/glib/`.** It's gtk-rs `glib` vendored verbatim except a
  single security patch, wired in via `[patch.crates-io]` (see `CLAUDE.md` §2 and the
  `Cargo.toml` comment). It is excluded from the workspace on purpose — don't fmt/lint/edit it.

---

## Code style

- **Rust:** edition 2024; `cargo fmt --all` and `cargo clippy` must be clean before you commit.
- **TypeScript:** `strict` mode on; **no `any`**.
- Write code that reads like its surroundings — match the existing naming and idiom.

---

## Tests and gates

Every change must keep the suite green. Add tests for new behavior; the round-trip and
atomic-save gates are mandatory and predate features by design (§8, §11).

- **Round-trip gate** — `pnpm test` (`tests/roundtrip.test.ts`): source ⇄ WYSIWYG must not
  lose or mangle content (CommonMark + GFM + emoji today).
- **Atomic-save gate** — `cargo test -p fsatomic`: interrupting a save leaves the original intact.
- **Data-safety / sanitize** — `tests/security.test.ts`.
- Plus `vaultscan` and `tabs` tests.

Run `pnpm test`, `pnpm typecheck`, and `cargo test -p fsatomic -p vaultscan` before opening a PR.
If a change affects GUI flows, verify it in a live window and say so in the PR.

---

## Commits and pull requests

- **One logical change per branch.** Branch off `main`.
- **[Conventional Commits](https://www.conventionalcommits.org/):** `feat:`, `fix:`, `docs:`,
  `chore:`, `ci:`, etc. Scope is optional (e.g. `feat(editor): …`).
- **Open a PR against `main`.** Describe what changed and why; note any GUI verification done
  and call out anything left unverified.
- **Keep `CLAUDE.md` in sync.** If you change the command contract (§5), the milestones (§8),
  or any data-safety behavior (§3), update the relevant section in the same PR.
- CI builds the app on push of a `v*` tag and publishes a release (`.github/workflows/release.yml`).

---

## Reporting bugs and ideas

- **Bugs:** open an [issue](https://github.com/kovirlabs/toril/issues). Include your OS, what you
  did, what you expected, and what happened. For anything involving losing or mangling note
  content, say so prominently — data-safety bugs are top priority.
- **Questions and proposals:** start a [Discussion](https://github.com/kovirlabs/toril/discussions).

---

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), the same license as the project. There is no CLA.
