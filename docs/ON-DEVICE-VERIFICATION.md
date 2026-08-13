# On-Device Verification

CI covers the headless gates: `pnpm typecheck` / `test` / `build` and `cargo test` over
the nine logic crates, on Ubuntu and Windows (CLAUDE.md §8). A green PR means those
passed — **not** that the app was driven.

This file is the standing list of what a green PR cannot tell you: interactive flows
that need a human with a window, a real installer, or a real device. CLAUDE.md §0 and §8
repeatedly say "interactive GUI verification outstanding" without listing what; this is
that list.

**Convention:** check an item off when verified against a specific version, and note the
version. Items do not stay checked across releases when the surrounding code changed —
re-verify anything a branch touched.

---

## How to run

### Linux (this dev box)

The desktop session must be logged in (via noVNC) so a real display exists; the
greeter's display is not usable.

```bash
pnpm dev                          # vite on :1420 — the debug binary loads devUrl, not a bundle
cargo build --manifest-path src-tauri/Cargo.toml

DISPLAY=:0 \
GDK_BACKEND=x11 \
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  ./src-tauri/target/debug/toril-app <file.md>
```

If the window fails to appear, find the session's X authority file
(`ps -eo user,cmd | grep Xwayland`) and pass it as `XAUTHORITY=`. `libEGL DRI3` warnings
are harmless — this box software-renders over VNC.

> **Known hazard:** native file dialogs (Save As / Open / Open Folder) **hang the app**
> on this box even with `xdg-desktop-portal` running — the chooser most likely opens
> off-screen. Bypass by passing a file path as a launch argument; `Ctrl+S` on a
> path-backed tab saves without a dialog. This is item **B7** below.

> **Frame rate here is meaningless.** Software rendering over VNC. Never judge animation
> smoothness on this box — that is what the Surface Pro is for.

### Windows (Surface Pro — the primary target, CLAUDE.md §1)

```powershell
pnpm install
pnpm tauri dev              # development
pnpm tauri build            # installer, for the packaging items
```

---

## A. Chrome rework (`feat/chrome-ux`, 2026-08-12)

Design: [`docs/superpowers/specs/2026-08-12-ui-ux-chrome-rework-design.md`](./superpowers/specs/2026-08-12-ui-ux-chrome-rework-design.md)

- [ ] **A1 — Native menu accelerators.** `Ctrl+N` / `Ctrl+S` / `Ctrl+E` etc. render
      right-aligned in grey, not baked into the label text. Confirm each fires **once**
      (the reason accelerators were originally omitted was double-firing against the
      frontend keydown handler).
- [ ] **A2 — Menu mnemonics.** `Alt+F` opens File; arrow keys traverse; `Esc` closes.
      Windows-only behavior — GTK does not exercise this path.
- [ ] **A3 — Touch targets.** With the keyboard detached (tablet mode), tabs, pane
      toggles, format buttons, and file-tree rows are comfortably tappable by fingertip.
      With the keyboard attached they should stay compact — the rule keys on
      `pointer: coarse`, i.e. the *primary* pointer.
- [ ] **A4 — 200% DPI.** Borders stay crisp (no half-pixel blur), icons are sharp, and
      the 40px targets scale correctly rather than becoming 80 physical px of dead space.
- [ ] **A5 — Animation smoothness in WebView2.** Pane collapse/expand and rail tab
      changes hold 60fps. 140–180ms should read as immediate but continuous.
- [ ] **A6 — Window snap layouts and edge-drag resize.** Chrome behaves while the window
      is being resized, including mid-animation. Panes clamp rather than overflow.
- [ ] **A7 — `system-ui` resolves to Segoe UI Variable.** Confirm the UI is *not*
      rendering in Arial (it was, before this branch — Inter was named but never bundled).
- [ ] **A8 — Pane resize by drag.** Handles are grabbable, the drag tracks the pointer,
      dragging below the minimum snaps to collapsed, and the width persists across a
      restart.
- [ ] **A9 — Collapsed panes are not tab-reachable.** *(Low risk — belt and braces.)*
      Two independent guards keep focus out of a collapsed pane: `inert` (verified in
      Chromium = WebView2, but engine-dependent) and a `visibility: hidden` delayed by the
      collapse duration (needs no feature support anywhere). Correctness does not rest on
      either alone. Worth one Tab-key pass to confirm, not worth worrying about.
- [ ] **A10 — Reduced motion.** Turn on Windows' *Show animations* → off. All pane and
      rail motion should become instant, with no layout breakage.

## B. Standing items (pre-existing, not from this branch)

- [ ] **B1 — HTML as a first-class format.** Open a real AI-authored `.html` artifact,
      edit it, save, reopen. Confirm the supported subset survives and unsupported markup
      is cleanly normalized rather than mangled. (CLAUDE.md §0, HTML follow-ups.)
- [ ] **B2 — File-association open.** Double-click a `.md` and an `.html` from Explorer,
      and "Open with → Toril". First launch arrives via `argv[1]`; a *second* launch
      while running must be forwarded by the single-instance plugin as an `open-file`
      event rather than spawning a duplicate process.
- [ ] **B3 — Sync-coexistence wiring.** `crates/mergemd`, `src/sync.ts`, `src/paths.ts`
      and the tab bookkeeping are gated in isolation, but **the glue in `main.ts`
      (`reconcile`, `recheckBeforeWrite`, autosave/Save-All gating, the conflict banner)
      has no test harness.** Drive it against a live Obsidian vault: edit externally
      while a tab is open, confirm the banner appears, and confirm both resolutions park
      the losing side via `write_conflict_copy`.
- [ ] **B4 — The `missing` outcome.** Delete a file on disk while its tab is open.
      `commands/sync.rs` produces `missing` and has **no tests of its own**. Confirm
      autosave leaves it alone and only an explicit save recreates it (an Obsidian rename
      is a delete + create; an unattended recreate would duplicate the note).
- [ ] **B5 — Version history end to end.** Save several times, open the history panel,
      diff, restore, and confirm the restore is itself undoable.
- [ ] **B6 — OS keychain (`keystore::OsKeychain`).** Not covered by CI: Linux runners have
      no Secret Service, and a silently-skipping test reads as coverage without being
      coverage. Needs a logged-in desktop session. *(Currently unreachable from the UI by
      design — re-check when ROADMAP branch 20 wires the AI panel.)*
- [ ] **B7 — Native dialog hang on Linux/VNC.** Save As / Open / Open Folder freeze the
      app on this box. Pre-existing, unrelated to any feature branch, and worth its own
      investigation. Verify whether it reproduces on a normal Linux desktop or is purely
      a VNC artifact.
- [ ] **B8 — Installer behavior.** NSIS installs per-user into `%LOCALAPPDATA%\Toril`
      with **no UAC prompt**, and the WebView2 bootstrapper runs on a clean Win10 box.
      README states both as user-facing guarantees (CLAUDE.md §9).
- [ ] **B9 — SmartScreen.** Unsigned installers warn on first run. Expected, not a bug —
      until Azure Trusted Signing lands (ROADMAP Movement I, `feat/release-readiness`).
- [ ] **B10 — macOS.** Not a target (CLAUDE.md §1) and entirely unverified. Note in
      particular that macOS delivers file-opens via `RunEvent::Opened`, **not** argv, and
      that handler is not wired — B2 will fail there until it is.
