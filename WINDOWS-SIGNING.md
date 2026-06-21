# Windows Code Signing & Installer Quirks

Reference notes for Toril's Windows distribution: what the installer had to work
around, and the current state of code signing. See also `TODO.md` and
*ROADMAP.md → Movement I → `feat/release-readiness`*.

## TL;DR

The released Windows installers are **unsigned** — including `v1.0.0-beta.1`.
Nothing in the project bypasses, suppresses, or "gets around" the SmartScreen
warning. On a fresh machine the first run shows **"Windows protected your PC"**
→ *More info → Run anyway*. That is expected for an unsigned build, not a bug.

There is no legitimate way to remove that warning without a code-signing
certificate — SmartScreen reputation is tied to a signing identity, and an
unsigned binary always starts from zero.

## Current signing state

- `src-tauri/tauri.conf.json` has **no** `bundle.windows.signCommand`.
- `.github/workflows/release.yml` has **no** signing step or signing secrets.
- Result: every Windows asset on every release so far is unsigned.

## Windows quirks that *were* solved (none of these is code signing)

These are the real Windows-specific hurdles the project handled. They're easy to
misremember as "getting around signing," but they're separate concerns.

1. **MSI can't encode a pre-release version.** Windows Installer versions are
   4-part numeric (`a.b.c.d`) and only accept a *numeric* pre-release field, so a
   semver tag like `1.0.0-beta.1` fails to bundle:
   `optional pre-release identifier in app version must be numeric-only …`.
   Worked around by dropping MSI and shipping **NSIS only**
   (`Toril_<version>_x64-setup.exe`). `bundle.targets` is an explicit list that
   excludes `msi`. Revisit MSI only for a final numeric release (`x.y.z`).

2. **No admin / UAC prompt.** The NSIS installer does a **per-user** install into
   `%LOCALAPPDATA%\Toril` (Start Menu entry, optional desktop shortcut, Apps &
   features uninstall), so it never needs administrator rights. This avoids the
   UAC elevation prompt — *not* the SmartScreen warning.

3. **WebView2 runtime dependency.** `bundle.windows.webviewInstallMode =
   "downloadBootstrapper"` so Windows 10 machines lacking WebView2 fetch it during
   install. Windows 11 ships it preinstalled. Without this the app can't render.

4. **Build toolchain prerequisites.** Building on Windows needs MSVC C++ Build
   Tools + the WebView2 runtime; the Rust app crate links the system webview.

## The actual code-signing plan (still open)

To remove the SmartScreen warning properly, two real options:

- **Azure Trusted Signing** (~$10/month, OV-class) — the chosen long-term route.
  Builds SmartScreen reputation gradually over downloads/time; does **not** clear
  the warning instantly.
- **EV certificate** — clears SmartScreen immediately, but heavier identity
  process and more expensive.

### Implementation checklist (Azure Trusted Signing)

1. Set up an Azure Trusted Signing account + certificate profile (identity
   validation; choose individual vs. organization path).
2. Add `bundle.windows.signCommand` → `trusted-signing-cli` in
   `src-tauri/tauri.conf.json`.
3. Add `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` as GitHub
   Actions secrets and sign in the Windows job of `.github/workflows/release.yml`.
4. Soften the SmartScreen note in `README.md` and `docs/index.html` once signing
   is live.
