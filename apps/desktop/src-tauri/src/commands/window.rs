use tauri::{AppHandle, Manager};

/// Set window decorations (titlebar) visibility.
/// When `decorations` is false, the native titlebar is hidden.
/// This is useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
#[tauri::command]
pub fn set_window_decorations(app: AppHandle, decorations: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .set_decorations(decorations)
        .map_err(|e| format!("Failed to set decorations: {e}"))
}
