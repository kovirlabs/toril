//! Native application menu (CLAUDE.md §8 Phase 4).
//!
//! Our custom items emit a `menu` event carrying the item id; the frontend
//! (`main.ts`) maps that id to the same handlers the toolbar buttons use, so the
//! menu adds discoverability + mouse access without a second action path. The
//! Edit menu uses the OS's predefined undo/cut/copy/paste/etc. items.
//!
//! Items intentionally carry **no accelerators** — the frontend keydown handler
//! stays the single shortcut path, so a menu click and a keyboard shortcut can
//! never double-fire (which would, e.g., open two Save dialogs). The shortcut is
//! shown in the label purely for discoverability.

use tauri::menu::{Menu, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Build the application menu (File / Edit / Help).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .text("menu_new", "New (Ctrl+N)")
        .text("menu_open", "Open File… (Ctrl+O)")
        .text("menu_open_folder", "Open Folder… (Ctrl+Shift+O)")
        .separator()
        .text("menu_save", "Save (Ctrl+S)")
        .text("menu_save_as", "Save As… (Ctrl+Shift+S)")
        .text("menu_save_all", "Save All (Ctrl+Alt+S)")
        .separator()
        .text("menu_export_html", "Export HTML… (Ctrl+E)")
        .text("menu_export_rtf", "Export RTF…")
        .separator()
        .quit()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .text("menu_toggle_sidebar", "Toggle Sidebar (Ctrl+\\)")
        .text("menu_toggle_outline", "Toggle Outline (Ctrl+Shift+\\)")
        .text("menu_toggle_history", "Toggle Version History")
        .separator()
        .text("menu_toggle_autosave", "Toggle Autosave")
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .text("menu_about", "About Toril")
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
