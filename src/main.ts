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
import { LoadEcho } from "./editor/loadecho";
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
import { ActionDispatcher } from "./actions";
import { AutosaveScheduler, type RecoveryEntry, selectDirtySaved, snapshotDirty } from "./autosave";
import { isAtOrUnder } from "./paths";
import {
  blocksWrite,
  decideAction,
  describeSaveAll,
  selectMine,
  selectRemovedOnDisk,
  selectSavable,
} from "./sync";
import { ConflictBar } from "./ui/conflictbar";
import { History } from "./ui/history";
import { Outline } from "./ui/outline";
import {
  PANE_LIMITS,
  type PaneState,
  type RailTab,
  defaultPaneState,
  effectiveLayout,
  hideRail,
  paneCssVars,
  restorePaneState,
  selectRailTab,
  setRailWidth,
  setSidebarWidth,
  toSettingsPatch,
  toggleSidebar as togglePaneSidebar,
} from "./ui/panes";
import { Rail } from "./ui/rail";
import { attachResizer, initResizeHandle, syncHandleValue } from "./ui/resizer";
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
let panes: PaneState = defaultPaneState();
let rail: Rail | null = null;
let unwatch: UnlistenFn | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;

let loading = false; // suppress the dirty flag during a *synchronous* load
/** Suppresses the dirty flag for the debounced echo of a programmatic load. */
const loadEcho = new LoadEcho();
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
  // The window title is the only place the document name is shown now: the old
  // #doc-title element repeated what the active tab already says, two inches
  // away from it.
  document.title = tab ? `${shown} — Toril` : "Toril";
  sidebar.setActivePath(tab?.path ?? null);
}

// Format-aware bridges to the two canonical serializers (§3.2). The active tab's
// `format` decides which one runs; everything else (tabs, save, session) is shared.
function loadIntoEditor(content: string, format: DocFormat): void {
  loading = true;
  if (format === "html") htmlToDoc(editor, content);
  else markdownToDoc(editor, content);
  loading = false;
  // `loading` only covers a *synchronous* notification. Milkdown's listener is
  // debounced 200ms, so the notification for this load lands well after the flag
  // closes — `loadEcho` is what actually keeps a load from marking the tab dirty
  // (see src/editor/loadecho.ts).
  loadEcho.arm(serializeEditor(format));
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
  const active = tabs.active();
  // A load's own echo, arriving after the debounce. Nothing changed, so nothing
  // downstream needs doing: `onActivate` already refreshed the chrome, and
  // marking dirty here would arm autosave to rewrite a note nobody edited.
  if (active && loadEcho.isEcho(serializeEditor(active.format))) return;
  statusBar?.refresh();
  outline?.refresh();
  if (active && !active.dirty) {
    tabs.setDirty(active.id, true);
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
  tabs.setRemovedOnDisk(tab.id, false); // whatever was gone, this write recreated
  // What we just wrote is what is on disk — the merge base for the next
  // external change, and what makes our own watcher event report `unchanged`.
  tabs.setBase(tab.id, content);
  tabs.setDirty(tab.id, false);
  updateTitle();
  setStatus(`Saved ${basename(path)}`);
  autosave?.notifyChange();
  refreshHistory(); // a save just created a new version
}

/**
 * Re-check one tab against disk and report whether it may now be written.
 *
 * The order is the whole point: reconcile FIRST, then consult `blocksWrite`.
 * Refusing on the stale flag first would trap any tab whose divergence came from
 * a path the watcher never reports — a network share, a FUSE mount, a file
 * outside the watched workspace root — with no exit at all: the banner says
 * saving is paused until the file can be read again, and nothing would ever
 * unpause it. Reconciling first gives every write the chance to clear a stale
 * divergence: a read that has since started working, an external edit that was
 * reverted, or a deletion (which reconcile answers by recreating on save).
 *
 * This costs one extra read per save, and it is where the feature's guarantee
 * actually lives. The watcher is an optimization — it drops and coalesces events
 * on precisely the setups this branch exists to support.
 */
async function recheckBeforeWrite(tab: TabState): Promise<boolean> {
  await reconcile(tab);
  return !blocksWrite(tab);
}

async function doSave(): Promise<void> {
  const tab = tabs.active();
  if (!tab) return;
  if (!tab.path) {
    // An Untitled draft has nothing on disk to diverge from — Save As is exempt.
    await doSaveAs();
    return;
  }
  if (!(await recheckBeforeWrite(tab))) {
    renderConflictBar();
    setStatus(`${tab.name} changed on disk — resolve the banner before saving`);
    return;
  }
  try {
    if (tabs.active()?.id === tab.id) {
      await persistActive(tab.path);
    } else {
      // The user switched tabs while we re-checked disk, so the editor no longer
      // holds this document and `persistActive` would write the wrong bytes to
      // this path. `onDeactivate` flushed the buffer on the way out — write that.
      if ((await saveTabsToDisk([tab])) > 0) {
        updateTitle();
        setStatus(`Saved ${tab.name}`);
      }
    }
  } catch (e) {
    setStatus(`Save failed: ${String(e)}`);
  }
}

/**
 * Save the given path-backed tabs atomically (dirty filtering is the caller's).
 *
 * The divergence check here is the last line of defence, not the first: callers
 * reconcile before selecting, so anything still diverged at this point has been
 * re-checked against disk and genuinely needs the user. Refusing silently would
 * be worse than not refusing at all, so each skip says so.
 */
async function saveTabsToDisk(list: readonly TabState[]): Promise<number> {
  let saved = 0;
  for (const tab of list) {
    if (!tab.path) continue;
    if (blocksWrite(tab)) {
      setStatus(`Skipped ${tab.name} — it changed on disk`);
      continue;
    }
    try {
      await saveFile(tab.path, tab.content);
      tabs.setBase(tab.id, tab.content);
      tabs.setRemovedOnDisk(tab.id, false); // whatever was gone, this write recreated
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

/**
 * Reconcile every dirty, path-backed tab against disk and return the subset that
 * may now be written. Shared by Save All and autosave — the two bulk writers.
 *
 * Two things make this more than a loop.
 *
 * The active buffer is re-captured *between* passes and again at the end.
 * `captureActiveBuffer` runs once, then N sequential IPC round-trips happen;
 * anything typed during them is on screen but not in `tab.content`, so writing
 * the stale buffer and then clearing `dirty` would strand those keystrokes
 * nowhere — not on disk, not in the journal, and with the close guard silent.
 *
 * And nothing is returned that was not itself reconciled. A tab can *enter* the
 * dirty set while we await, and writing it unchecked is exactly the hole this
 * task exists to close; a second pass picks those up. Two passes, not a loop to
 * a fixed point: anything that only turns dirty during the second pass is left
 * for the next round, which costs a delay and never a keystroke. The residual
 * window between the last read and the write is the documented TOCTOU limit.
 */
async function reconcileWritableTabs(): Promise<{
  writable: TabState[];
  blocked: number;
  removed: string[];
}> {
  const reconciled = new Set<string>();
  for (let pass = 0; pass < 2; pass++) {
    captureActiveBuffer();
    const pending = selectDirtySaved(tabs.list()).filter((t) => !reconciled.has(t.id));
    if (pending.length === 0) break;
    for (const tab of pending) {
      reconciled.add(tab.id);
      await reconcile(tab);
    }
  }
  captureActiveBuffer(); // the last reconcile awaited too
  const candidates = selectDirtySaved(tabs.list());
  return {
    // `selectSavable`'s rule, plus "we re-checked this one ourselves".
    writable: selectSavable(candidates).filter((t) => reconciled.has(t.id)),
    blocked: candidates.filter(blocksWrite).length,
    removed: selectRemovedOnDisk(candidates).map((t) => t.name),
  };
}

/** Save every dirty, file-backed tab (Untitled tabs need Save As and are skipped). */
async function doSaveAll(): Promise<void> {
  // Save All is the real clobber vector: it loops every dirty tab, so a
  // background tab that diverged an hour ago, or one outside the watched root
  // that never gets an event at all, would otherwise be overwritten with no
  // prompt ever shown. It also refuses to *recreate* a file that vanished — the
  // rename-resurrection case `selectSavable` documents. A focused File → Save
  // still recreates it.
  const { writable, blocked, removed } = await reconcileWritableTabs();
  const saved = await saveTabsToDisk(writable);
  updateTitle();
  autosave?.notifyChange();
  renderConflictBar();
  // Say what was skipped, and what to do about it.
  const message = describeSaveAll(saved, blocked, removed);
  if (message) setStatus(message);
}

/**
 * Save As is exempt from the divergence check by design. A *new* path has no
 * shared history to diverge from, and Save As *over* an existing file is an
 * overwrite the user explicitly chose in the native dialog. Checking here would
 * block a legitimate first write and make the dialog behave unpredictably.
 */
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
    // Any divergence — or removal — belonged to the *old* path. Carrying it over
    // would block every future save of a file that has just been written
    // cleanly, with a banner about a conflict on a file this tab no longer
    // points at.
    tabs.setDiverged(tab.id, null);
    tabs.setRemovedOnDisk(tab.id, false);
    renderConflictBar();
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

// ---- Pane layout (sidebar + tabbed rail) -----------------------------------
//
// All pane decisions live in `panes.ts` as value transforms; this half only
// writes the result to the DOM and schedules a save. The split is what lets the
// interesting behaviour — toggle semantics, restore clamping, the migration off
// the two-rail era — be gated headlessly (§8).

/** Push the current pane state into the DOM. */
function applyPanes(): void {
  const workspace = document.querySelector<HTMLElement>("#workspace");
  if (!workspace) return;

  // What is rendered is *derived* from the stored choice plus the window we
  // actually have: on a window too narrow for both side panes, only the most
  // recently opened one shows. `panes` itself is untouched, so widening the
  // window brings the other one straight back.
  const layout = effectiveLayout(panes, window.innerWidth);

  for (const [name, value] of Object.entries(paneCssVars(panes, window.innerWidth))) {
    workspace.style.setProperty(name, value);
  }
  workspace.classList.toggle("sidebar-hidden", !layout.sidebarVisible);
  workspace.classList.toggle("rail-hidden", !layout.railVisible);

  // `inert` is what removes a collapsed pane from the tab order and the
  // accessibility tree. That was `display: none`'s job, but `display: none` also
  // cancels transitions — which is why collapse could never animate. A delayed
  // `visibility: hidden` in CSS guards the same thing engine-independently (§3.5).
  const sidebarEl = document.querySelector<HTMLElement>("#sidebar");
  if (sidebarEl) sidebarEl.inert = !layout.sidebarVisible;
  const railEl = document.querySelector<HTMLElement>("#rail");
  if (railEl) railEl.inert = !layout.railVisible;

  const sidebarBtn = document.querySelector<HTMLElement>("#btn-toggle-sidebar");
  if (sidebarBtn) sidebarBtn.dataset.active = String(layout.sidebarVisible);
  const outlineBtn = document.querySelector<HTMLElement>("#btn-rail-outline");
  if (outlineBtn) {
    outlineBtn.dataset.active = String(layout.railVisible && panes.railTab === "outline");
  }
  const historyBtn = document.querySelector<HTMLElement>("#btn-rail-history");
  if (historyBtn) {
    historyBtn.dataset.active = String(layout.railVisible && panes.railTab === "history");
  }

  rail?.setActive(panes.railTab);

  const sidebarHandle = document.querySelector<HTMLElement>("#resize-sidebar");
  if (sidebarHandle) syncHandleValue(sidebarHandle, layout.sidebarWidth, PANE_LIMITS.sidebar);
  const railHandle = document.querySelector<HTMLElement>("#resize-rail");
  if (railHandle) syncHandleValue(railHandle, layout.railWidth, PANE_LIMITS.rail);
}

function setPanes(next: PaneState, persist = true): void {
  panes = next;
  applyPanes();
  if (persist) scheduleSessionSave();
}

function toggleSidebar(): void {
  setPanes(togglePaneSidebar(panes));
}

/**
 * Bind the two drag handles.
 *
 * Widths are applied live during the drag but only persisted on release —
 * otherwise a single drag would queue a session write per pointer event.
 */
function installResizers(): void {
  const sidebarHandle = document.querySelector<HTMLElement>("#resize-sidebar");
  if (sidebarHandle) {
    initResizeHandle(sidebarHandle, "Resize files pane");
    attachResizer(sidebarHandle, "left", PANE_LIMITS.sidebar, {
      currentWidth: () => panes.sidebarWidth,
      reservedWidth: () => (panes.railVisible ? panes.railWidth : 0),
      onWidth: (w) => setPanes(setSidebarWidth(panes, w, window.innerWidth), false),
      onCollapse: () => {
        if (panes.sidebarVisible) setPanes(togglePaneSidebar(panes), false);
      },
      onCommit: () => scheduleSessionSave(),
    });
  }

  const railHandle = document.querySelector<HTMLElement>("#resize-rail");
  if (railHandle) {
    initResizeHandle(railHandle, "Resize panel rail");
    attachResizer(railHandle, "right", PANE_LIMITS.rail, {
      currentWidth: () => panes.railWidth,
      reservedWidth: () => (panes.sidebarVisible ? panes.sidebarWidth : 0),
      onWidth: (w) => setPanes(setRailWidth(panes, w, window.innerWidth), false),
      onCollapse: () => {
        if (panes.railVisible) setPanes(hideRail(panes), false);
      },
      onCommit: () => scheduleSessionSave(),
    });
  }

  // Rendered widths are derived from the viewport, so a resize only needs a
  // re-render. Nothing is written to state: narrowing the window must not edit
  // the width the user chose, or widening it again would never give it back.
  window.addEventListener("resize", () => applyPanes());
}

/** Open the rail on `tab`, switch to it, or close it — see `selectRailTab`. */
function selectRail(tab: RailTab): void {
  setPanes(selectRailTab(panes, tab));
  // Populate on show; a no-op read while hidden or on another tab.
  if (tab === "history") refreshHistory();
}

/** Point the panel at the active note's current buffer. Skipped while hidden so
 *  it never reads the store needlessly. */
function refreshHistory(): void {
  if (!history || !panes.railVisible || panes.railTab !== "history") return;
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
  // Restore is a write path twice over: the pre-restore save writes the buffer,
  // and `restoreSnapshot` then writes the chosen version over the file. Neither
  // may run past an external change the user has not seen (§3).
  if (tab && tab.path === path) {
    if (!(await recheckBeforeWrite(tab))) {
      renderConflictBar();
      setStatus(`${tab.name} changed on disk — resolve the banner before restoring`);
      return;
    }
    // That re-check awaited. If the user switched tabs during it, the editor no
    // longer holds this document — and `persistActive` re-resolves the *active*
    // tab, so it would write the new tab's bytes to this path and then mark the
    // new tab clean, stranding edits that were never written anywhere. Abort
    // rather than finish the restore against a stale reference.
    if (tabs.active()?.id !== tab.id) {
      setStatus("Restore cancelled — you switched documents");
      return;
    }
    if (tab.dirty) {
      try {
        await persistActive(path);
      } catch (e) {
        setStatus(`Save before restore failed: ${String(e)}`);
        return;
      }
    }
  }
  await restoreSnapshot(path, hash);
  const reloaded = await openFile(path);
  // Two more awaits, so the same switch is possible again — and the restore has
  // now happened on disk, so the tab's buffer must be brought in line whether or
  // not it is on screen. `loadIntoEditor` targets the live editor, so it is the
  // one step gated on the tab still being active (the `reconcile` pattern).
  const target = tabs.byPath(path);
  if (target) {
    target.content = reloaded.content;
    tabs.setBase(target.id, reloaded.content);
    tabs.setDirty(target.id, false);
    if (target.id === tabs.active()?.id) {
      loadIntoEditor(reloaded.content, target.format);
      outline?.refresh();
      statusBar?.refresh();
    }
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
 * The file behind an open tab has vanished. A sync daemon deleting a file the
 * user has open must not vaporize their buffer: keep it, mark it dirty, and the
 * next save recreates the file.
 *
 * An `error` divergence is cleared here because the deletion is what that read
 * tripped over, and an `error` has no user-actionable exit — leaving it set
 * would block the very save this status line promises. A `conflict` divergence
 * is left alone: its `theirs` is real content the user can still park.
 */
function markRemovedOnDisk(tab: TabState): void {
  const alreadyKnown = tab.removedOnDisk;
  const wasDirty = tab.dirty;
  if (tab.diverged?.reason === "error") tabs.setDiverged(tab.id, null);
  // Dirty so the close guard warns and the journal picks the buffer up;
  // `removedOnDisk` so the bulk writers leave the recreation to the user (see the
  // field's doc comment and `selectSavable`).
  tabs.setRemovedOnDisk(tab.id, true);
  tabs.setDirty(tab.id, true);
  // `setDirty` only re-renders the tab strip — the recovery journal is written
  // exclusively by the autosave debounce, so without this arming step the buffer
  // of a note whose file just vanished lives nowhere but memory: the file is
  // gone, the journal has no entry, and if Toril never saved this note version
  // history has nothing either. Kill the process and the only copy is lost (§3).
  //
  // Armed on the transition only. Every save and every autosave tick reconciles,
  // so arming unconditionally would re-arm the debounce from inside its own
  // flush and cycle a journal write plus a `merge_external` round-trip every two
  // seconds for as long as the file stays deleted.
  if (!alreadyKnown || !wasDirty) autosave?.notifyChange();
  // Announce the transition only, for the same reason.
  if (!alreadyKnown) setStatus(`${tab.name} was removed on disk — save to recreate it`);
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

  /** The live editor for the active tab; `null` means "this tab isn't on screen". */
  const liveBuffer = (): string | null =>
    tab.id === tabs.active()?.id ? serializeEditor(tab.format) : null;

  // The file may be deleted while we await IPC below; the `remove` branch of the
  // watcher owns that tab from then on, and applying a stale merge over the top
  // of its decision would undo it.
  const epoch = removalEpoch.get(path) ?? 0;
  const removedMeanwhile = (): boolean => (removalEpoch.get(path) ?? 0) !== epoch;

  // Up to two attempts, because `mine` is captured *before* an await and the two
  // outcomes that end in `loadIntoEditor` replace the ProseMirror document
  // wholesale. Anything typed while `merge_external` was in flight is on screen
  // but not in `mine`, so it is not in the merged text either — applying it
  // destroys those keystrokes, and the `reload` branch also clears `dirty`, so
  // the loss isn't even flagged. Detect it by re-selecting `mine` after the
  // await and comparing; recompute once against the buffer that actually exists.
  //
  // A second race falls through to a conflict rather than bailing out. Bailing
  // would leave the tab un-diverged with an external change unaccounted for, and
  // this function is also the pre-write check (`recheckBeforeWrite`,
  // `reconcileWritableTabs`) — a silent "no result" there reads as "clear to
  // write" and the save clobbers the external change. Failing closed keeps both
  // sides: the banner parks the loser whichever way the user answers.
  for (let attempt = 0; attempt < 2; attempt++) {
    const mine = selectMine(tab, liveBuffer);

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
          message:
            `could not be read from disk (${String(e)}). ` +
            `Your edits are untouched here; saving is paused until the file can be read again`,
        });
        renderConflictBar();
        return;
      }
    }
    if (removedMeanwhile()) return;

    // The file is gone. That is not a conflict and not an error: there is no
    // "theirs" to weigh against, the buffer is the only copy left, and the answer
    // is to recreate the file on the next save. Handled here rather than in
    // `decideAction` because it is the one outcome that must *unblock* a write —
    // and it does not depend on `mine`, so a raced buffer cannot make it wrong.
    if (report.outcome === "missing") {
      markRemovedOnDisk(tab);
      updateTitle();
      renderConflictBar();
      return;
    }
    // The read succeeded, so the file exists — a previous removal has been undone
    // (restored by the sync client, or recreated by a save). Clear the flag here
    // rather than only on our own writes, so an externally restored file starts
    // autosaving again without the user having to do anything.
    tabs.setRemovedOnDisk(tab.id, false);

    // Only the two buffer-replacing outcomes are gated. `unchanged` means disk
    // equals base — a fact about disk alone — and `conflict` writes nothing and
    // blocks the tab, which is the safe direction to be wrong in.
    if (report.outcome === "theirsOnly" || report.outcome === "merged") {
      if (selectMine(tab, liveBuffer) !== mine) {
        if (attempt === 0) continue;
        report = { outcome: "conflict", content: null, theirs: report.theirs };
      }
    }

    const action = decideAction(report, tab.format, tab.dirty);
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
        // The merged text exists nowhere but memory until the user saves, so put
        // it in the recovery journal now (§3) — `setDirty` alone never does.
        autosave?.notifyChange();
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
}

/** Show the banner for the active tab if it is diverged; hide it otherwise. */
function renderConflictBar(): void {
  const tab = tabs.active();
  if (!tab || !tab.diverged) {
    conflictBar?.hide();
    return;
  }
  // An `error` divergence has no `theirs`, so neither choice exists and nothing
  // has been parked — the bar renders as a notice, without the two buttons or
  // the park guarantee that `resolveConflict` would refuse to honour.
  if (tab.diverged.reason === "error") {
    conflictBar?.show({ name: tab.name, message: tab.diverged.message, actions: "none" });
    return;
  }
  conflictBar?.show({
    name: tab.name,
    message: tab.diverged.message,
    actions: "resolve",
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
  // Same rule as `reconcile`: "my version" of a tab with no unsaved edits is the
  // merge base, not a fresh canonical serialization of the buffer (`selectMine`).
  const mine = selectMine(tab, () =>
    tab.id === tabs.active()?.id ? serializeEditor(tab.format) : null,
  );

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
  // Keep-mine leaves the buffer dirty and unwritten, and keep-theirs drops an
  // entry the journal still holds; `setDirty` re-renders the tab strip and
  // nothing else, so the journal only moves when the autosave debounce is armed.
  autosave?.notifyChange();
  if (workspaceRoot) scheduleSidebarRefresh(); // the conflict copy is a new file
  setStatus(`Saved the other version as ${basename(parked)}`);
}

function handleWorkspaceChange(change: WorkspaceChange): void {
  // The tree may have changed (create/remove/rename) — refresh the sidebar.
  scheduleSidebarRefresh();

  if (change.kind === "remove") {
    // `notify` reports a removed *directory* as a single event carrying only the
    // directory path, so exact matching would miss every open tab whose file
    // lived inside it — those tabs would get no signal at all.
    const wasRemoved = (p: string): boolean => change.paths.some((r) => isAtOrUnder(p, r));

    // Cancel any reconcile still queued for a path that no longer exists: it
    // would fail both read attempts and leave an `error` divergence that no
    // later event can clear, blocking the very save promised below. The epoch
    // bump does the same for a reconcile already in flight — keyed by tab path,
    // which is what `reconcile` reads (a removed directory's own path is not).
    for (const [path, pending] of reconcileTimers) {
      if (!wasRemoved(path)) continue;
      clearTimeout(pending);
      reconcileTimers.delete(path);
    }

    for (const tab of tabs.list()) {
      if (!tab.path || !wasRemoved(tab.path)) continue;
      removalEpoch.set(tab.path, (removalEpoch.get(tab.path) ?? 0) + 1);
      markRemovedOnDisk(tab);
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
      ...toSettingsPatch(panes),
      // Legacy pane flags are read once to migrate and then never written, so
      // the migration in `restorePaneState` cannot fire a second time.
      outline_visible: null,
      history_visible: null,
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
  // Widths are clamped against the *current* viewport, so a layout saved on a
  // larger monitor cannot restore into something unusable here. Applied without
  // persisting: restoring is not a user edit, and writing back immediately would
  // make a clamp permanent for the wider screen too.
  setPanes(restorePaneState(settings, window.innerWidth), false);
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

/** Reflect the current theme preference in the status-bar selector. */
function syncThemeSelect(): void {
  const select = document.querySelector<HTMLSelectElement>("#theme-select");
  if (select && theme) select.value = theme.current();
}

/**
 * Every command, by name. Both doors — the native menu and the keydown handler
 * — go through here, so an action exists in exactly one place regardless of how
 * the user reached it.
 */
const ACTIONS: Record<string, () => void> = {
  menu_new: () => doNew(),
  menu_open: () => void doOpenFile(),
  menu_open_folder: () => void doOpenFolder(),
  menu_save: () => void doSave(),
  menu_save_as: () => void doSaveAs(),
  menu_save_all: () => void doSaveAll(),
  menu_toggle_sidebar: () => toggleSidebar(),
  menu_toggle_outline: () => selectRail("outline"),
  menu_toggle_history: () => selectRail("history"),
  menu_toggle_autosave: () => toggleAutosave(),
  menu_export_html: () => void doExportHtml(),
  menu_export_rtf: () => void doExportRtf(),
  menu_find: () => searchBar?.open(),
  menu_about: () => void showAbout(),
};

const dispatcher = new ActionDispatcher();

/**
 * Run a named action, at most once per physical trigger.
 *
 * Now that `menu.rs` carries real accelerators, one Ctrl+S arrives twice — from
 * the menu and from the webview keydown. The dispatcher collapses the pair; see
 * `actions.ts` for why both doors are kept rather than one being disabled.
 */
function runAction(id: string): void {
  const action = ACTIONS[id];
  if (action) dispatcher.dispatch(id, action);
}

function installShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const id = shortcutAction(e);
    if (!id) return;
    e.preventDefault();
    runAction(id);
  });
}

/** Map a keydown to an action id, or null if it is not a Toril shortcut. */
function shortcutAction(e: KeyboardEvent): string | null {
  switch (e.key.toLowerCase()) {
    case "s":
      return e.altKey ? "menu_save_all" : e.shiftKey ? "menu_save_as" : "menu_save";
    case "\\":
      return e.shiftKey ? "menu_toggle_outline" : "menu_toggle_sidebar";
    case "o":
      return e.shiftKey ? "menu_open_folder" : "menu_open";
    case "n":
      return "menu_new";
    case "f":
      return "menu_find";
    case "e":
      return "menu_export_html";
    default:
      return null;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const editorRoot = document.querySelector<HTMLElement>("#editor");
  const tabbar = document.querySelector<HTMLElement>("#tabbar");
  // The tree renders into the pane's inner scroller, not the pane itself: the
  // pane animates its width to zero on collapse while the scroller keeps the
  // stored width, so content slides out of view instead of reflowing into a
  // narrowing column.
  const sidebarEl = document.querySelector<HTMLElement>("#sidebar-body");
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
  // The rail owns which panel is showing; the panels themselves are unchanged
  // and still render into #outline / #history.
  const railEl = document.querySelector<HTMLElement>("#rail");
  if (railEl) rail = new Rail(railEl, { onSelect: (tab) => selectRail(tab) });

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
        // Autosave is the write path that must never guess: it runs with the
        // user's attention elsewhere, so writing over an external change here is
        // precisely the silent overwrite §3 forbids. It must not *recreate* a
        // vanished file either — `selectSavable` excludes both, for Save All as
        // well as here. "Save to recreate it" is a promise about a focused save;
        // until the user makes one the buffer's safety net is the recovery
        // journal, which `markRemovedOnDisk` arms when the file disappears.
        const { writable } = await reconcileWritableTabs();
        await saveTabsToDisk(writable);
        updateTitle();
        renderConflictBar();
      },
      reportError: (err) => setStatus(`Autosave failed: ${String(err)}`),
    },
    { enabled: autosaveEnabled, debounceMs: autosaveDebounceMs },
  );

  // The eleven command buttons that used to live in a toolbar above the tabs are
  // gone: every one of them already existed as a native menu item, so the row
  // was ~50px of permanent chrome duplicating the menu bar. Only the three pane
  // toggles remain, and they now sit on the side they control.
  document.querySelector("#btn-toggle-sidebar")?.addEventListener("click", () => toggleSidebar());
  document.querySelector("#btn-rail-outline")?.addEventListener("click", () => selectRail("outline"));
  document.querySelector("#btn-rail-history")?.addEventListener("click", () => selectRail("history"));
  installShortcuts();
  installResizers();
  void onMenuAction(runAction); // native menu → the same named actions as the keyboard
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
