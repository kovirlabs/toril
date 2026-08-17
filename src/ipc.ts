// Thin, typed wrappers around Tauri's `invoke()` and dialogs. Per CLAUDE.md
// §5/§10 the frontend never touches the filesystem directly — every backend
// command and its argument shape is declared here, in one place.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import type { RecoveryEntry } from "./autosave";

export type { UnlistenFn } from "@tauri-apps/api/event";

export interface OpenedFile {
  path: string;
  content: string;
}

/** A node in the workspace tree (mirrors Rust `vaultscan::FileNode`). */
export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

/** Payload of the `workspace:change` event (mirrors Rust `ChangeEvent`). */
export interface WorkspaceChange {
  kind: "create" | "modify" | "remove" | "other";
  paths: string[];
}

const MARKDOWN_FILTER = { name: "Markdown", extensions: ["md", "markdown"] };

/** Read a UTF-8 markdown file. */
export function openFile(path: string): Promise<OpenedFile> {
  return invoke<OpenedFile>("open_file", { path });
}

/** Atomically write `content` to an existing path (§3.1). */
export function saveFile(path: string, content: string): Promise<void> {
  return invoke<void>("save_file", { path, content });
}

/**
 * Prompt for a destination (native dialog) and atomically write `content`.
 * Resolves to the chosen path, or `null` if the user cancelled.
 */
export function saveFileAs(content: string): Promise<string | null> {
  return invoke<string | null>("save_file_as", { content });
}

/**
 * Native "open" picker. Returns the selected path, or `null` if cancelled.
 * The picker only yields a path; the actual read still happens in Rust via
 * {@link openFile}, keeping all disk access in the backend.
 */
export async function pickFileToOpen(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [MARKDOWN_FILTER],
  });
  return typeof selected === "string" ? selected : null;
}

/** Recursively list the markdown tree under `path` (§5 `open_folder`). */
export function openFolder(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("open_folder", { path });
}

/** Start watching `path` for external changes; events arrive via {@link onWorkspaceChange}. */
export function watchFolder(path: string): Promise<void> {
  return invoke<void>("watch_folder", { path });
}

/** Native folder picker. Returns the chosen path, or `null` if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** Subscribe to external workspace changes. Resolves to an unlisten function. */
export function onWorkspaceChange(
  handler: (change: WorkspaceChange) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceChange>("workspace:change", (event) => handler(event.payload));
}

/** Subscribe to native menu clicks; the payload is the item id (`menu_*`, §8). */
export function onMenuAction(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>("menu", (event) => handler(event.payload));
}

/**
 * Consume the file Toril was launched with via double-click / "Open with" (§5).
 * Resolves to the path once, then `null` on subsequent calls (the backend clears
 * it so a session restore can't reopen a closed file). `null` on a normal launch.
 */
export function takeLaunchPath(): Promise<string | null> {
  return invoke<string | null>("take_launch_path");
}

/**
 * Subscribe to file-open requests forwarded from a *second* launch while Toril is
 * already running (single-instance, §5). The payload is the file path to open.
 */
export function onOpenFile(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("open-file", (event) => handler(event.payload));
}

/**
 * Guard the window's close button: when `hasUnsaved()` reports dirty documents,
 * intercept the close, ask for confirmation, and only then destroy the window
 * (§3 data safety). Returns once the handler is registered.
 */
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

/** Show the native "About Toril" dialog (Help menu). */
export async function showAbout(): Promise<void> {
  let version = "";
  try {
    version = await getVersion();
  } catch {
    // version unavailable (e.g. dev) — show without it
  }
  const heading = version ? `Toril v${version}` : "Toril";
  await message(`${heading}\nA MarkText-style WYSIWYG markdown editor.`, {
    title: "About Toril",
    kind: "info",
  });
}

// ---- Self-update (ROADMAP Movement I.5) ------------------------------------
//
// The updater and process plugins are the one pair of backend calls that do not
// go through `invoke()` by hand — they ship their own typed JS API. They are
// still declared here so `ipc.ts` stays the single inventory of what the
// frontend can ask the backend to do (§10), and so the rest of the app never
// imports the plugin directly and cannot reach past this seam.

/** An available update, reduced to what the policy and the banner need. */
export interface AvailableUpdate {
  version: string;
  notes?: string;
  /**
   * Download and install, then resolve. Deliberately a callback on the object
   * rather than a free function: an install can only ever apply to an update
   * that was actually found and shown, so there is no way to spell "install"
   * without having first checked.
   */
  install(): Promise<void>;
}

/**
 * Ask whether a newer build exists. Resolves to `null` when up to date.
 *
 * This performs a plain GET for a static manifest and sends nothing about the
 * user, the vault or the session — there is no telemetry in Toril and this is
 * not a back door for it. *Whether* to call this is decided by `update.ts`; this
 * function only does what it is told.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  if (!found) return null;
  return {
    version: found.version,
    notes: found.body ?? undefined,
    install: () => found.downloadAndInstall(),
  };
}

/**
 * Restart into the freshly installed build.
 *
 * Only ever called after the user accepted an install *and* Toril confirmed
 * there is nothing unsaved — see `main.ts`. Relaunching over a dirty buffer
 * would be a §3 data-loss path dressed as a convenience.
 */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Persisted session + preferences (mirrors Rust `settings::Settings`, §5). */
export interface Settings {
  version: number;
  last_folder: string | null;
  open_files: string[];
  active_file: string | null;
  /** Theme preference: "system" | "light" | "dark". `null` ⇒ frontend default. */
  theme: string | null;
  /** Whether the workspace sidebar is shown. `null` ⇒ visible (default). */
  sidebar_visible: boolean | null;
  /** Sidebar width in px. `null` ⇒ frontend default; clamped on restore. */
  sidebar_width: number | null;
  /** Whether the right-hand rail is shown. `null` ⇒ migrate from the legacy pair. */
  rail_visible: boolean | null;
  /** Rail width in px. `null` ⇒ frontend default; clamped on restore. */
  rail_width: number | null;
  /** Which panel the rail shows: "outline" | "history". `null` ⇒ outline. */
  rail_tab: string | null;
  /**
   * Legacy (pre-`feat/chrome-ux`) independent panel flags. Read once to migrate
   * into `rail_visible` / `rail_tab`, then never written again — see
   * `restorePaneState` for why the fallback must stay one-directional.
   */
  outline_visible: boolean | null;
  /** Legacy; see {@link Settings.outline_visible}. */
  history_visible: boolean | null;
  /** Whether the properties strip is expanded. `null` ⇒ expanded (default). */
  properties_expanded: boolean | null;
  /** Whether debounced autosave is enabled. `null` ⇒ off (default). */
  autosave: boolean | null;
  /** Autosave/journal debounce in ms. `null` ⇒ 2000 (default). */
  autosave_debounce_ms: number | null;
  /** Whether Toril checks for updates on launch. `null` ⇒ on (default). */
  update_check: boolean | null;
  /** Epoch ms of the last completed check. `null` ⇒ never checked. */
  update_last_checked: number | null;
  /** A version the user dismissed; startup will not raise it again. */
  update_skipped_version: string | null;
}

/** Load persisted settings; resolves to defaults if none exist or the file is corrupt. */
export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

/** Atomically persist settings (§3.1). Best-effort — callers ignore failures. */
export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

/**
 * Render canonical markdown to an HTML *body* fragment via comrak (Rust, §7).
 * The result is UNTRUSTED HTML — the caller MUST pass it through `sanitizeHtml`
 * (§3.3) before it reaches the DOM or a written file. No disk access here.
 */
export function markdownToHtml(content: string): Promise<string> {
  return invoke<string>("markdown_to_html", { content });
}

/**
 * Prompt for a destination and atomically write an already-built, already-
 * sanitized standalone HTML document (§3.1/§3.3). Returns the chosen path, or
 * `null` if the user cancelled.
 */
export function exportHtml(html: string, defaultName: string): Promise<string | null> {
  return invoke<string | null>("export_html", { html, defaultName });
}

/**
 * Render canonical markdown to RTF and atomically write it to a chosen path —
 * all in Rust (§7). Unlike HTML, RTF needs no frontend sanitization (it is inert
 * and generated by us). Returns the chosen path, or `null` if cancelled.
 */
export function exportRtf(content: string, defaultName: string): Promise<string | null> {
  return invoke<string | null>("export_rtf", { content, defaultName });
}

/**
 * Persist a pasted image beside `docPath` (in `assets/`) and resolve to the
 * Markdown-relative path to link with `![](…)` (§6). `bytes` is the raw image
 * data as a byte array. All disk access stays in Rust.
 */
export function saveClipboardImage(bytes: number[], docPath: string): Promise<string> {
  return invoke<string>("save_clipboard_image", { bytes, docPath });
}

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

/**
 * `"missing"` means the file is gone, which is the opposite instruction to a
 * read *failure*: an unreadable file blocks writes, a deleted one is recreated
 * by the next save. The backend separates them so the frontend never has to
 * guess from an error string.
 */
export type MergeOutcome = "unchanged" | "theirsOnly" | "merged" | "conflict" | "missing";

export interface MergeReport {
  outcome: MergeOutcome;
  /** The merged text. Present only for `"merged"`. */
  content: string | null;
  /** Bytes now on disk. Present for everything except `"unchanged"`/`"missing"`. */
  theirs: string | null;
}

/**
 * Three-way merge the file at `path` against `base` and `mine`. Reads only —
 * this never writes, so calling it is always safe (§5 contract).
 */
export function mergeExternal(path: string, base: string, mine: string): Promise<MergeReport> {
  return invoke<MergeReport>("merge_external", { path, base, mine });
}

/** Park `content` beside `path` as a `… (conflict <ts>)` file. Returns its path. */
export function writeConflictCopy(path: string, content: string): Promise<string> {
  return invoke<string>("write_conflict_copy", { path, content });
}

/** One stored version of a note (mirrors Rust `snapshots::SnapshotMeta`, §5). */
export interface SnapshotMeta {
  /** sha256 (hex) of the raw content — the version id. */
  hash: string;
  /** Save time, epoch milliseconds. */
  saved_at: number;
  /** Raw byte length. */
  size: number;
}

/** Versions of the note at `path`, newest first (empty if none). */
export function listHistory(path: string): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("list_history", { path });
}

/** The exact stored content of version `hash` for `path` (for the diff view). */
export function readSnapshot(path: string, hash: string): Promise<string> {
  return invoke<string>("read_snapshot", { path, hash });
}

/**
 * Restore version `hash` to the note at `path`. The current on-disk content is
 * snapshotted first (restore is undoable, §3), then the version is written
 * atomically. Callers reload the buffer afterwards.
 */
export function restoreSnapshot(path: string, hash: string): Promise<void> {
  return invoke<void>("restore_snapshot", { path, hash });
}

/** Providers that take an API key (mirrors Rust `keystore::Provider`). */
export type ProviderId = "anthropic" | "openai";

/** Whether one provider has a key stored (mirrors Rust `ProviderStatus`). */
export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
}

/**
 * Store an API key in the OS keychain (§5, ROADMAP Movement IV).
 *
 * Note the absence of a `getApiKey`: the backend exposes no command that
 * returns a key, so the frontend *cannot* read one back. That is deliberate —
 * §3.3 treats webview content as untrusted, so the key stays on the Rust side.
 * Do not add a getter here; there is nothing to call.
 */
export function setApiKey(provider: ProviderId, key: string): Promise<void> {
  return invoke<void>("set_api_key", { provider, key });
}

/** Remove a stored key. Succeeds even when none was stored. */
export function clearApiKey(provider: ProviderId): Promise<void> {
  return invoke<void>("clear_api_key", { provider });
}

/** Whether a key is stored for `provider`. */
export function hasApiKey(provider: ProviderId): Promise<boolean> {
  return invoke<boolean>("has_api_key", { provider });
}

/** Configured/not-set status for every provider, in one round trip. */
export function listApiKeys(): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("list_api_keys");
}
