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

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Checked state of the View menu's toggles, keyed by item id.
///
/// The frontend owns the truth (pane layout, autosave, update checks) and
/// reports it through [`set_menu_checks`]. It is held here as well because the
/// whole menu is rebuilt whenever the recent-files list changes, and a rebuilt
/// toggle must come back with its tick rather than unticked.
#[derive(Default)]
pub struct MenuChecks(Mutex<HashMap<String, bool>>);

fn is_checked<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    app.try_state::<MenuChecks>()
        .and_then(|state| state.0.lock().ok().and_then(|map| map.get(id).copied()))
        .unwrap_or(false)
}

/// A View-menu toggle: a real check item, ticked from [`MenuChecks`].
///
/// These were plain items, so "Autosave" gave no hint whether autosave was on —
/// the only way to find out was to click it and read the status line, which
/// also flipped it.
fn toggle<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<CheckMenuItem<R>> {
    let mut builder = CheckMenuItemBuilder::with_id(id, label).checked(is_checked(app, id));
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

/// Record the toggles' state and tick the live menu to match.
#[tauri::command]
pub fn set_menu_checks(app: AppHandle, checks: HashMap<String, bool>) -> Result<(), String> {
    if let Some(state) = app.try_state::<MenuChecks>()
        && let Ok(mut map) = state.0.lock()
    {
        map.extend(checks.iter().map(|(id, on)| (id.clone(), *on)));
    }
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    // `Menu::get` only looks at top-level entries; the toggles live in View.
    for entry in menu.items().map_err(|e| e.to_string())? {
        let Some(submenu) = entry.as_submenu() else {
            continue;
        };
        for (id, on) in &checks {
            if let Some(item) = submenu.get(id.as_str())
                && let Some(check) = item.as_check_menuitem()
            {
                check.set_checked(*on).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Build the application menu with an empty recent-files list.
///
/// The startup entry point: nothing has been opened yet, and the frontend
/// replaces the menu via [`set_recent_files`] once it has restored the list.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with_recent(app, &[])
}

/// Replace the application menu so File → Open Recent lists `paths`.
///
/// A whole-menu rebuild, because muda submenus are built rather than mutated —
/// there is no "replace these items" on a live menu. It is cheap (a dozen items)
/// and only happens when a file is opened or closed.
///
/// Items are identified by **index** (`menu_recent_3`), not by path. A path is
/// arbitrary user data — it can contain any character the filesystem allows —
/// and menu ids are matched as strings on the frontend, so encoding one into an
/// id makes the mapping depend on data neither side controls. The frontend holds
/// the authoritative list and resolves the index against it.
#[tauri::command]
pub fn set_recent_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let menu = build_with_recent(&app, &paths).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// The display name for a recent entry: the file name, not the whole path.
///
/// A menu is a narrow column and an absolute path is mostly directories the
/// user already knows. The full path goes nowhere here — the frontend's own
/// surfaces show it where there is room.
fn recent_label(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn build_with_recent<R: Runtime>(app: &AppHandle<R>, recent: &[String]) -> tauri::Result<Menu<R>> {
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

    // Open Recent. Built even when empty, carrying a single disabled "No recent
    // files" row: a submenu that vanishes on a fresh install teaches the user it
    // is not there, and a disabled row that explains itself is a smaller
    // surprise than a menu whose shape changes.
    let mut recent_menu = SubmenuBuilder::new(app, "Open &Recent");
    if recent.is_empty() {
        recent_menu = recent_menu.item(
            &MenuItemBuilder::with_id("menu_recent_none", "No recent files")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for (i, path) in recent.iter().enumerate() {
            recent_menu = recent_menu.item(
                &MenuItemBuilder::with_id(format!("menu_recent_{i}"), recent_label(path))
                    .build(app)?,
            );
        }
        recent_menu = recent_menu.separator().item(
            &MenuItemBuilder::with_id("menu_recent_clear", "&Clear Recent Files").build(app)?,
        );
    }
    let recent_submenu = recent_menu.build()?;

    let file = SubmenuBuilder::new(app, "&File")
        .item(&new)
        .item(&open)
        .item(&recent_submenu)
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
    let toggle_sidebar = toggle(
        app,
        "menu_toggle_sidebar",
        "Files &Pane",
        Some("CmdOrCtrl+\\"),
    )?;
    // One rail, two panels: these select a tab rather than toggling independent
    // columns, so choosing Outline while History is open switches instead of
    // widening the chrome (see `src/ui/panes.ts`).
    let toggle_outline = toggle(
        app,
        "menu_toggle_outline",
        "&Outline",
        Some("CmdOrCtrl+Shift+\\"),
    )?;
    let toggle_history = toggle(app, "menu_toggle_history", "Version &History", None)?;
    // Zoom scales the writing surface, not the chrome — the OS already scales
    // the whole UI, and a bigger tab bar is not what a tired writer wants.
    // `=`, not `Plus`: Windows renders no label for a Plus accelerator, so Zoom In
    // was the one zoom item with an empty shortcut column — and Ctrl+= (the
    // unshifted key) is what is actually pressed. The frontend accepts both.
    let zoom_in = MenuItemBuilder::with_id("menu_zoom_in", "Zoom &In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("menu_zoom_out", "Zoom O&ut")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("menu_zoom_reset", "&Reset Zoom")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let toggle_autosave = toggle(app, "menu_toggle_autosave", "&Autosave", None)?;
    let toggle_update_check = toggle(
        app,
        "menu_toggle_update_check",
        "Check for &Updates on Launch",
        None,
    )?;

    let view = SubmenuBuilder::new(app, "&View")
        .item(&find)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_outline)
        .item(&toggle_history)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&toggle_autosave)
        .item(&toggle_update_check)
        .build()?;

    // "Check for Updates…" sits in Help rather than File because it is about the
    // application, not the document — and it is where every desktop app the
    // target user has used puts it.
    let help = SubmenuBuilder::new(app, "&Help")
        .text("menu_check_updates", "Check for &Updates…")
        .separator()
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

#[cfg(test)]
mod tests {
    use super::recent_label;

    #[test]
    fn shows_the_file_name_not_the_path() {
        assert_eq!(recent_label(r"C:\Users\me\vault\todo.md"), "todo.md");
        assert_eq!(recent_label("/home/me/vault/todo.md"), "todo.md");
    }

    #[test]
    fn handles_a_bare_name_and_mixed_separators() {
        assert_eq!(recent_label("todo.md"), "todo.md");
        assert_eq!(recent_label("C:/vault\\sub/todo.md"), "todo.md");
    }

    /// A path that ends in a separator has no file name; returning the empty
    /// string is honest, and better than panicking on data from disk.
    #[test]
    fn does_not_panic_on_a_trailing_separator() {
        assert_eq!(recent_label("/vault/"), "");
        assert_eq!(recent_label(""), "");
    }
}
