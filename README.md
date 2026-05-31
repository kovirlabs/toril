# Toril

> **The bull, penned.** A MarkText-style WYSIWYG markdown editor — your markdown
> renders *in place* as you type, with no separate preview pane.

Toril is a small, fast desktop markdown editor built on **Tauri 2 + TypeScript +
Milkdown**. Files are plain `.md` in ordinary folders, so a workspace can be a
live Obsidian vault — no proprietary container, no lock-in.

**Primary platform: Windows.** macOS and Linux build from the same stack but are
not the current focus.

> ⚠️ **Status: early alpha.** The editor, atomic file saving, a folder
> sidebar, multi-document tabs, and an external-change watcher are in place
> (build milestones 0–2). The first prebuilt installers are available in
> **[v0.1.0-alpha](https://github.com/kovirlabs/toril/releases/tag/v0.1.0-alpha)** —
> expect rough edges, and keep backups of important notes.

---

## Download

Prebuilt installers for the latest alpha are on the
**[releases page](https://github.com/kovirlabs/toril/releases/latest)**. Grab the
one for your platform:

| Platform | Download |
|---|---|
| **Windows** (recommended) | [`Toril_0.1.0_x64-setup.exe`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_x64-setup.exe) |
| **Windows** (MSI) | [`Toril_0.1.0_x64_en-US.msi`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_x64_en-US.msi) |
| **macOS** (Apple Silicon) | [`Toril_0.1.0_aarch64.dmg`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_aarch64.dmg) |
| **macOS** (Intel) | [`Toril_0.1.0_x64.dmg`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_x64.dmg) |
| **Linux** (AppImage) | [`Toril_0.1.0_amd64.AppImage`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_amd64.AppImage) |
| **Linux** (Debian/Ubuntu) | [`Toril_0.1.0_amd64.deb`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril_0.1.0_amd64.deb) |
| **Linux** (Fedora/RHEL) | [`Toril-0.1.0-1.x86_64.rpm`](https://github.com/kovirlabs/toril/releases/download/v0.1.0-alpha/Toril-0.1.0-1.x86_64.rpm) |

Prefer to compile it yourself? See [Building from source](#running-from-source-development).

## Installing on Windows

Download **`Toril_0.1.0_x64-setup.exe`** above and double-click it. It performs a
per-user install — no administrator rights needed:

- Copies the app into **`%LOCALAPPDATA%\Toril`** (i.e.
  `C:\Users\<you>\AppData\Local\Toril`) — no admin prompt.
- Adds a **Start Menu** entry, and offers a **Desktop shortcut** checkbox during
  setup.
- Registers an entry in **Apps & features** for clean uninstallation.

> **SmartScreen note:** the build is unsigned, so on first run Windows
> SmartScreen may warn "Windows protected your PC." Click **More info →
> Run anyway**. This is expected for an unsigned personal build, not a problem
> with the app.

### Uninstalling

Use **Settings → Apps → Installed apps → Toril → Uninstall**, or run the
uninstaller in `%LOCALAPPDATA%\Toril`.

## Installing on macOS / Linux

- **macOS:** open the `.dmg` and drag **Toril** to Applications. The build is
  unsigned, so the first launch needs **right-click → Open** (or *System Settings
  → Privacy & Security → Open Anyway*) to get past Gatekeeper.
- **Linux:** the `.AppImage` is portable — `chmod +x Toril_0.1.0_amd64.AppImage`
  and run it. Or install the `.deb` (`sudo apt install ./Toril_0.1.0_amd64.deb`)
  / `.rpm` (`sudo dnf install ./Toril-0.1.0-1.x86_64.rpm`).

---

## Running from source (development)

To run the app live with hot-reload instead of installing:

```powershell
pnpm install
pnpm tauri dev
```

The first run compiles the Rust backend, so it takes a while; subsequent runs are
fast.

### Building on macOS / Linux

The same `pnpm tauri build` works, with platform build dependencies:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux:** WebKitGTK and friends, e.g. on Debian/Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```

---

## Development reference

| Task | Command |
|---|---|
| Run the app (dev) | `pnpm tauri dev` |
| Build app + installers | `pnpm tauri build` |
| Frontend type-check | `pnpm typecheck` |
| Frontend build only | `pnpm build` |
| Frontend tests (round-trip, tabs) | `pnpm test` |
| Backend logic tests | `cd src-tauri && cargo test -p fsatomic -p vaultscan` |

The architecture, data-safety rules, command contract, and build milestones live
in **[CLAUDE.md](./CLAUDE.md)**; the forward plan (branch-by-branch, with adoption
guidance) in **[ROADMAP.md](./ROADMAP.md)**; brand and theming in
**[BRAND.md](./BRAND.md)**.
