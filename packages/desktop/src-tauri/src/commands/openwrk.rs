use serde::Deserialize;
use serde_json::json;
use tauri::State;

use crate::openwrk::{resolve_openwrk_data_dir, resolve_openwrk_status};
use crate::openwrk::manager::OpenwrkManager;
use crate::types::{OpenwrkStatus, OpenwrkWorkspace};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenwrkWorkspaceResponse {
    pub workspace: OpenwrkWorkspace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenwrkDisposeResponse {
    pub disposed: bool,
}

fn resolve_data_dir(manager: &OpenwrkManager) -> String {
    manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.data_dir.clone())
        .unwrap_or_else(resolve_openwrk_data_dir)
}

fn resolve_base_url(manager: &OpenwrkManager) -> Result<String, String> {
    let data_dir = resolve_data_dir(manager);
    let status = resolve_openwrk_status(&data_dir, None);
    status
        .daemon
        .map(|daemon| daemon.base_url)
        .ok_or_else(|| "openwrk daemon is not running".to_string())
}

#[tauri::command]
pub fn openwrk_status(manager: State<OpenwrkManager>) -> OpenwrkStatus {
    let data_dir = resolve_data_dir(&manager);
    let last_error = manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.last_stderr.clone());
    resolve_openwrk_status(&data_dir, last_error)
}

#[tauri::command]
pub fn openwrk_workspace_activate(
    manager: State<OpenwrkManager>,
    workspace_path: String,
    name: Option<String>,
) -> Result<OpenwrkWorkspace, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
        "name": name,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to add workspace: {e}"))?;
    let added: OpenwrkWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse openwrk response: {e}"))?;

    let id = added.workspace.id.clone();
    let activate_url = format!("{}/workspaces/{}/activate", base_url.trim_end_matches('/'), id);
    ureq::post(&activate_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to activate workspace: {e}"))?;

    let path_url = format!("{}/workspaces/{}/path", base_url.trim_end_matches('/'), id);
    let _ = ureq::get(&path_url).call();

    Ok(added.workspace)
}

#[tauri::command]
pub fn openwrk_instance_dispose(
    manager: State<OpenwrkManager>,
    workspace_path: String,
) -> Result<bool, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to ensure workspace: {e}"))?;
    let added: OpenwrkWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse openwrk response: {e}"))?;

    let id = added.workspace.id;
    let dispose_url = format!("{}/instances/{}/dispose", base_url.trim_end_matches('/'), id);
    let response = ureq::post(&dispose_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to dispose instance: {e}"))?;
    let result: OpenwrkDisposeResponse = response
        .into_json()
        .map_err(|e| format!("Failed to parse openwrk response: {e}"))?;

    Ok(result.disposed)
}
