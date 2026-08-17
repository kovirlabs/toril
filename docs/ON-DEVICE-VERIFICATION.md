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

### Windows (the primary target, CLAUDE.md §1)

```powershell
pnpm install
pnpm tauri dev              # development
pnpm tauri build            # installer, for the packaging items
```

> **Driving it without a human, for the checks that allow it.** Much of section A
> is observable by screenshotting the real window and sending it real input, which
> is how the 2026-08-17 sweep below was run. Two things make it work: make the
> shell **DPI-aware** first (`SetProcessDpiAwarenessContext(-4)`) or
> `GetWindowRect` reports logical pixels while `CopyFromScreen` reads physical
> ones and every capture is a magnified corner; and raise the window with a real
> mouse click rather than `SetForegroundWindow`, which Windows' foreground lock
> refuses to a background shell. A freshly launched process comes up frontmost on
> its own, so relaunching beats fighting for focus.
>
> This does **not** replace the human items: touch targets in tablet mode, frame
> rate, and anything behind a system setting still need a person. And it drives
> the *user's live desktop* — keystrokes land wherever focus actually is, so
> confirm the target window before sending any.

---

## A. Chrome rework (`feat/chrome-ux`, 2026-08-12)

Design: [`docs/superpowers/specs/2026-08-12-ui-ux-chrome-rework-design.md`](./superpowers/specs/2026-08-12-ui-ux-chrome-rework-design.md)

- [x] **A1 — Native menu accelerators.** *(Verified 2026-08-17, `v1.0.0-beta.1` +
      `fix/on-device-sweep-followups`, Win11 24H2 / WebView2, 200% DPI.)* The shortcut
      column renders right-aligned in grey — `Ctrl+N`, `Ctrl+O`, `Ctrl+Shift+O`,
      `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+Alt+S`, `Ctrl+E` — and one `Ctrl+N` opens exactly
      **one** tab, so `src/actions.ts`'s 80ms collapse holds against a real accelerator
      firing alongside the webview keydown. This was the whole risk of registering them.
- [ ] **A2 — Menu mnemonics.** ❌ **Fails, and the obvious fix was not enough.**
      `Alt+F` did nothing because no label carried muda's `&` marker; the markers are
      now there (`&File`, `Save A&ll`, `&Find && Replace…`) and `Alt+F` *still* does not
      open the menu. Suspected cause one layer down: the WebView2 child window holds
      keyboard focus and eats `Alt` before the top-level window's menu bar sees
      `WM_SYSCHAR` — and a Tauri window is webview edge to edge, so there is no chrome
      to focus instead. Clicking the menu works. Next step is upstream (tao/muda key
      forwarding), not another label change. Arrow-key traversal and `Esc` are untested
      behind this.
- [ ] **A3 — Touch targets.** With the keyboard detached (tablet mode), tabs, pane
      toggles, format buttons, and file-tree rows are comfortably tappable by fingertip.
      With the keyboard attached they should stay compact — the rule keys on
      `pointer: coarse`, i.e. the *primary* pointer.
- [x] **A4 — 200% DPI.** *(Verified 2026-08-17 — the sweep box runs at 200%, so every
      capture in it is DPI evidence.)* Borders crisp with no half-pixel blur, icons and
      text sharp, chrome proportions unchanged from 100%.
- [ ] **A5 — Animation smoothness in WebView2.** Pane collapse/expand and rail tab
      changes hold 60fps. 140–180ms should read as immediate but continuous.
- [~] **A6 — Window snap layouts and edge-drag resize.** *(Partly verified 2026-08-17.)*
      Resized programmatically across ~810px, ~1000px and ~1100px CSS px: no overlap in
      WebView2, the toolbar reflows to two rows, and below `EXCLUSIVE_BELOW` (820px) the
      rail drops out rather than squeezing — §12b rule 7, on the engine the rule was
      written blind for. **Still human-only:** dragging the window edge *live* and Snap
      Layouts, where resize events arrive mid-animation.
- [x] **A7 — `system-ui` resolves to Segoe UI Variable.** *(Verified 2026-08-17.)* UI
      and prose both render in Segoe UI Variable, not Arial. This is the defect that
      motivated the branch, on the platform it was invisible from.
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

## C. Front-matter properties (`feat/frontmatter-properties`, 2026-08-17)

Step 6 of the design spec, and **none of it has been run in a window** — the browser
harness was unreachable this session (extension site permissions), so the strip's
rendered layout is unverified in either engine. The logic underneath it is gated
(`frontmatter`, `frontmatter-values`, `properties`, and the `frontMatter` class in
`roundtrip`); what follows is what those gates structurally cannot see.

- [ ] **C1 — A real vault note survives.** Open a note with properties from a live
      Obsidian vault, edit the *body* only, save, and confirm in Obsidian that the
      properties block is **byte-identical** (diff the file, don't eyeball it). Repeat
      with a note whose block Toril shows as raw (a comment or an anchor in it) — that
      is the case where an unnoticed rewrite would be worst.
- [ ] **C2 — A property edit marks the tab dirty and reaches disk.** Change one
      property, confirm the title shows the unsaved marker, save, reopen. This is the
      `loadEcho` interaction: the echo is armed with the whole file, so a block-only
      change must NOT be mistaken for a load echo. If it were, the edit would silently
      never be saved — and `main.ts` wiring has no test harness (§8).
- [ ] **C3 — Layout, measured not eyeballed** (§12b). At several window widths
      including the pane threshold ±1: the strip must not overlap the editor, the
      editor must stay inside `#main`, and the page must not scroll sideways — with
      `Wide.md` open, and with a note carrying ~30 properties (the strip caps at a
      third of the column and scrolls internally; confirm it actually does). Use
      `getBoundingClientRect`, not screenshots: overlap does not show up in
      `scrollWidth`.
- [ ] **C4 — Both engines.** The strip is new chrome in the `#main` flex column, which
      is precisely where `feat/chrome-ux` found two WebKitGTK-only overlap bugs. Check
      Windows (WebView2) *and* the Linux build, or at minimum Chromium against
      `dev-harness.html`, which ships fixtures for every strip state
      (`Properties.md`, `PropertiesRaw.md`, `PropertiesToml.md`, `PropertiesJson.md`,
      `PropertiesOnly.md`, `NotProperties.md`).
- [ ] **C5 — Keyboard and focus.** Tab through the rows; confirm focus returns to the
      control just edited after the re-render, that a collapsed strip is not
      tab-reachable, and that the collapse state survives a restart.
- [ ] **C6 — Export still excludes the block.** Export a note with properties to HTML
      and RTF; the properties must not appear in the output. Export no longer relies on
      comrak stripping them, so this is a genuinely new path.

## D. Release readiness (`feat/release-readiness`, 2026-08-17)

The update flow is the one feature here whose payoff — a stranded `v1.0.0` install
finding its way forward — cannot be demonstrated by any gate. `tests/update.test.ts`
pins *when* Toril checks and *whether* it interrupts you; nothing headless can pin
that a signed artifact downloads, verifies and replaces a running binary.

- [ ] **D1 — A real update installs.** The only end-to-end check that matters, and it
      needs two releases. Install `v1.0.0`'s NSIS build, publish a later tag, then launch
      the old copy: the notice should appear, Install should download, and Restart should
      come back on the new version **with the session intact**. Repeat for the MSI —
      per-machine install plus a per-user updater is the combination most likely to fail.
- [ ] **D2 — The restart guard actually refuses.** Make a tab dirty, take an update,
      click Restart now. Toril must refuse and say the update applies next launch — this
      is the one path in the feature that could destroy a buffer (§3), and it is guarded
      in `main.ts`, which has no harness.
- [ ] **D3 — Signature verification fails closed.** Tamper with a published artifact (or
      sign it with a different key) and confirm the install is **refused**, not attempted.
      A verification path that silently accepts is worse than no updater at all.
- [ ] **D4 — Toast layout, measured not eyeballed** (§12b). Drive `dev-harness.html?update`
      at 1400/1100/900/700px and assert with `getBoundingClientRect()` that the notice
      never overlaps `#statusbar`, stays inside the viewport, and that the long unbroken
      URL in the harness fixture does not widen it. **Not done on this branch** — the
      browser harness could not be driven in the authoring session, so this is genuinely
      unverified rather than assumed-fine.
- [ ] **D5 — Both engines.** The notice is `position: fixed` over a flex/grid shell;
      confirm in WebKitGTK as well as WebView2 that it is not clipped by a pane's
      `overflow: hidden` (it is parented to `body` specifically to avoid that).
- [ ] **D6 — Window state.** Move and resize the window, quit, relaunch: size, position
      and maximized state should return. Then relaunch on a machine with **fewer or
      smaller monitors** and confirm the window is not restored off-screen.
- [ ] **D8 — Zoom, and the two shortcuts that usually don't work.** `Ctrl+-` and `Ctrl+0`
      are unambiguous; `Ctrl+Plus` is not — check `Ctrl+Shift+=`, `Ctrl+=` and the numeric
      keypad's `+` all zoom in, in WebView2 *and* through the native accelerator. Confirm
      the chrome does **not** scale, and that the level survives a restart.
- [ ] **D9 — Open Recent.** Open several notes, confirm the File submenu lists them
      newest-first by file name and that reopening one moves it rather than duplicating
      it. Then delete a listed file on disk and pick it: it must report the failure and
      remove itself. The menu is rebuilt wholesale from Rust — watch for flicker or a
      lost menu on Linux.
- [ ] **D10 — Link opening, including the refusals.** Ctrl-click an `https://` link: it
      opens in the default browser, and Toril does not navigate. Then author a note
      containing `file:///C:/Windows/System32/cmd.exe` and `javascript:alert(1)` and
      Ctrl-click both — **nothing must launch**, and the status bar should say it was
      refused. `tests/links.test.ts` gates the rule; only a device proves the rule is
      the thing actually consulted.
- [ ] **D11 — Drag and drop.** Drop a `.md`, a folder, and a mixed selection including a
      `.png`. Notes open, the rest is skipped and counted. Native drag-drop is a
      per-platform path with no headless coverage at all.
- [ ] **D12 — First run really is first.** With no `session.json`, launch: the welcome
      note appears. Save it somewhere and diff — it must be **byte-identical**, which is
      the claim its own second paragraph makes. Then quit and relaunch: a returning user
      gets a blank page, not the tour again.
- [ ] **D7 — The check is quiet when it should be.** With no network, launch: nothing
      appears. Ask via Help → Check for Updates: it says it could not check. That
      asymmetry is the whole design and is easy to regress.

## B. Standing items (pre-existing, not from this branch)

- [ ] **B1 — HTML as a first-class format.** Open a real AI-authored `.html` artifact,
      edit it, save, reopen. Confirm the supported subset survives and unsupported markup
      is cleanly normalized rather than mangled. (CLAUDE.md §0, HTML follow-ups.)
- [~] **B2 — File-association open.** *(Partly verified 2026-08-17.)* Launching the
      binary with a path opens that file as the active tab (`argv[1]` →
      `take_launch_path`), and launching it **again while running** adds a tab to the
      existing window with the process count staying at 1 — the single-instance forward
      works on Windows. **Still human-only:** the Explorer half (double-click and "Open
      with"), which needs the installed build's registry entries rather than a
      dev binary, and `.html` as well as `.md`.
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
- [ ] **B9 — SmartScreen.** Unsigned installers warn on first run. Expected, not a bug.
      The Authenticode wiring now exists and is **inert until an Azure Trusted Signing
      account does** (`docs/RELEASE-SIGNING.md`) — so this stays open, and the README
      wording stays as it is, until a signed installer has been run on a clean box.
- [~] **B11 — Crash recovery.** *(Partly verified 2026-08-17, incidentally.)* Force-killing
      the process with three open buffers and relaunching restored all three, with
      "3 documents recovered" in the status bar — the journal survives a real `SIGKILL`
      equivalent, not just a graceful path. **Still to check:** that a *clean* exit
      clears `recovery.json` so the next launch reports nothing (the sentinel half).
      Note the sweep also showed why this matters: before `LoadEcho`, every restored
      *and* every freshly opened buffer was dirty, so the journal was carrying documents
      nobody had edited.

- [ ] **B10 — macOS.** Not a target (CLAUDE.md §1) and entirely unverified. Note in
      particular that macOS delivers file-opens via `RunEvent::Opened`, **not** argv, and
      that handler is not wired — B2 will fail there until it is.
