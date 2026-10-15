mod commands;
mod menu;
mod settings;

use std::sync::Mutex;

use commands::workspace::WatcherState;
use tauri::{Emitter, Manager};

/// The file Toril was launched with via double-click / "Open with" (Windows
/// passes it as `argv[1]`). Captured at startup and handed to the frontend once
/// through `take_launch_path`; `None` afterwards so a session-restore pass can't
/// resurrect a file the user has since closed.
#[derive(Default)]
struct LaunchPath(Mutex<Option<String>>);

/// Pick the first argument that names a file to open: skip the executable path
/// (the first arg) and anything that looks like a flag. Pure, so the parsing
/// rule stays obvious without needing the webview to reason about it.
fn launch_path_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .skip(1)
        .find(|a| !a.is_empty() && !a.starts_with('-'))
}

/// The frontend pulls the launch path exactly once during bootstrap (§5). Taking
/// it clears the slot so a later session restore won't double-open the file.
#[tauri::command]
fn take_launch_path(state: tauri::State<'_, LaunchPath>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_path = LaunchPath(Mutex::new(launch_path_from_args(std::env::args())));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Self-update, desktop only — the mobile targets install through their app
    // stores (ROADMAP Movement V.28). Registering the plugin only exposes the
    // *ability* to check and install; whether either happens is decided in
    // `src/update.ts`, which never installs without the user saying so.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        // Single-instance: a second launch (e.g. double-clicking another file
        // while Toril is open) forwards its argv here instead of starting a new
        // process — open the file in the existing window and focus it.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = launch_path_from_args(argv) {
                let _ = app.emit("open-file", path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Remember where the window was and how big it was. Presentational
        // only — it writes its own file in the app config dir, never the vault.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .manage(launch_path)
        .manage(WatcherState::default())
        .manage(menu::MenuChecks::default())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                fit_to_work_area(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::open_file,
            commands::files::save_file,
            commands::workspace::open_folder,
            commands::workspace::watch_folder,
            commands::export::markdown_to_html,
            commands::export::export_html,
            commands::export::export_rtf,
            commands::images::save_clipboard_image,
            settings::load_settings,
            settings::save_settings,
            commands::recovery::save_recovery,
            commands::recovery::load_recovery,
            commands::recovery::clear_recovery,
            commands::entries::create_note,
            commands::entries::create_folder,
            commands::entries::suggest_note_name,
            commands::entries::rename_entry,
            commands::trash::move_to_trash,
            commands::trash::list_trash,
            commands::trash::restore_from_trash,
            commands::snapshots::list_history,
            commands::snapshots::read_snapshot,
            commands::snapshots::restore_snapshot,
            commands::sync::merge_external,
            commands::sync::write_conflict_copy,
            // No `get_api_key` here — by design, not by omission. A stored key
            // must never cross into the webview; see commands/secrets.rs.
            commands::secrets::set_api_key,
            commands::secrets::clear_api_key,
            commands::secrets::has_api_key,
            commands::secrets::list_api_keys,
            menu::set_recent_files,
            menu::set_menu_checks,
            take_launch_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// A window rectangle in physical pixels: x, y, width, height.
type Rect = (i32, i32, u32, u32);

/// Where `window` must go to lie inside `area`, or `None` if it already does.
///
/// Shrinks first (never below nothing), then slides it in. Pure so it is tested
/// without a display.
fn fit_rect(window: Rect, area: Rect) -> Option<Rect> {
    let (wx, wy, ww, wh) = window;
    let (ax, ay, aw, ah) = area;
    let w = ww.min(aw);
    let h = wh.min(ah);
    let max_x = ax + i32::try_from(aw - w).unwrap_or(i32::MAX);
    let max_y = ay + i32::try_from(ah - h).unwrap_or(i32::MAX);
    let x = wx.clamp(ax, max_x);
    let y = wy.clamp(ay, max_y);
    let fitted = (x, y, w, h);
    (fitted != window).then_some(fitted)
}

/// Keep the window on the screen it opens on.
///
/// Found on a 1280×720 (scaled) laptop: the default 700px-tall window, plus its
/// frame, is taller than the 672px work area, so the status bar opened behind
/// the taskbar — and the window-state plugin then faithfully restored that
/// every launch. Runs after the plugin's restore; a maximized window is left
/// alone, and one that already fits is not touched at all.
fn fit_to_work_area<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    if win.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(Some(monitor)), Ok(pos), Ok(outer), Ok(inner)) = (
        win.current_monitor(),
        win.outer_position(),
        win.outer_size(),
        win.inner_size(),
    ) else {
        return;
    };
    let work = monitor.work_area();
    let area = (
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
    );
    let Some((x, y, w, h)) = fit_rect((pos.x, pos.y, outer.width, outer.height), area) else {
        return;
    };
    // `set_size` takes the inner size; the frame is whatever outer adds to it.
    let frame_w = outer.width.saturating_sub(inner.width);
    let frame_h = outer.height.saturating_sub(inner.height);
    let _ = win.set_size(tauri::PhysicalSize::new(
        w.saturating_sub(frame_w),
        h.saturating_sub(frame_h),
    ));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(test)]
mod tests {
    use super::{fit_rect, launch_path_from_args};

    #[test]
    fn a_window_that_fits_is_left_alone() {
        assert_eq!(fit_rect((100, 50, 800, 600), (0, 0, 1920, 1032)), None);
    }

    #[test]
    fn a_window_taller_than_the_work_area_is_shrunk_to_it() {
        // The on-device case: 1280x672 work area, a window ~742 tall.
        assert_eq!(
            fit_rect((140, 0, 1016, 742), (0, 0, 1280, 672)),
            Some((140, 0, 1016, 672))
        );
    }

    #[test]
    fn a_window_hanging_off_an_edge_is_slid_back_on() {
        assert_eq!(
            fit_rect((1500, 900, 600, 400), (0, 0, 1920, 1040)),
            Some((1320, 640, 600, 400))
        );
        assert_eq!(
            fit_rect((-50, -20, 600, 400), (0, 0, 1920, 1040)),
            Some((0, 0, 600, 400))
        );
    }

    #[test]
    fn works_on_a_second_monitor_with_an_offset_origin() {
        assert_eq!(
            fit_rect((1900, 100, 800, 1200), (1920, 0, 1920, 1040)),
            Some((1920, 0, 800, 1040))
        );
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn skips_the_executable_and_returns_the_file() {
        assert_eq!(
            launch_path_from_args(args(&["toril.exe", r"C:\notes\todo.md"])),
            Some(r"C:\notes\todo.md".to_string())
        );
    }

    #[test]
    fn none_when_launched_without_a_file() {
        assert_eq!(launch_path_from_args(args(&["toril.exe"])), None);
    }

    #[test]
    fn ignores_leading_flags() {
        assert_eq!(
            launch_path_from_args(args(&["toril.exe", "--flag", "note.md"])),
            Some("note.md".to_string())
        );
    }
}
