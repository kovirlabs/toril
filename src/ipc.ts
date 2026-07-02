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
  /** Whether the outline panel is shown. `null` ⇒ visible (default). */
  outline_visible: boolean | null;
  /** Whether debounced autosave is enabled. `null` ⇒ off (default). */
  autosave: boolean | null;
  /** Autosave/journal debounce in ms. `null` ⇒ 2000 (default). */
  autosave_debounce_ms: number | null;
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
