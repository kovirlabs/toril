// App controller (Phases 1–2). Coordinates the single Milkdown editor with the
// tab manager, the workspace sidebar, and the external-change watcher. All
// markdown conversion goes through serializer.ts; all disk access through
// ipc.ts (§3.2, §5).
import "@milkdown/theme-nord/style.css";
import "./styles.css";
import type { Editor } from "@milkdown/kit/core";
import { createEditor } from "./editor/milkdown";
import { docToMarkdown, markdownToDoc } from "./editor/serializer";
import { docToHtml, htmlToDoc } from "./editor/html-serializer";
import { buildStandaloneHtml } from "./export/html";
import { sanitizeHtml } from "./sanitize";
import {
  type Settings,
  type UnlistenFn,
  type WorkspaceChange,
  clearRecovery,
  exportHtml,
  exportRtf,
  installCloseGuard,
  listHistory,
  loadRecovery,
  loadSettings,
  markdownToHtml,
  type MergeReport,
  mergeExternal,
  onMenuAction,
  onOpenFile,
  onWorkspaceChange,
  openFile,
  openFolder,
  pickFileToOpen,
  pickFolder,
  readSnapshot,
  restoreSnapshot,
  saveClipboardImage,
  saveFile,
  saveFileAs,
  saveRecovery,
  saveSettings,
  showAbout,
  takeLaunchPath,
  watchFolder,
  writeConflictCopy,
} from "./ipc";
import { AutosaveScheduler, type RecoveryEntry, selectDirtySaved, snapshotDirty } from "./autosave";
import { decideAction } from "./sync";
import { ConflictBar } from "./ui/conflictbar";
import { History } from "./ui/history";
import { Outline } from "./ui/outline";
import { SearchBar } from "./ui/search";
import { Sidebar } from "./ui/sidebar";
import { StatusBar } from "./ui/statusbar";
import { type TabState, type DocFormat, TabManager } from "./ui/tabs";
import { ThemeController, isTheme } from "./ui/theme";
import { FormattingToolbar } from "./ui/toolbar";

const WELCOME = `# Welcome to Toril

Open a folder to browse your notes, or start typing here.
`;

let editor: Editor;
let tabs: TabManager;
let sidebar: Sidebar;
let formatToolbar: FormattingToolbar | null = null;
let statusBar: StatusBar | null = null;
let outline: Outline | null = null;
let history: History | null = null;
let searchBar: SearchBar | null = null;
let conflictBar: ConflictBar | null = null;
let autosave: AutosaveScheduler | null = null;
let autosaveEnabled = false;
let autosaveDebounceMs = 2000;
let theme: ThemeController | null = null;

let workspaceRoot: string | null = null;
let sidebarVisible = true;
let outlineVisible = true;
let historyVisible = false;
let unwatch: UnlistenFn | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;

let loading = false; // suppress the dirty flag during programmatic loads
/** Pending per-path reconciles — sync daemons emit bursts (write, chmod, touch). */
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Bumped whenever a path is removed on disk. A reconcile captures the count when
 * it starts and discards its result if it changed, so a merge still awaiting IPC
 * when the deletion lands cannot strand the tab in an `error` divergence that
 * nothing will ever clear (no further watcher events arrive for a dead path).
 */
const removalEpoch = new Map<string, number>();

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function setStatus(msg: string): void {
  const el = document.querySelector("#status");
  if (el) el.textContent = msg;
}

function updateTitle(): void {
  const tab = tabs.active();
  const shown = tab ? `${tab.name}${tab.dirty ? " *" : ""}` : "Toril";
  document.title = tab ? `${shown} — Toril` : "Toril";
  const el = document.querySelector<HTMLElement>("#doc-title");
  if (el) {
    el.textContent = shown;
    el.dataset.dirty = String(tab?.dirty ?? false);
  }
  sidebar.setActivePath(tab?.path ?? null);
}

// Format-aware bridges to the two canonical serializers (§3.2). The active tab's
// `format` decides which one runs; everything else (tabs, save, session) is shared.
function loadIntoEditor(content: string, format: DocFormat): void {
  loading = true;
  if (format === "html") htmlToDoc(editor, content);
  else markdownToDoc(editor, content);
  loading = false;
}

/** Serialize the live editor into the given format's canonical string. */
function serializeEditor(format: DocFormat): string {
  return format === "html" ? docToHtml(editor) : docToMarkdown(editor);
}

/** Map a file path's extension to its canonical editor format. */
function formatForPath(path: string): DocFormat {
  return /\.html?$/i.test(path) ? "html" : "markdown";
}

function onEditorChange(): void {
  if (loading) return;
  statusBar?.refresh();
  outline?.refresh();
  const tab = tabs.active();
  if (tab && !tab.dirty) {
    tabs.setDirty(tab.id, true);
    updateTitle();
  }
  autosave?.notifyChange();
}

// ---- Tab lifecycle: keep editor and per-tab buffers in sync ----------------

function onDeactivate(tab: TabState): void {
  tab.content = serializeEditor(tab.format); // persist outgoing tab's edits
}

function onActivate(tab: TabState): void {
  loadIntoEditor(tab.content, tab.format);
  updateTitle();
  formatToolbar?.refresh();
  statusBar?.refresh();
  outline?.refresh();
  refreshHistory();
  scheduleSessionSave();
  renderConflictBar(); // the banner is per-tab, so it re-renders on every switch
}

function onCloseRequest(tab: TabState): void {
  if (tab.dirty && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
  tabs.close(tab.id);
  if (!tabs.active()) {
    openDocument(null, "Untitled", ""); // never leave zero tabs
  }
  updateTitle();
  autosave?.notifyChange();
  scheduleSessionSave();
}

// ---- Open / save -----------------------------------------------------------

function openDocument(
  path: string | null,
  name: string,
  content: string,
  format: DocFormat = "markdown",
): void {
  tabs.open({ path, name, content, format });
  updateTitle();
}

async function openPath(path: string): Promise<void> {
  const existing = tabs.byPath(path);
  if (existing) {
    tabs.setActive(existing.id);
    updateTitle();
    return;
  }
  const file = await openFile(path);
  openDocument(file.path, basename(file.path), file.content, formatForPath(file.path));
  setStatus(`Opened ${basename(file.path)}`);
}

async function doOpenFile(): Promise<void> {
  try {
    const path = await pickFileToOpen();
    if (path) await openPath(path);
  } catch (e) {
    setStatus(`Open failed: ${String(e)}`);
  }
}

async function doOpenFolder(): Promise<void> {
  try {
    const path = await pickFolder();
    if (!path) return;
    await loadWorkspace(path);
  } catch (e) {
    setStatus(`Open folder failed: ${String(e)}`);
  }
}

async function loadWorkspace(path: string): Promise<void> {
  const tree = await openFolder(path);
  workspaceRoot = path;
  sidebar.setRoot(basename(path), tree);
  sidebar.setActivePath(tabs.active()?.path ?? null);
  setStatus(`Opened folder ${basename(path)}`);

  if (unwatch) unwatch();
  unwatch = await onWorkspaceChange(handleWorkspaceChange);
  await watchFolder(path);
  scheduleSessionSave();
}

async function persistActive(path: string): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  const content = serializeEditor(tab.format);
  await saveFile(path, content);
  tab.content = content;
  // What we just wrote is what is on disk — the merge base for the next
  // external change, and what makes our own watcher event report `unchanged`.
  tabs.setBase(tab.id, content);
  tabs.setDirty(tab.id, false);
  updateTitle();
  setStatus(`Saved ${basename(path)}`);
  autosave?.notifyChange();
  refreshHistory(); // a save just created a new version
}

async function doSave(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  if (!tab.path) {
    await doSaveAs();
    return;
  }
  try {
    await persistActive(tab.path);
  } catch (e) {
    setStatus(`Save failed: ${String(e)}`);
  }
}

/** Save the given path-backed tabs atomically (dirty filtering is the caller's). */
async function saveTabsToDisk(list: readonly TabState[]): Promise<number> {
  let saved = 0;
  for (const tab of list) {
    if (!tab.path) continue;
    try {
      await saveFile(tab.path, tab.content);
      tabs.setBase(tab.id, tab.content);
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

/** Save every dirty, file-backed tab (Untitled tabs need Save As and are skipped). */
async function doSaveAll(): Promise<void> {
  captureActiveBuffer();
  const saved = await saveTabsToDisk(tabs.list().filter((t) => t.dirty));
  updateTitle();
  autosave?.notifyChange();
  if (saved > 0) setStatus(`Saved ${saved} file${saved === 1 ? "" : "s"}`);
}

async function doSaveAs(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  try {
    const content = serializeEditor(tab.format);
    const path = await saveFileAs(content);
    if (!path) return; // cancelled
    tab.content = content;
    tabs.setBase(tab.id, content);
    tabs.setPath(tab.id, path, basename(path));
    tabs.setDirty(tab.id, false);
    updateTitle();
    setStatus(`Saved ${basename(path)}`);
    autosave?.notifyChange();
    if (workspaceRoot && path.startsWith(workspaceRoot)) scheduleSidebarRefresh();
    scheduleSessionSave(); // the tab now has a path — make it restorable
  } catch (e) {
    setStatus(`Save failed: ${String(e)}`);
  }
}

function doNew(): void {
  openDocument(null, "Untitled", "");
  setStatus("New document");
}

// ---- Sidebar visibility ----------------------------------------------------

/** Apply the sidebar visibility to the DOM (a class on #workspace drives CSS). */
function applySidebar(): void {
  document.querySelector("#workspace")?.classList.toggle("sidebar-hidden", !sidebarVisible);
  const btn = document.querySelector<HTMLElement>("#btn-toggle-sidebar");
  if (btn) btn.dataset.active = String(sidebarVisible);
}

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  applySidebar();
  scheduleSessionSave();
}

// ---- Outline visibility -----------------------------------------------------

/** Apply the outline-panel visibility to the DOM (a class on #workspace drives CSS). */
function applyOutline(): void {
  document.querySelector("#workspace")?.classList.toggle("outline-hidden", !outlineVisible);
  const btn = document.querySelector<HTMLElement>("#btn-toggle-outline");
  if (btn) btn.dataset.active = String(outlineVisible);
}

function toggleOutline(): void {
  outlineVisible = !outlineVisible;
  applyOutline();
  scheduleSessionSave();
}

// ---- Version-history panel (ROADMAP Movement I.3) ---------------------------

/** Apply the history-panel visibility to the DOM (a class on #workspace drives CSS). */
function applyHistory(): void {
  document.querySelector("#workspace")?.classList.toggle("history-hidden", !historyVisible);
  const btn = document.querySelector<HTMLElement>("#btn-toggle-history");
  if (btn) btn.dataset.active = String(historyVisible);
}

function toggleHistory(): void {
  historyVisible = !historyVisible;
  applyHistory();
  refreshHistory(); // populate on show; a no-op read when hidden
  scheduleSessionSave();
}

/** Point the panel at the active note's current buffer. Skipped while hidden so
 *  it never reads the store needlessly. */
function refreshHistory(): void {
  if (!history || !historyVisible) return;
  const tab = tabs.active();
  const path = tab?.path ?? null;
  const content = tab ? serializeEditor(tab.format) : "";
  void history.setActive(path, content);
}

/**
 * Full restore flow behind the panel's Restore button. If the active buffer has
 * unsaved edits, save it first (which snapshots that state via the §4 hook), then
 * restore the chosen version and reload the buffer from disk. The watcher event
 * our own write provokes is self-cancelling: `base` is set to the restored bytes
 * below, so reconciling against disk reports `unchanged`.
 */
async function restoreVersion(path: string, hash: string): Promise<void> {
  const tab = tabs.active();
  if (tab && tab.path === path && tab.dirty) {
    try {
      await persistActive(path);
    } catch (e) {
      setStatus(`Save before restore failed: ${String(e)}`);
      return;
    }
  }
  await restoreSnapshot(path, hash);
  const reloaded = await openFile(path);
  if (tab && tab.path === path) {
    loadIntoEditor(reloaded.content, tab.format);
    tab.content = reloaded.content;
    tabs.setBase(tab.id, reloaded.content);
    tabs.setDirty(tab.id, false);
    updateTitle();
  }
  setStatus(`Restored a previous version of ${basename(path)}`);
}

function toggleAutosave(): void {
  autosaveEnabled = !autosaveEnabled;
  autosave?.setConfig({ enabled: autosaveEnabled });
  setStatus(`Autosave ${autosaveEnabled ? "on" : "off"}`);
  scheduleSessionSave();
  if (autosaveEnabled) autosave?.notifyChange();
}

// ---- Export ----------------------------------------------------------------

/**
 * Export the active document to a standalone HTML file. The pipeline keeps the
 * one sanitization path (§3.3): comrak renders in Rust → the untrusted HTML is
 * sanitized here via `sanitizeHtml` → wrapped in a self-contained document →
 * written atomically in Rust. Disk access never leaves the backend (§10).
 */
async function doExportHtml(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  try {
    const markdown = docToMarkdown(editor);
    const dirty = await markdownToHtml(markdown); // untrusted comrak output
    const safe = sanitizeHtml(dirty); // §3.3 chokepoint — before it hits a file
    const title = tab.name.replace(/\.(md|markdown)$/i, "");
    const html = buildStandaloneHtml(safe, { title, dark: theme?.resolved() === "dark" });
    const suggested = `${title || "untitled"}.html`;
    const path = await exportHtml(html, suggested);
    if (path) setStatus(`Exported ${basename(path)}`);
  } catch (e) {
    setStatus(`Export failed: ${String(e)}`);
  }
}

/**
 * Export the active document to RTF. The whole pipeline is in Rust (`mdrtf`
 * renders, the command writes) — RTF is inert, so there is no sanitization step
 * like HTML export needs (§7).
 */
async function doExportRtf(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  try {
    const markdown = docToMarkdown(editor);
    const title = tab.name.replace(/\.(md|markdown)$/i, "");
    const path = await exportRtf(markdown, `${title || "untitled"}.rtf`);
    if (path) setStatus(`Exported ${basename(path)}`);
  } catch (e) {
    setStatus(`Export failed: ${String(e)}`);
  }
}

// ---- Clipboard image paste -------------------------------------------------

/**
 * Persist a pasted image beside the active document and return the relative
 * `src` for the editor to link (§6). Requires the document to be saved — the
 * relative `assets/…` path only makes sense once it has a location on disk.
 */
async function onImagePaste(bytes: Uint8Array): Promise<string | null> {
  const tab = tabs.active();
  if (!tab?.path) {
    setStatus("Save the document before pasting images.");
    return null;
  }
  try {
    const src = await saveClipboardImage(Array.from(bytes), tab.path);
    setStatus(`Inserted image (${src})`);
    return src;
  } catch (e) {
    setStatus(`Image paste failed: ${String(e)}`);
    return null;
  }
}

// ---- External changes ------------------------------------------------------

function scheduleSidebarRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!workspaceRoot) return;
    openFolder(workspaceRoot)
      .then((tree) => {
        sidebar.setRoot(basename(workspaceRoot!), tree);
        sidebar.setActivePath(tabs.active()?.path ?? null);
      })
      .catch(() => {});
  }, 300);
}

/**
 * Reconcile one tab against disk and act on the result.
 *
 * Called from the watcher and (Task 11) from the pre-save check. The watcher is
 * an optimization; the save path is the guarantee — watchers drop and coalesce
 * events on network shares and some sync clients.
 *
 * This replaces the old 2-second `isSelfWrite` window. After Toril saves, disk
 * equals `base`, so a self-triggered event reports `unchanged` and stops here —
 * a byte comparison where a timer used to guess.
 */
async function reconcile(tab: TabState): Promise<void> {
  if (!tab.path) return;
  const path = tab.path;
  const mine = tab.id === tabs.active()?.id ? serializeEditor(tab.format) : tab.content;

  // The file may be deleted while we await IPC below; the `remove` branch of the
  // watcher owns that tab from then on, and applying a stale merge over the top
  // of its decision would undo it.
  const epoch = removalEpoch.get(path) ?? 0;
  const removedMeanwhile = (): boolean => (removalEpoch.get(path) ?? 0) !== epoch;

  let report: MergeReport;
  try {
    report = await mergeExternal(path, tab.base, mine);
  } catch {
    // One retry: a sync client may hold the file open for a moment mid-write.
    await new Promise((r) => setTimeout(r, 200));
    try {
      report = await mergeExternal(path, tab.base, mine);
    } catch (e) {
      if (removedMeanwhile()) return; // deleted, not unreadable — already handled
      // Fail closed — block writes rather than risk overwriting something we
      // could not read (§3).
      tabs.setDiverged(tab.id, {
        theirs: "",
        reason: "error",
        // Labels the state as non-actionable, since the two buttons cannot be
        // suppressed from here (see the report: `ConflictBar.show` always
        // renders both, and conflictbar.ts is outside this task).
        message: `could not be compared with disk, so no action is available yet (${String(e)})`,
      });
      renderConflictBar();
      return;
    }
  }
  if (removedMeanwhile()) return;

  const action = decideAction(report, tab.format);
  switch (action.kind) {
    case "none":
      // If an external writer reverted their change, the conflict resolves
      // itself and the banner goes away.
      if (tab.diverged) {
        tabs.setDiverged(tab.id, null);
        renderConflictBar();
      }
      return;

    case "reload":
      tab.content = action.theirs;
      tabs.setBase(tab.id, action.theirs);
      tabs.setDiverged(tab.id, null);
      tabs.setDirty(tab.id, false);
      if (tab.id === tabs.active()?.id) {
        loadIntoEditor(action.theirs, tab.format);
        outline?.refresh();
        statusBar?.refresh();
      }
      updateTitle();
      renderConflictBar();
      setStatus(`Reloaded ${tab.name}`);
      return;

    case "applyMerge":
      tab.content = action.merged;
      // base becomes THEIRS, not the merged text: theirs is what is on disk now.
      tabs.setBase(tab.id, action.theirs);
      tabs.setDiverged(tab.id, null);
      tabs.setDirty(tab.id, !action.clean);
      if (tab.id === tabs.active()?.id) {
        loadIntoEditor(action.merged, tab.format);
        outline?.refresh();
        statusBar?.refresh();
      }
      updateTitle();
      renderConflictBar();
      setStatus(
        action.clean
          ? `${tab.name}: external changes matched yours`
          : `Merged external changes into ${tab.name} — review and save`,
      );
      return;

    case "conflict":
      tabs.setDiverged(tab.id, {
        theirs: action.theirs,
        reason: "conflict",
        message: action.message,
      });
      renderConflictBar();
      return;
  }
}

/** Show the banner for the active tab if it is diverged; hide it otherwise. */
function renderConflictBar(): void {
  const tab = tabs.active();
  if (!tab || !tab.diverged) {
    conflictBar?.hide();
    return;
  }
  conflictBar?.show({
    name: tab.name,
    message: tab.diverged.message,
    onKeepMine: () => void resolveConflict(tab, true),
    onUseTheirs: () => void resolveConflict(tab, false),
  });
}

/**
 * Resolve a conflict by parking the losing side, in both directions.
 *
 * The park happens FIRST. If it fails the whole resolution aborts — no reload,
 * `diverged` stays set, the banner stays up. If we cannot preserve the losing
 * side, we do not get to destroy it (§3). This is the most important error path
 * in the feature.
 */
async function resolveConflict(tab: TabState, keepMine: boolean): Promise<void> {
  if (!tab.path || !tab.diverged) return;
  // An `error` divergence has no `theirs` — we never managed to read the file.
  // Acting on it would park an empty conflict copy and, for "Use theirs", blank
  // the buffer. Refuse: the state clears itself as soon as the file reads again.
  if (tab.diverged.reason === "error") {
    setStatus(`${tab.name} still cannot be read from disk — nothing changed`);
    return;
  }
  const theirs = tab.diverged.theirs;
  const mine = tab.id === tabs.active()?.id ? serializeEditor(tab.format) : tab.content;

  let parked: string;
  try {
    parked = await writeConflictCopy(tab.path, keepMine ? theirs : mine);
  } catch (e) {
    setStatus(`Could not save the conflict copy — nothing changed (${String(e)})`);
    return; // diverged stays set; the banner stays up
  }

  if (keepMine) {
    tabs.setBase(tab.id, theirs); // disk holds theirs; the buffer is still ours
    tabs.setDiverged(tab.id, null);
    tabs.setDirty(tab.id, true);
  } else {
    tab.content = theirs;
    tabs.setBase(tab.id, theirs);
    tabs.setDiverged(tab.id, null);
    tabs.setDirty(tab.id, false);
    if (tab.id === tabs.active()?.id) {
      loadIntoEditor(theirs, tab.format);
      outline?.refresh();
      statusBar?.refresh();
    }
  }
  updateTitle();
  renderConflictBar();
  if (workspaceRoot) scheduleSidebarRefresh(); // the conflict copy is a new file
  setStatus(`Saved the other version as ${basename(parked)}`);
}

function handleWorkspaceChange(change: WorkspaceChange): void {
  // The tree may have changed (create/remove/rename) — refresh the sidebar.
  scheduleSidebarRefresh();

  if (change.kind === "remove") {
    // Cancel any reconcile still queued for a path that no longer exists: it
    // would fail both read attempts and leave an `error` divergence that no
    // later event can clear, blocking the very save promised below. The epoch
    // bump does the same for a reconcile already in flight.
    for (const path of change.paths) {
      const pending = reconcileTimers.get(path);
      if (pending) {
        clearTimeout(pending);
        reconcileTimers.delete(path);
      }
      removalEpoch.set(path, (removalEpoch.get(path) ?? 0) + 1);
    }

    // A sync daemon deleting a file the user has open must not vaporize their
    // buffer. Keep it, mark it dirty; the next save recreates the file.
    for (const tab of tabs.list()) {
      if (tab.path && change.paths.includes(tab.path)) {
        // A reconcile that errored *before* this event arrived (the deletion is
        // what it tripped over) left a divergence with no user-actionable exit.
        // Deletion is a state this branch has an answer for, so clear it. A
        // `conflict` divergence is left alone: its `theirs` is real content the
        // user can still park, and resolving it releases the tab.
        if (tab.diverged?.reason === "error") tabs.setDiverged(tab.id, null);
        tabs.setDirty(tab.id, true);
        setStatus(`${tab.name} was removed on disk — save to recreate it`);
      }
    }
    updateTitle();
    renderConflictBar();
    return;
  }
  if (change.kind !== "modify" && change.kind !== "create") return;

  // Every tab whose path changed, not only the active one. Debounced per path:
  // sync daemons emit bursts (write, chmod, touch), and the tab is re-looked-up
  // at fire time so a closed or replaced tab is never reconciled.
  for (const tab of tabs.list()) {
    if (!tab.path || !change.paths.includes(tab.path)) continue;
    const path = tab.path;
    const existing = reconcileTimers.get(path);
    if (existing) clearTimeout(existing);
    reconcileTimers.set(
      path,
      setTimeout(() => {
        reconcileTimers.delete(path);
        const current = tabs.byPath(path);
        if (current) void reconcile(current);
      }, 250),
    );
  }
}

// ---- Session memory: remember last folder + open files ---------------------

/**
 * Snapshot the session (workspace folder + file-backed tabs + the active one)
 * to disk. Debounced and best-effort — failures are swallowed so persistence
 * never interferes with editing. Only paths are stored, never buffer contents,
 * so the file on disk remains the single source of truth (§3.2).
 */
function scheduleSessionSave(): void {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const settings: Settings = {
      version: 1,
      last_folder: workspaceRoot,
      open_files: tabs
        .list()
        .map((t) => t.path)
        .filter((p): p is string => p !== null),
      active_file: tabs.active()?.path ?? null,
      theme: theme?.current() ?? null,
      sidebar_visible: sidebarVisible,
      outline_visible: outlineVisible,
      history_visible: historyVisible,
      autosave: autosaveEnabled,
      autosave_debounce_ms: autosaveDebounceMs,
    };
    void saveSettings(settings).catch(() => {}); // best-effort
  }, 400);
}

/**
 * Reopen the last session: the workspace folder, then each previously open
 * file, focusing the one that was active. Fully defensive — a folder or file
 * that has since moved or been deleted is skipped silently, and a failed load
 * simply restores nothing. Opened files are read fresh from disk (§3.2).
 */
async function restoreSession(): Promise<void> {
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch {
    return;
  }

  // Theme first, so the restored UI paints in the right palette.
  if (theme && isTheme(settings.theme)) {
    theme.applyInitial(settings.theme);
    syncThemeSelect();
  }
  if (settings.sidebar_visible !== null) {
    sidebarVisible = settings.sidebar_visible;
    applySidebar();
  }
  if (settings.outline_visible !== null) {
    outlineVisible = settings.outline_visible;
    applyOutline();
  }
  if (settings.history_visible !== null) {
    historyVisible = settings.history_visible;
    applyHistory();
  }
  if (settings.autosave !== null) autosaveEnabled = settings.autosave;
  if (settings.autosave_debounce_ms !== null) autosaveDebounceMs = settings.autosave_debounce_ms;
  autosave?.setConfig({ enabled: autosaveEnabled, debounceMs: autosaveDebounceMs });

  if (settings.last_folder) {
    try {
      await loadWorkspace(settings.last_folder);
    } catch {
      // folder gone/moved — skip, leave workspaceRoot unset
    }
  }

  for (const path of settings.open_files) {
    try {
      await openPath(path); // reads from disk; throws if the file is missing
    } catch {
      // file gone — skip it
    }
  }

  if (settings.active_file) {
    const tab = tabs.byPath(settings.active_file);
    if (tab) tabs.setActive(tab.id);
  }
}

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
      // `tabs.open` seeds `base` from the content it is given, but a recovered
      // buffer is *newer* than disk — leaving it as the base would make the next
      // reconcile read the older file as an external change and reload over the
      // recovery. base must be what is on disk (§3).
      if (entry.path) {
        try {
          const onDisk = await openFile(entry.path);
          tabs.setBase(tab.id, onDisk.content);
        } catch {
          // Unreadable right now (gone, or a sync client mid-restore). An empty
          // base is the honest ancestor: we know nothing about disk. Whatever
          // appears later is then a real three-way merge — both sides changed
          // from nothing, which conflicts and asks — instead of the clean
          // overwrite an equal-to-buffer base would produce.
          tabs.setBase(tab.id, "");
        }
      }
    }
  }
  updateTitle();
  setStatus(`${entries.length} document${entries.length === 1 ? "" : "s"} recovered`);
  autosave?.notifyChange(); // re-establish the journal from the live buffers
}

// ---- Wiring ----------------------------------------------------------------

/** Reflect the current theme preference in the header selector. */
function syncThemeSelect(): void {
  const select = document.querySelector<HTMLSelectElement>("#theme-select");
  if (select && theme) select.value = theme.current();
}

/** Route a native menu click (`menu_*` id) to the matching action. */
function handleMenuAction(id: string): void {
  switch (id) {
    case "menu_new":
      doNew();
      break;
    case "menu_open":
      void doOpenFile();
      break;
    case "menu_open_folder":
      void doOpenFolder();
      break;
    case "menu_save":
      void doSave();
      break;
    case "menu_save_as":
      void doSaveAs();
      break;
    case "menu_save_all":
      void doSaveAll();
      break;
    case "menu_toggle_sidebar":
      toggleSidebar();
      break;
    case "menu_toggle_outline":
      toggleOutline();
      break;
    case "menu_toggle_history":
      toggleHistory();
      break;
    case "menu_toggle_autosave":
      toggleAutosave();
      break;
    case "menu_export_html":
      void doExportHtml();
      break;
    case "menu_export_rtf":
      void doExportRtf();
      break;
    case "menu_about":
      void showAbout();
      break;
  }
}

function installShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    switch (e.key.toLowerCase()) {
      case "s":
        e.preventDefault();
        void (e.altKey ? doSaveAll() : e.shiftKey ? doSaveAs() : doSave());
        break;
      case "\\":
        e.preventDefault();
        if (e.shiftKey) toggleOutline();
        else toggleSidebar();
        break;
      case "o":
        e.preventDefault();
        void (e.shiftKey ? doOpenFolder() : doOpenFile());
        break;
      case "n":
        e.preventDefault();
        doNew();
        break;
      case "f":
        e.preventDefault();
        searchBar?.open();
        break;
      case "e":
        e.preventDefault();
        void doExportHtml();
        break;
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const editorRoot = document.querySelector<HTMLElement>("#editor");
  const tabbar = document.querySelector<HTMLElement>("#tabbar");
  const sidebarEl = document.querySelector<HTMLElement>("#sidebar");
  const formatBar = document.querySelector<HTMLElement>("#format-toolbar");
  if (!editorRoot || !tabbar || !sidebarEl || !formatBar) return;

  sidebar = new Sidebar(sidebarEl, { onOpenFile: (p) => void openPath(p) });
  sidebar.setRoot(null, []);
  tabs = new TabManager(tabbar, { onDeactivate, onActivate, onCloseRequest });

  // Theme controller is created before session restore so the restored UI
  // paints in the saved palette; persists the preference on change.
  theme = new ThemeController(() => scheduleSessionSave());
  const themeSelect = document.querySelector<HTMLSelectElement>("#theme-select");
  themeSelect?.addEventListener("change", () => {
    const value = themeSelect.value;
    if (isTheme(value)) theme?.set(value);
  });
  syncThemeSelect();

  loading = true;
  editor = await createEditor({
    root: editorRoot,
    initial: "",
    onChange: onEditorChange,
    onImagePaste,
  });
  loading = false;
  formatToolbar = new FormattingToolbar(formatBar, editor, editorRoot);
  const docStats = document.querySelector<HTMLElement>("#docstats");
  if (docStats) statusBar = new StatusBar(docStats, editor, editorRoot);
  const outlineEl = document.querySelector<HTMLElement>("#outline");
  if (outlineEl) outline = new Outline(outlineEl, editor, editorRoot);
  const historyEl = document.querySelector<HTMLElement>("#history");
  if (historyEl) {
    history = new History(
      historyEl,
      { list: listHistory, read: readSnapshot, restore: restoreVersion },
      { now: () => Date.now(), confirm: (message) => confirm(message) },
    );
  }
  const searchEl = document.querySelector<HTMLElement>("#searchbar");
  if (searchEl) searchBar = new SearchBar(searchEl, editor);
  // Its own row in #main, between the search bar and the editor: the banner
  // belongs above the document, not inside the surface that scrolls away.
  const conflictEl = document.querySelector<HTMLElement>("#conflictbar");
  if (conflictEl) conflictBar = new ConflictBar(conflictEl);

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
      reportError: (err) => setStatus(`Autosave failed: ${String(err)}`),
    },
    { enabled: autosaveEnabled, debounceMs: autosaveDebounceMs },
  );

  document.querySelector("#btn-new")?.addEventListener("click", () => doNew());
  document.querySelector("#btn-open")?.addEventListener("click", () => void doOpenFile());
  document.querySelector("#btn-open-folder")?.addEventListener("click", () => void doOpenFolder());
  document.querySelector("#btn-save")?.addEventListener("click", () => void doSave());
  document.querySelector("#btn-save-as")?.addEventListener("click", () => void doSaveAs());
  document.querySelector("#btn-save-all")?.addEventListener("click", () => void doSaveAll());
  document.querySelector("#btn-export")?.addEventListener("click", () => void doExportHtml());
  document.querySelector("#btn-export-rtf")?.addEventListener("click", () => void doExportRtf());
  document.querySelector("#btn-toggle-sidebar")?.addEventListener("click", () => toggleSidebar());
  document.querySelector("#btn-toggle-outline")?.addEventListener("click", () => toggleOutline());
  document.querySelector("#btn-toggle-history")?.addEventListener("click", () => toggleHistory());
  installShortcuts();
  void onMenuAction(handleMenuAction); // native menu → same actions as the buttons
  // Guard against losing unsaved work on close, and clear the recovery journal
  // on every clean close so a leftover journal always means "we crashed" (§3).
  void installCloseGuard(
    () => tabs.list().filter((t) => t.dirty).length,
    () => clearRecovery(),
  );

  // Restore the last session (folder + open files); fall back to a welcome tab
  // if there was nothing to restore or every remembered path is now gone.
  await restoreSession();
  await recoverCrashedBuffers();

  // A file passed at launch (double-click / "Open with", §5) takes priority over
  // the welcome fallback and becomes the active tab. openPath dedupes against any
  // already-restored tab, so a remembered + double-clicked file isn't opened twice.
  try {
    const launchPath = await takeLaunchPath();
    if (launchPath) await openPath(launchPath);
  } catch {
    // bad/missing path — ignore and fall through to the welcome tab
  }

  if (!tabs.active()) {
    openDocument(null, "Untitled", WELCOME);
  }

  // While Toril is already running, a second double-click is forwarded here by
  // the single-instance plugin rather than starting a new process (§5).
  void onOpenFile((path) => void openPath(path));
});
