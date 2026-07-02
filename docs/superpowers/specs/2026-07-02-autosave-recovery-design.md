# Design — `feat/autosave-recovery`

> Movement I, branch 1 of `ROADMAP.md`. The first stone in the **Trust Foundation**:
> make Toril safe to live in. Debounced atomic autosave of dirty *saved* files, plus a
> crash-recovery journal that survives a kill/crash for **all** dirty buffers.

## Goal

Two independent safety mechanisms, driven off one debounce:

| | **Autosave** | **Recovery journal** |
|---|---|---|
| Writes to | the user's real file (existing path only) | `recovery.json` in the **app config dir** (never the vault) |
| Covers | dirty tabs that already have a path | **all** dirty buffers (Untitled + unsaved edits to saved files) |
| Default | **OFF**, opt-in | **always on** (never touches user files) |
| Cleared | n/a | on clean shutdown; per-buffer as its content reaches disk |

The journal write is **unconditional**; the disk autosave runs only when the setting is
enabled. So crash recovery protects every user regardless of the autosave preference.

## Non-negotiables (CLAUDE.md §3)

- **§3.1 Atomic saves.** Autosave reuses the existing `saveFile` command (temp + fsync +
  rename). The journal is written via `fsatomic::atomic_write`. No new write path is
  introduced.
- **§3.2 One canonical serializer.** Autosave serializes through the existing
  `serializeEditor(format)` bridge. The journal stores already-canonical content per tab
  — never a second, diverging representation.
- **Never write a file the user didn't intend.** Autosave only ever writes to a path the
  user already created (an existing, saved file). It never invents a path, never triggers
  Save As, never writes Untitled buffers to disk.
- **§1 Don't pollute the vault.** The journal lives in the Tauri app config dir alongside
  `session.json`, never inside the user's folder. It is the **one deliberate exception**
  to session.json's "paths only, never contents" rule — crash recovery *requires* the
  content; it is justified by the private location and the clean-exit clear.

## Components

### 1. Settings (`src-tauri/src/settings.rs` + TS mirror in `src/ipc.ts`)

Add to `Settings`:

- `autosave: Option<bool>` — `None` ⇒ **false** (off by default).
- `autosave_debounce_ms: Option<u32>` — `None` ⇒ **2000**.

Wire both through `scheduleSessionSave()`'s payload (`src/main.ts`) and read them back in
`restoreSession()`. Only the on/off is surfaced in UI this branch; the ms value is a
tunable in `session.json` (YAGNI on a slider).

### 2. Recovery commands (Rust — new `src-tauri/src/commands/recovery.rs`)

Three commands, registered in `lib.rs`, added to the §5 contract table:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `save_recovery` | `entries` | `()` | atomic write of `recovery.json` (`fsatomic`), best-effort |
| `load_recovery` | — | `RecoveryEntry[]` | empty on missing/corrupt (never bricks launch) |
| `clear_recovery` | — | `()` | delete the file (idempotent — missing file is Ok) |

```rust
#[derive(Serialize, Deserialize)]
pub struct RecoveryEntry {
    pub id: String,
    pub path: Option<String>,   // None ⇒ Untitled buffer
    pub name: String,
    pub content: String,        // canonical content in `format`
    pub format: String,         // "markdown" | "html"
}
```

`recovery.json` sits beside `session.json` in `app_config_dir()`. `load_recovery`
mirrors `load_settings`'s defensive posture: any read/parse failure yields an empty vec.
The commands are thin `fsatomic` I/O; their correctness rides on `fsatomic`'s existing
gate rather than an app-crate test (the app crate can't link on a webview-less box).

### 3. Autosave controller (new pure `src/autosave.ts`)

A dependency-injected `AutosaveScheduler` — no direct Tauri/DOM references, so it is
unit-testable with fake timers (mirrors the `outline.ts` pure-helpers / DOM-class split).

```ts
export interface RecoveryEntry {
  id: string;
  path: string | null;
  name: string;
  content: string;
  format: "markdown" | "html";
}

export interface AutosaveDeps {
  /** Serialize the active tab into its buffer, then snapshot every dirty buffer. */
  snapshotDirtyBuffers(): RecoveryEntry[];
  /** Persist recovery entries (or [] to clear). */
  writeJournal(entries: RecoveryEntry[]): Promise<void>;
  /** Save every dirty, path-backed tab via the existing atomic save path. */
  saveDirtySaved(): Promise<void>;
}

export class AutosaveScheduler {
  constructor(deps: AutosaveDeps, cfg?: { enabled?: boolean; debounceMs?: number });
  setConfig(cfg: { enabled?: boolean; debounceMs?: number }): void;
  notifyChange(): void;   // (re)arm the debounce
  flush(): Promise<void>; // run the tick now (used on demand / tests)
}
```

On each debounced tick:

1. `const entries = snapshotDirtyBuffers()`.
2. **Always** `writeJournal(entries)` — writes the current dirty set, or clears when empty.
3. **If `enabled`** `saveDirtySaved()` — those tabs become clean, so they drop out of the
   *next* snapshot naturally (the journal is recomputed from scratch each tick, so it is
   idempotent and self-healing).

Journal serialization is just `JSON` of `RecoveryEntry[]`, so the round-trip is a pure,
gate-visible property.

### 4. Wiring (`src/main.ts`, `src/ipc.ts`)

- Add `saveRecovery` / `loadRecovery` / `clearRecovery` wrappers to `ipc.ts`.
- Construct the scheduler after the editor exists; give it:
  - `snapshotDirtyBuffers`: captures the live active buffer (`serializeEditor`), then maps
    every `tab.dirty` tab to a `RecoveryEntry`.
  - `saveDirtySaved`: the logic already in `doSaveAll` (dirty + path-backed), factored so
    both share it; reuses `recordSelfWrite` so the watcher ignores autosave writes.
  - `writeJournal`: `saveRecovery` / with `[]` → `clearRecovery`.
- `onEditorChange` → `autosave.notifyChange()` after marking dirty.
- Call `notifyChange()` after saves/closes too, so the journal drops saved buffers promptly.
- **Clean shutdown (sentinel):** `installCloseGuard` calls `clearRecovery()` immediately
  before `win.destroy()`, on **both** paths (nothing dirty, or the user chose to discard).
  A crash never reaches this, so a surviving `recovery.json` ⇒ we crashed ⇒ recover.
- **Launch recovery:** after `restoreSession()` and before the welcome fallback, call
  `loadRecovery()`. If non-empty:
  - For each entry with a `path`: if a tab for that path is already open (from session
    restore), swap its content to the recovered (newer) version and mark it dirty; else
    open a new tab at that path with the recovered content, marked dirty.
  - For each Untitled entry (`path === null`): open a fresh Untitled tab, marked dirty.
  - Set status `"N document(s) recovered"`.
  - Call `notifyChange()` to re-establish the journal from the now-live buffers. We do
    **not** delete the file on recovery — if the app dies again before the next tick, the
    journal is still intact.

### 5. Settings toggle UI (`src-tauri/src/menu.rs`, `src/main.ts`)

A checkable **"Autosave" native menu item** emitting `menu_toggle_autosave`, handled in
`handleMenuAction`: flip the in-memory `autosaveEnabled`, call `scheduler.setConfig`, and
`scheduleSessionSave()` to persist. Consistent with the existing sidebar/outline menu
toggles. No settings *panel* exists yet; building one is out of scope for this branch.

## Gate — `tests/autosave.test.ts` (pure TS, headless)

1. **Debounce coalescing** — many rapid `notifyChange()` calls, advancing fake timers,
   produce exactly one tick.
2. **Autosave selection** — with `enabled: true`, `saveDirtySaved` is invoked and operates
   on dirty + path-backed tabs only (clean and Untitled excluded); with `enabled: false`,
   `saveDirtySaved` is never called but `writeJournal` still runs.
3. **Journal round-trip** — `RecoveryEntry[]` (including an Untitled entry and an `html`
   entry) serializes → JSON → deserializes losslessly (content + format + null path).

The Rust recovery commands are thin `fsatomic` I/O covered by `fsatomic`'s gate; the
menu/IPC glue and the on-launch recovery flow are verified on-device (no webview here, §0).

## Out of scope (this branch)

- A settings **panel** (only the menu toggle ships).
- A user-editable debounce interval (tunable in `session.json` only).
- Autosave of Untitled buffers to disk (that is the journal's job, by design).
- Per-tab undo history across recovery (roadmap branch 24).

## §5 contract additions

```
| save_recovery  | entries | ()               | atomic write of recovery.json (app config dir) |
| load_recovery  | —       | RecoveryEntry[]  | empty on missing/corrupt                       |
| clear_recovery | —       | ()               | delete recovery.json (clean-exit sentinel)     |
```
