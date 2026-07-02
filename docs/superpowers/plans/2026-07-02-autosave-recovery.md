# Autosave + Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debounced atomic autosave of dirty *saved* files plus an always-on crash-recovery journal that survives a kill/crash for every dirty buffer.

**Architecture:** One pure, dependency-injected `AutosaveScheduler` (TS) drives two effects off a single debounce — an unconditional recovery-journal write (contents snapshotted to the app config dir) and an opt-in disk autosave (reusing the existing atomic `saveFile` + canonical serializer path). Three thin Rust commands read/write/clear `recovery.json` via `fsatomic`. Wiring lives in `main.ts`; a native menu item toggles autosave.

**Tech Stack:** TypeScript (strict), Vitest (fake timers), Rust (Tauri 2, serde, `fsatomic`).

## Global Constraints

- **§3.1 Atomic saves** — all disk writes via `fsatomic` (autosave reuses `saveFile`; journal uses `fsatomic::atomic_write`). No new write path.
- **§3.2 One canonical serializer** — autosave serializes via `serializeEditor(format)`; the journal stores already-canonical content, never a second representation.
- **Never write a file the user didn't intend** — autosave writes only to existing paths; never invents a path, never triggers Save As, never writes Untitled buffers to disk.
- **§1 Vault stays clean** — `recovery.json` lives in the Tauri app config dir, never the user's folder. It is the sole place buffer *contents* persist; cleared on clean exit.
- **§0 Build reality** — the Rust app crate cannot link on this box (no webview). Rust steps verify with `cargo fmt --all`; compile/clippy and all GUI/IPC behavior are on-device-verified. The TS gate (`tests/autosave.test.ts`) is the automated gate and MUST stay green here.
- **TS: `strict` on, no `any`. Rust: edition 2024, `cargo fmt` clean. Conventional commits.**

---

### Task 1: Pure autosave scheduler + selection helpers (the gate)

**Files:**
- Create: `src/autosave.ts`
- Test: `tests/autosave.test.ts`

**Interfaces:**
- Produces:
  - `interface RecoveryEntry { id: string; path: string | null; name: string; content: string; format: "markdown" | "html" }`
  - `interface BufferLike { id: string; path: string | null; name: string; content: string; format: "markdown" | "html"; dirty: boolean }`
  - `interface AutosaveDeps { snapshotDirtyBuffers(): RecoveryEntry[]; writeJournal(entries: RecoveryEntry[]): Promise<void>; saveDirtySaved(): Promise<void> }`
  - `function selectDirtySaved<T extends BufferLike>(buffers: readonly T[]): T[]`
  - `function snapshotDirty(buffers: readonly BufferLike[]): RecoveryEntry[]`
  - `class AutosaveScheduler` with `constructor(deps, cfg?)`, `setConfig(cfg)`, `notifyChange()`, `flush(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/autosave.test.ts`:

```ts
// Unit tests for the autosave scheduler + selection helpers (CLAUDE.md §3,
// ROADMAP Movement I.1). The scheduler is pure — all side effects injected — so
// debounce + dirty-only selection are verifiable headlessly with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutosaveScheduler,
  type AutosaveDeps,
  type BufferLike,
  type RecoveryEntry,
  selectDirtySaved,
  snapshotDirty,
} from "../src/autosave";

function buf(over: Partial<BufferLike>): BufferLike {
  return { id: "b", path: "/a.md", name: "a.md", content: "A", format: "markdown", dirty: true, ...over };
}

function makeDeps(over: Partial<AutosaveDeps> = {}) {
  const calls = { journal: [] as RecoveryEntry[][], saves: 0 };
  const deps: AutosaveDeps = {
    snapshotDirtyBuffers: () => [],
    writeJournal: async (e) => {
      calls.journal.push(e);
    },
    saveDirtySaved: async () => {
      calls.saves += 1;
    },
    ...over,
  };
  return { deps, calls };
}

describe("selection helpers", () => {
  it("selectDirtySaved keeps dirty+path-backed, drops clean and Untitled", () => {
    const list = [
      buf({ id: "1", path: "/a.md", dirty: true }),
      buf({ id: "2", path: "/b.md", dirty: false }),
      buf({ id: "3", path: null, dirty: true }),
    ];
    expect(selectDirtySaved(list).map((b) => b.id)).toEqual(["1"]);
  });

  it("snapshotDirty includes Untitled but excludes clean, preserving format+path", () => {
    const list = [
      buf({ id: "1", path: "/a.md", dirty: true, format: "markdown" }),
      buf({ id: "2", path: null, name: "Untitled", content: "draft", dirty: true }),
      buf({ id: "3", path: "/c.html", dirty: false, format: "html" }),
    ];
    expect(snapshotDirty(list)).toEqual([
      { id: "1", path: "/a.md", name: "a.md", content: "A", format: "markdown" },
      { id: "2", path: null, name: "Untitled", content: "draft", format: "markdown" },
    ]);
  });
});

describe("AutosaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid changes into exactly one flush", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { debounceMs: 100 });
    s.notifyChange();
    s.notifyChange();
    s.notifyChange();
    expect(calls.journal).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.journal).toHaveLength(1);
  });

  it("writes the journal but never autosaves when disabled", async () => {
    const entry: RecoveryEntry = { id: "1", path: "/a.md", name: "a.md", content: "A", format: "markdown" };
    const { deps, calls } = makeDeps({ snapshotDirtyBuffers: () => [entry] });
    const s = new AutosaveScheduler(deps, { enabled: false, debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.journal).toEqual([[entry]]);
    expect(calls.saves).toBe(0);
  });

  it("autosaves when enabled", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { enabled: true, debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.saves).toBe(1);
  });

  it("clears the journal with an empty snapshot when nothing is dirty", async () => {
    const { deps, calls } = makeDeps({ snapshotDirtyBuffers: () => [] });
    const s = new AutosaveScheduler(deps, { debounceMs: 50 });
    s.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.journal).toEqual([[]]);
  });

  it("setConfig can turn autosave on at runtime", async () => {
    const { deps, calls } = makeDeps();
    const s = new AutosaveScheduler(deps, { enabled: false, debounceMs: 10 });
    s.setConfig({ enabled: true });
    await s.flush();
    expect(calls.saves).toBe(1);
  });

  it("round-trips recovery entries losslessly through JSON", () => {
    const entries: RecoveryEntry[] = [
      { id: "1", path: "/n/a.md", name: "a.md", content: "# A\n\nbody", format: "markdown" },
      { id: "2", path: null, name: "Untitled", content: "draft", format: "markdown" },
      { id: "3", path: "/n/page.html", name: "page.html", content: "<p>hi</p>", format: "html" },
    ];
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/autosave.test.ts`
Expected: FAIL — cannot resolve `../src/autosave`.

- [ ] **Step 3: Write minimal implementation**

Create `src/autosave.ts`:

```ts
// Autosave + crash-recovery journal (CLAUDE.md §3, ROADMAP Movement I.1).
//
// Two safety mechanisms on one debounce:
//  - the recovery journal (always on) snapshots every dirty buffer so a
//    crash/kill can't lose unsaved work;
//  - autosave (opt-in) persists dirty, path-backed tabs to their real files via
//    the existing atomic save path.
//
// This module is pure: every side effect (serialize, disk, journal I/O) is
// injected, so the debounce + selection logic is unit-testable with fake timers
// and no Tauri/DOM. The wiring lives in main.ts (§0: on-device verified).

/** A dirty buffer captured for crash recovery. Mirrors Rust `RecoveryEntry`. */
export interface RecoveryEntry {
  id: string;
  /** Absolute path, or null for an unsaved "Untitled" buffer. */
  path: string | null;
  name: string;
  /** Canonical content in `format` — one serializer per format (§3.2). */
  content: string;
  format: "markdown" | "html";
}

/** The minimal tab shape the selection helpers need (structural — TabState fits). */
export interface BufferLike {
  id: string;
  path: string | null;
  name: string;
  content: string;
  format: "markdown" | "html";
  dirty: boolean;
}

export interface AutosaveDeps {
  /** Snapshot every currently-dirty buffer (caller serializes the active tab first). */
  snapshotDirtyBuffers(): RecoveryEntry[];
  /** Persist the recovery journal (pass [] to clear it). */
  writeJournal(entries: RecoveryEntry[]): Promise<void>;
  /** Save every dirty, path-backed tab through the atomic save path. */
  saveDirtySaved(): Promise<void>;
}

export interface AutosaveConfig {
  enabled: boolean;
  debounceMs: number;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/** Dirty buffers that have a path — the only ones autosave may write (§3). */
export function selectDirtySaved<T extends BufferLike>(buffers: readonly T[]): T[] {
  return buffers.filter((b) => b.dirty && b.path !== null);
}

/** Snapshot every dirty buffer (Untitled included) for the recovery journal. */
export function snapshotDirty(buffers: readonly BufferLike[]): RecoveryEntry[] {
  return buffers
    .filter((b) => b.dirty)
    .map((b) => ({ id: b.id, path: b.path, name: b.name, content: b.content, format: b.format }));
}

export class AutosaveScheduler {
  private enabled: boolean;
  private debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: AutosaveDeps,
    cfg: Partial<AutosaveConfig> = {},
  ) {
    this.enabled = cfg.enabled ?? false;
    this.debounceMs = cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  setConfig(cfg: Partial<AutosaveConfig>): void {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled;
    if (cfg.debounceMs !== undefined && cfg.debounceMs > 0) this.debounceMs = cfg.debounceMs;
  }

  /** (Re)arm the debounce; a quiet `debounceMs` window triggers a flush. */
  notifyChange(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /**
   * Run the tick now: always rewrite the journal from the current dirty set,
   * and when enabled also autosave dirty path-backed tabs. Idempotent — the
   * journal is recomputed from scratch, so a saved tab drops out next tick.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.deps.snapshotDirtyBuffers();
    await this.deps.writeJournal(entries);
    if (this.enabled) await this.deps.saveDirtySaved();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/autosave.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/autosave.ts tests/autosave.test.ts
git commit -m "feat(autosave): pure scheduler + selection helpers with gate"
```

---

### Task 2: Rust recovery commands + settings fields + menu item

**Files:**
- Create: `src-tauri/src/commands/recovery.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod recovery;`)
- Modify: `src-tauri/src/lib.rs` (register 3 commands in `generate_handler!`)
- Modify: `src-tauri/src/settings.rs` (add `autosave`, `autosave_debounce_ms`)
- Modify: `src-tauri/src/menu.rs` (add `menu_toggle_autosave` to the View submenu)

**Interfaces:**
- Produces (Tauri commands): `save_recovery(entries: Vec<RecoveryEntry>) -> Result<(), String>`, `load_recovery() -> Vec<RecoveryEntry>`, `clear_recovery() -> Result<(), String>`; `RecoveryEntry { id, path: Option<String>, name, content, format }`.
- Produces (settings): `Settings.autosave: Option<bool>`, `Settings.autosave_debounce_ms: Option<u32>`.
- Produces (menu event id): `"menu_toggle_autosave"`.

- [ ] **Step 1: Create the recovery command module**

Create `src-tauri/src/commands/recovery.rs`:

```rust
//! Crash-recovery journal (CLAUDE.md §3, ROADMAP Movement I.1).
//!
//! Unsaved buffer contents are snapshotted to `recovery.json` in the Tauri app
//! config dir — never inside the user's vault (§1) — so a crash or kill can't
//! lose work. This is the one deliberate place buffer *contents* are persisted
//! (session.json stores paths only, §3.2); it is justified by the private
//! location and cleared on clean shutdown. Writes go through `fsatomic` (§3.1);
//! a missing or corrupt file loads as empty so it can never brick startup.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RECOVERY_FILE: &str = "recovery.json";

/// A dirty buffer captured for crash recovery (mirrors TS `RecoveryEntry`).
#[derive(Serialize, Deserialize)]
pub struct RecoveryEntry {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub content: String,
    pub format: String,
}

fn recovery_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(RECOVERY_FILE))
}

/// Persist the recovery journal atomically. An empty vec still writes an empty
/// list; callers use `clear_recovery` to remove the file entirely.
#[tauri::command]
pub fn save_recovery(app: AppHandle, entries: Vec<RecoveryEntry>) -> Result<(), String> {
    let path = recovery_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&entries).map_err(|e| e.to_string())?;
    fsatomic::atomic_write(&path, &json).map_err(|e| e.to_string())
}

/// Load the recovery journal. A missing or unparseable file yields an empty vec,
/// so a corrupt journal can never block startup.
#[tauri::command]
pub fn load_recovery(app: AppHandle) -> Vec<RecoveryEntry> {
    let Ok(path) = recovery_path(&app) else {
        return Vec::new();
    };
    match fsatomic::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Delete the recovery journal (clean-shutdown sentinel). A missing file is Ok —
/// nothing to recover means nothing to clear.
#[tauri::command]
pub fn clear_recovery(app: AppHandle) -> Result<(), String> {
    let path = recovery_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/commands/mod.rs`, add the line (keep alphabetical-ish with the others):

```rust
pub mod export;
pub mod files;
pub mod images;
pub mod recovery;
pub mod workspace;
```

- [ ] **Step 3: Register the commands in the handler**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ … ]`, add the three commands after the `settings::save_settings,` line:

```rust
            settings::load_settings,
            settings::save_settings,
            commands::recovery::save_recovery,
            commands::recovery::load_recovery,
            commands::recovery::clear_recovery,
            take_launch_path,
```

- [ ] **Step 4: Add the settings fields**

In `src-tauri/src/settings.rs`, inside `struct Settings`, after the `outline_visible` field:

```rust
    /// Whether the outline panel is shown. `None` ⇒ visible (default).
    pub outline_visible: Option<bool>,
    /// Whether debounced autosave of dirty, saved files is on. `None` ⇒ off.
    pub autosave: Option<bool>,
    /// Autosave/journal debounce in ms. `None` ⇒ 2000 (frontend default).
    pub autosave_debounce_ms: Option<u32>,
```

- [ ] **Step 5: Add the menu toggle**

In `src-tauri/src/menu.rs`, extend the `view` submenu:

```rust
    let view = SubmenuBuilder::new(app, "View")
        .text("menu_toggle_sidebar", "Toggle Sidebar (Ctrl+\\)")
        .text("menu_toggle_outline", "Toggle Outline (Ctrl+Shift+\\)")
        .separator()
        .text("menu_toggle_autosave", "Toggle Autosave")
        .build()?;
```

- [ ] **Step 6: Format + commit (compile/clippy on-device — §0)**

Run: `cd src-tauri && cargo fmt --all && cd ..`
Expected: no diff errors (formatting only; the app crate cannot link here, so compile/clippy happen on a webview-capable machine).

```bash
git add src-tauri/src/commands/recovery.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/settings.rs src-tauri/src/menu.rs
git commit -m "feat(autosave): recovery commands, settings fields, menu toggle (Rust)"
```

---

### Task 3: IPC wrappers + Settings mirror (TS)

**Files:**
- Modify: `src/ipc.ts`

**Interfaces:**
- Consumes: Task 1's `RecoveryEntry`; Task 2's commands `save_recovery` / `load_recovery` / `clear_recovery` and settings fields.
- Produces: `saveRecovery(entries: RecoveryEntry[]): Promise<void>`, `loadRecovery(): Promise<RecoveryEntry[]>`, `clearRecovery(): Promise<void>`; `Settings.autosave: boolean | null`, `Settings.autosave_debounce_ms: number | null`.

- [ ] **Step 1: Add the recovery import + wrappers**

In `src/ipc.ts`, add near the top imports (after the existing `import` lines):

```ts
import type { RecoveryEntry } from "./autosave";
```

Add these functions after `saveClipboardImage` (end of file is fine):

```ts
/** Persist the crash-recovery journal atomically to the app config dir (§3). */
export function saveRecovery(entries: RecoveryEntry[]): Promise<void> {
  return invoke<void>("save_recovery", { entries });
}

/** Load the crash-recovery journal; resolves to [] when none exists or on corruption. */
export function loadRecovery(): Promise<RecoveryEntry[]> {
  return invoke<RecoveryEntry[]>("load_recovery");
}

/** Delete the recovery journal — the clean-shutdown sentinel. */
export function clearRecovery(): Promise<void> {
  return invoke<void>("clear_recovery");
}
```

- [ ] **Step 2: Extend the Settings interface**

In `src/ipc.ts`, inside `interface Settings`, after `outline_visible`:

```ts
  /** Whether the outline panel is shown. `null` ⇒ visible (default). */
  outline_visible: boolean | null;
  /** Whether debounced autosave is enabled. `null` ⇒ off (default). */
  autosave: boolean | null;
  /** Autosave/journal debounce in ms. `null` ⇒ 2000 (default). */
  autosave_debounce_ms: number | null;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL — `src/main.ts`'s `scheduleSessionSave` builds a `Settings` literal missing the two new required fields. This is expected; Task 4 fixes it. (If you want a green checkpoint first, do Task 4 before committing; otherwise commit and proceed.)

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(autosave): ipc wrappers + Settings mirror for recovery"
```

---

### Task 4: Wire autosave + recovery into the app controller

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ipc.ts` (extend `installCloseGuard` signature)

**Interfaces:**
- Consumes: Task 1 (`AutosaveScheduler`, `selectDirtySaved`, `snapshotDirty`, `RecoveryEntry`); Task 3 (`saveRecovery`, `loadRecovery`, `clearRecovery`, extended `Settings`).
- Produces: fully wired autosave/recovery behavior (on-device verified).

- [ ] **Step 1: Extend `installCloseGuard` to run a cleanup on every close path**

In `src/ipc.ts`, replace the `installCloseGuard` function body with:

```ts
export async function installCloseGuard(
  hasUnsaved: () => number,
  onClose?: () => Promise<void>,
): Promise<UnlistenFn> {
  const win = getCurrentWindow();
  return win.onCloseRequested(async (event) => {
    event.preventDefault(); // we always destroy explicitly, so cleanup can run
    const dirty = hasUnsaved();
    if (dirty > 0) {
      const noun = dirty === 1 ? "document has" : "documents have";
      const discard = await ask(`${dirty} ${noun} unsaved changes. Close without saving?`, {
        title: "Toril",
        kind: "warning",
      });
      if (!discard) return; // keep the window open
    }
    try {
      await onClose?.(); // clear the recovery journal — best-effort
    } catch {
      // never block the close on a failed cleanup
    }
    await win.destroy();
  });
}
```

- [ ] **Step 2: Add imports + module state in `main.ts`**

In `src/main.ts`, add to the `./ipc` import block:

```ts
  clearRecovery,
  loadRecovery,
  saveRecovery,
```

Add a new import after the tabs import:

```ts
import { AutosaveScheduler, type RecoveryEntry, selectDirtySaved, snapshotDirty } from "./autosave";
```

Add module-level state near the other `let` declarations (after `let searchBar`):

```ts
let autosave: AutosaveScheduler | null = null;
let autosaveEnabled = false;
let autosaveDebounceMs = 2000;
```

- [ ] **Step 3: Factor the disk-save loop and build the scheduler deps**

In `src/main.ts`, add this helper right before `doSaveAll`:

```ts
/** Save the given path-backed tabs atomically (dirty filtering is the caller's). */
async function saveTabsToDisk(list: readonly TabState[]): Promise<number> {
  let saved = 0;
  for (const tab of list) {
    if (!tab.path) continue;
    try {
      recordSelfWrite(tab.path);
      await saveFile(tab.path, tab.content);
      tabs.setDirty(tab.id, false);
      saved++;
    } catch (e) {
      setStatus(`Save failed for ${tab.name}: ${String(e)}`);
    }
  }
  return saved;
}

/** Serialize the live editor into the active tab's buffer (before snapshotting). */
function captureActiveBuffer(): void {
  const active = tabs.active();
  if (active) active.content = serializeEditor(active.format);
}
```

Replace the body of `doSaveAll` with:

```ts
async function doSaveAll(): Promise<void> {
  captureActiveBuffer();
  const saved = await saveTabsToDisk(tabs.list().filter((t) => t.dirty));
  updateTitle();
  autosave?.notifyChange();
  if (saved > 0) setStatus(`Saved ${saved} file${saved === 1 ? "" : "s"}`);
}
```

- [ ] **Step 4: Construct the scheduler after the editor exists**

In `src/main.ts`, inside `DOMContentLoaded`, right after the `searchBar` setup line (`if (searchEl) searchBar = new SearchBar(searchEl, editor);`), add:

```ts
  autosave = new AutosaveScheduler(
    {
      snapshotDirtyBuffers: (): RecoveryEntry[] => {
        captureActiveBuffer();
        return snapshotDirty(tabs.list());
      },
      writeJournal: (entries) => (entries.length > 0 ? saveRecovery(entries) : clearRecovery()),
      saveDirtySaved: async () => {
        captureActiveBuffer();
        await saveTabsToDisk(selectDirtySaved(tabs.list()));
        updateTitle();
      },
    },
    { enabled: autosaveEnabled, debounceMs: autosaveDebounceMs },
  );
```

- [ ] **Step 5: Fire `notifyChange` on edits and saves**

In `onEditorChange`, add as the last line of the function:

```ts
  autosave?.notifyChange();
```

In `persistActive`, after `setStatus(\`Saved ${basename(path)}\`);` add:

```ts
  autosave?.notifyChange();
```

In `doSaveAs`, after `setStatus(\`Saved ${basename(path)}\`);` add:

```ts
  autosave?.notifyChange();
```

In `onCloseRequest`, after `updateTitle();` (the one before `scheduleSessionSave();`) add:

```ts
  autosave?.notifyChange();
```

- [ ] **Step 6: Add the autosave toggle + menu route**

In `src/main.ts`, add after `toggleOutline`:

```ts
function toggleAutosave(): void {
  autosaveEnabled = !autosaveEnabled;
  autosave?.setConfig({ enabled: autosaveEnabled });
  setStatus(`Autosave ${autosaveEnabled ? "on" : "off"}`);
  scheduleSessionSave();
  if (autosaveEnabled) autosave?.notifyChange();
}
```

In `handleMenuAction`, add a case alongside the other toggles:

```ts
    case "menu_toggle_autosave":
      toggleAutosave();
      break;
```

- [ ] **Step 7: Persist + restore the autosave settings**

In `scheduleSessionSave`, add the two fields to the `settings` object literal (after `outline_visible: outlineVisible,`):

```ts
      outline_visible: outlineVisible,
      autosave: autosaveEnabled,
      autosave_debounce_ms: autosaveDebounceMs,
```

In `restoreSession`, after the `outline_visible` block, add:

```ts
  if (settings.autosave !== null) autosaveEnabled = settings.autosave;
  if (settings.autosave_debounce_ms !== null) autosaveDebounceMs = settings.autosave_debounce_ms;
  autosave?.setConfig({ enabled: autosaveEnabled, debounceMs: autosaveDebounceMs });
```

- [ ] **Step 8: Add the launch-time recovery pass**

In `src/main.ts`, add this function after `restoreSession`:

```ts
/**
 * After a crash/kill the recovery journal survives (clean exits clear it). Reopen
 * each surviving buffer as a dirty tab so nothing is lost — the user decides to
 * save or discard. Recovered content is newer than disk (a saved buffer would
 * have dropped from the journal), so an already-open tab has its buffer swapped.
 */
async function recoverCrashedBuffers(): Promise<void> {
  let entries: RecoveryEntry[];
  try {
    entries = await loadRecovery();
  } catch {
    return;
  }
  if (entries.length === 0) return;

  for (const entry of entries) {
    const existing = entry.path ? tabs.byPath(entry.path) : undefined;
    if (existing) {
      existing.content = entry.content;
      if (existing.id === tabs.active()?.id) loadIntoEditor(entry.content, existing.format);
      tabs.setDirty(existing.id, true);
    } else {
      const tab = tabs.open({
        path: entry.path,
        name: entry.name,
        content: entry.content,
        format: entry.format,
      });
      tabs.setDirty(tab.id, true);
    }
  }
  updateTitle();
  setStatus(`${entries.length} document${entries.length === 1 ? "" : "s"} recovered`);
  autosave?.notifyChange(); // re-establish the journal from the live buffers
}
```

Call it in `DOMContentLoaded`, immediately after `await restoreSession();`:

```ts
  await restoreSession();
  await recoverCrashedBuffers();
```

- [ ] **Step 9: Wire the close-guard cleanup**

In `src/main.ts`, replace the `installCloseGuard` call with:

```ts
  // Guard against losing unsaved work on close, and clear the recovery journal
  // on every clean close so a leftover journal always means "we crashed" (§3).
  void installCloseGuard(
    () => tabs.list().filter((t) => t.dirty).length,
    () => clearRecovery(),
  );
```

- [ ] **Step 10: Typecheck + full suite green**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test`
Expected: PASS — all existing suites plus `tests/autosave.test.ts` green (no regression).

- [ ] **Step 11: Commit**

```bash
git add src/main.ts src/ipc.ts
git commit -m "feat(autosave): wire scheduler, journal, launch recovery, menu toggle"
```

---

### Task 5: Docs — contract, changelog, roadmap tick

**Files:**
- Modify: `CLAUDE.md` (§5 contract table + a one-line note)
- Modify: `CHANGELOG.md` (Unreleased entry)
- Modify: `ROADMAP.md` (tick branch 1; update the status pointer)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the §5 contract rows in `CLAUDE.md`**

In the command table in §5, add these rows after the `load_settings / save_settings` row:

```
| `save_recovery` | `entries` | `()` | **atomic** write of `recovery.json` in the app config dir — crash-recovery journal (§3) |
| `load_recovery` | — | `RecoveryEntry[]` | empty on missing/corrupt (never bricks startup) |
| `clear_recovery` | — | `()` | delete `recovery.json` — the clean-shutdown sentinel |
```

Then add this line to the events/notes prose under the table:

> **Recovery journal.** `recovery.json` (app config dir, beside `session.json`) is the
> one deliberate exception to session.json's "paths only, never contents" rule (§3.2):
> crash recovery requires buffer contents. It is written debounced, cleared on clean
> exit, and never lives in the user's vault (§1).

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md` (under a `## [Unreleased]` heading, creating it if absent):

```markdown
## [Unreleased]

### Added
- **Autosave + crash recovery** (ROADMAP Movement I.1). Opt-in debounced atomic
  autosave of dirty, already-saved files (View → Toggle Autosave; off by default).
  An always-on recovery journal snapshots every dirty buffer — Untitled drafts
  included — to the app config dir, so a crash or kill can't lose unsaved work;
  recovered buffers reopen as dirty tabs on next launch. Journal lives outside the
  vault and is cleared on clean exit.
```

- [ ] **Step 3: Tick the roadmap**

In `ROADMAP.md`, change branch 1's checkbox from `- [ ]` to `- [x]`:

```markdown
- [x] **1. `feat/autosave-recovery`** — debounced atomic autosave of dirty *saved* files +
```

Update the Status block (§1) pointer line from:

```
> **▶ Pick up at Movement I, branch 1 — `feat/autosave-recovery`.**
```

to:

```
> **▶ Pick up at Movement I, branch 2 — `feat/safe-delete-trash`.**
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md ROADMAP.md
git commit -m "docs(autosave): contract rows, changelog, tick roadmap branch 1"
```

---

## Self-Review

**Spec coverage:**
- Settings fields → Task 2 (Rust) + Task 3 (TS mirror). ✓
- Recovery commands (save/load/clear) → Task 2. ✓
- Pure `AutosaveScheduler` + journal-always/autosave-conditional tick → Task 1. ✓
- Dirty-only + saved-only selection, gate-visible → Task 1 (`selectDirtySaved`/`snapshotDirty` + tests). ✓
- Wiring: onEditorChange, saveDirtySaved factoring, self-write reuse, notifyChange on saves → Task 4. ✓
- Clean-shutdown sentinel (clearRecovery on close) → Task 4 Steps 1 + 9. ✓
- Launch recovery → dirty tabs + notice + re-journal → Task 4 Step 8. ✓
- Menu toggle → Task 2 Step 5 + Task 4 Step 6. ✓
- Gate `tests/autosave.test.ts` (debounce + dirty-only + round-trip) → Task 1. ✓
- §5 contract rows + §0/§1 notes, changelog, roadmap tick → Task 5. ✓

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `RecoveryEntry` shape identical across `autosave.ts`, `ipc.ts` (imported, not redefined), and Rust (`format: string` ⇄ `"markdown" | "html"`). `selectDirtySaved`/`snapshotDirty`/`captureActiveBuffer`/`saveTabsToDisk`/`AutosaveScheduler`/`notifyChange`/`setConfig`/`flush` names are used identically in Tasks 1 and 4. `installCloseGuard(hasUnsaved, onClose?)` new arg consumed in Task 4 Step 9. Settings fields `autosave`/`autosave_debounce_ms` consistent Rust ⇄ TS.

**Known accepted edge (from spec):** a recovered path-entry whose content already equals disk is reopened dirty — harmless (user just re-saves; no data loss).
