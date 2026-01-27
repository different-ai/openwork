use tauri::State;

use crate::openwork_server::manager::OpenworkServerManager;
use crate::types::OpenworkServerInfo;

#[tauri::command]
pub fn openwork_server_info(manager: State<OpenworkServerManager>) -> OpenworkServerInfo {
    let mut state = manager.inner.lock().expect("openwork server mutex poisoned");
    OpenworkServerManager::snapshot_locked(&mut state)
}

// start/stop are handled by engine lifecycle
