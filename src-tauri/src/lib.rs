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

    tauri::Builder::default()
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
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| menu::on_event(app, event))
        .manage(launch_path)
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::files::open_file,
            commands::files::save_file,
            commands::files::save_file_as,
            commands::workspace::open_folder,
            commands::workspace::watch_folder,
            commands::export::markdown_to_html,
            commands::export::export_html,
            commands::export::export_rtf,
            commands::images::save_clipboard_image,
            settings::load_settings,
            settings::save_settings,
            take_launch_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::launch_path_from_args;

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
