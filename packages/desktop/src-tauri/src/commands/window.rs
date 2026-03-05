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

/// Minimize the window
#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .minimize()
        .map_err(|e| format!("Failed to minimize window: {e}"))
}

/// Maximize or restore the window
#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

/// Close the window
#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .close()
        .map_err(|e| format!("Failed to close window: {e}"))
}

/// Check if window is maximized
#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window.is_maximized().map_err(|e| e.to_string())
}

/// Start dragging the window (for custom title bar)
#[tauri::command]
pub fn window_start_dragging(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .start_dragging()
        .map_err(|e| format!("Failed to start dragging: {e}"))
}
