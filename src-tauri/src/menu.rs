//! Native application menu (CLAUDE.md §8 Phase 4).
//!
//! Our custom items emit a `menu` event carrying the item id; the frontend
//! (`main.ts`) maps that id to a named action. The Edit menu uses the OS's
//! predefined undo/cut/copy/paste/etc. items.
//!
//! **Accelerators are real** (`feat/chrome-ux`). They used to be baked into the
//! label text — `"New (Ctrl+N)"` — because a registered accelerator and the
//! frontend's keydown handler would both fire on one keypress, opening two Save
//! dialogs. The cost was that Windows, which renders accelerators right-aligned
//! in grey, showed a literal parenthetical instead: the shortcut column simply
//! did not exist on the platform Toril targets.
//!
//! The double-fire is now handled where it belongs — one dispatcher in
//! `src/actions.ts` collapses the same action arriving twice within 80ms — so
//! both delivery paths can stay and the platform gets to render the menu the way
//! its users expect. See `tests/actions.test.ts`.
//!
//! **Mnemonics are declared with `&`** — muda's portable marker: a native
//! mnemonic on Windows, rewritten to GTK's `_` on Linux, stripped on macOS. One
//! spelling is correct everywhere, `&&` escapes a literal ampersand (hence
//! `"&Find && Replace…"`), and every top-level letter is distinct.
//!
//! **They are declared, not yet working.** The first Windows on-device sweep
//! found `Alt+F` doing nothing; the labels had no `&`, so adding it was
//! necessary — but `Alt+F` still does not open the File menu with the markers in
//! place. The likely cause is one layer down: the WebView2 child window holds
//! keyboard focus and consumes `Alt` before the top-level window's menu bar sees
//! `WM_SYSCHAR`, and every pixel of a Tauri window is that webview, so there is
//! no chrome to focus instead. Clicking the menu works; the accelerators
//! (`Ctrl+N` …) work and fire exactly once. Left declared because the markers
//! are correct regardless and are the half a future fix would otherwise have to
//! add — but do not read this as a verified mnemonic. Tracked as A2 in
//! `docs/ON-DEVICE-VERIFICATION.md`.

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Build the application menu (File / Edit / View / Help).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // `CmdOrCtrl` maps to Ctrl on Windows/Linux and Cmd on macOS, so one string
    // is correct everywhere.
    let new = MenuItemBuilder::with_id("menu_new", "&New")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("menu_open", "&Open File…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("menu_open_folder", "Open &Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("menu_save", "&Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("menu_save_as", "Save &As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let save_all = MenuItemBuilder::with_id("menu_save_all", "Save A&ll")
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;
    let export_html = MenuItemBuilder::with_id("menu_export_html", "&Export HTML…")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let export_rtf = MenuItemBuilder::with_id("menu_export_rtf", "Export &RTF…").build(app)?;

    let file = SubmenuBuilder::new(app, "&File")
        .item(&new)
        .item(&open)
        .item(&open_folder)
        .separator()
        .item(&save)
        .item(&save_as)
        .item(&save_all)
        .separator()
        .item(&export_html)
        .item(&export_rtf)
        .separator()
        // No "API Keys…" item: the secret store (`crates/keystore` + the
        // `*_api_key` commands) is built and gated, but nothing consumes a key
        // until the AI panel lands (ROADMAP branch 20). Surfacing it now would
        // promise a feature that does not exist. Re-add it there.
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "&Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let find = MenuItemBuilder::with_id("menu_find", "&Find && Replace…")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("menu_toggle_sidebar", "Files &Pane")
        .accelerator("CmdOrCtrl+\\")
        .build(app)?;
    // One rail, two panels: these select a tab rather than toggling independent
    // columns, so choosing Outline while History is open switches instead of
    // widening the chrome (see `src/ui/panes.ts`).
    let toggle_outline = MenuItemBuilder::with_id("menu_toggle_outline", "&Outline")
        .accelerator("CmdOrCtrl+Shift+\\")
        .build(app)?;
    let toggle_history =
        MenuItemBuilder::with_id("menu_toggle_history", "Version &History").build(app)?;
    let toggle_autosave =
        MenuItemBuilder::with_id("menu_toggle_autosave", "&Autosave").build(app)?;

    let view = SubmenuBuilder::new(app, "&View")
        .item(&find)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_outline)
        .item(&toggle_history)
        .separator()
        .item(&toggle_autosave)
        .build()?;

    let help = SubmenuBuilder::new(app, "&Help")
        .text("menu_about", "&About Toril")
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &help])
        .build()
}

/// Forward our custom item ids to the frontend. Predefined items (quit, copy,
/// …) are handled natively by the OS and ignored here.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id.starts_with("menu_") {
        let _ = app.emit("menu", id);
    }
}
