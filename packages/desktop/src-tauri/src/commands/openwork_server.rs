use tauri::{AppHandle, State};

use crate::openwork_server::{manager::OpenworkServerManager, start_openwork_server};
use crate::types::OpenworkServerInfo;

#[tauri::command]
pub fn openwork_server_info(manager: State<OpenworkServerManager>) -> OpenworkServerInfo {
    let mut state = manager.inner.lock().expect("openwork server mutex poisoned");
    OpenworkServerManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn openwork_server_stop(manager: State<OpenworkServerManager>) -> OpenworkServerInfo {
    let mut state = manager.inner.lock().expect("openwork server mutex poisoned");
    OpenworkServerManager::stop_locked(&mut state);
    OpenworkServerManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn openwork_server_start(
    app: AppHandle,
    manager: State<OpenworkServerManager>,
    workspace_path: String,
) -> Result<OpenworkServerInfo, String> {
    start_openwork_server(&app, &manager, &workspace_path)
}
