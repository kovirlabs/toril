# Security Policy

Toril is a local-first desktop Markdown/HTML editor (Tauri + Rust + TypeScript).
It has **no backend, no cloud sync, no account system, and no telemetry** — your
notes are plain files on your own disk. That shapes the threat model below.

## Supported Versions

Toril is pre-1.0 (currently **`v1.0.0-beta.1`**). Security fixes land on the latest
release and `main` only; there are no maintained back-release branches yet.

| Version | Supported |
| ------- | --------- |
| Latest release (`v1.0.0-beta.x`) + `main` | :white_check_mark: |
| Any older release | :x: |

When Toril reaches a stable `1.0`, this table will move to a real
supported-versions policy.

## Reporting a Vulnerability

**Please report security issues privately — do not open a public issue.**

Use GitHub's **private vulnerability reporting**:
**[Security → Report a vulnerability](https://github.com/kovirlabs/toril/security/advisories/new)**
(or the **Report a vulnerability** button on the repository's Security tab).

What to expect:

- **Acknowledgement** within ~7 days.
- An assessment (accepted / needs-more-info / declined, with reasoning) after that.
- For accepted reports, a fix on `main` and the next release, with credit in the
  release notes / advisory if you'd like it.

This is a hobby/beta project maintained in spare time, so timelines are
best-effort — thank you for your patience, and for reporting responsibly.

## Security Model & Hardening

These are the deliberate, load-bearing security properties (see
[CLAUDE.md §3](./CLAUDE.md) for the full data-safety contract):

- **Opened files are untrusted.** A `.md`/`.html` file — or pasted content — can
  carry hostile HTML. Everything rendered in the webview is sanitized (DOMPurify,
  `src/sanitize.ts`) so embedded markup cannot execute script.
- **Atomic saves.** Writes go to a temp file, fsync, then atomic rename, so a crash
  mid-save can't corrupt an existing note.
- **Filesystem access stays in Rust.** The frontend never touches the disk directly;
  it goes through a fixed set of Tauri commands.
- **Dependency hygiene.** Dependencies are pinned (npm exact versions; `Cargo.lock`
  committed) and only healthy/maintained packages are adopted. **Dependabot**
  security updates and **secret scanning + push protection** are enabled, and a
  security regression suite (`tests/security.test.ts`) guards the sanitize boundary.
- One vendored exception is documented: a security-patched `glib`
  (GHSA-wrw7-89jp-8q8g) wired in via `[patch.crates-io]`; rationale is in
  `src-tauri/Cargo.toml`.

## Known Limitations (please don't report these as vulnerabilities)

- **Installers are unsigned.** On first run, Windows SmartScreen ("Windows protected
  your PC") and macOS Gatekeeper will warn — this is expected for an unsigned build,
  not a compromise. Code signing (Azure Trusted Signing) is planned; see
  [WINDOWS-SIGNING.md](./WINDOWS-SIGNING.md).
- **Beta software.** Expect rough edges; keep backups of important notes.
