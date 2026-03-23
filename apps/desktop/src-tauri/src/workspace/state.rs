use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::types::{WorkspaceState, WorkspaceType, WORKSPACE_STATE_VERSION};

pub fn stable_workspace_id(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex = format!("{:x}", digest);
    format!("ws_{}", &hex[..12])
}

pub fn openwork_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let file_path = data_dir.join("openwork-workspaces.json");
    Ok((data_dir, file_path))
}

pub fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (_, path) = openwork_state_paths(app)?;
    if !path.exists() {
        return Ok(WorkspaceState::default());
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut state: WorkspaceState = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let mut changed_ids = false;
    let old_active_id = state.active_id.clone();
    for workspace in state.workspaces.iter_mut() {
        let next_id = match workspace.workspace_type {
            WorkspaceType::Local => stable_workspace_id(&workspace.path),
            WorkspaceType::Remote => {
                if workspace.remote_type == Some(crate::types::RemoteType::Openwork) {
                    stable_workspace_id_for_openwork(
                        workspace.openwork_host_url.as_deref().unwrap_or(""),
                        workspace.openwork_workspace_id.as_deref(),
                    )
                } else {
                    stable_workspace_id_for_remote(
                        workspace.base_url.as_deref().unwrap_or(""),
                        workspace.directory.as_deref(),
                    )
                }
            }
        };

        if workspace.id != next_id {
            if old_active_id == workspace.id {
                state.active_id = next_id.clone();
            }
            workspace.id = next_id;
            changed_ids = true;
        }
    }

    if state.version < WORKSPACE_STATE_VERSION {
        state.version = WORKSPACE_STATE_VERSION;
    }

    if changed_ids && state.active_id.is_empty() {
        state.active_id = state
            .workspaces
            .first()
            .map(|workspace| workspace.id.clone())
            .unwrap_or_default();
    }

    Ok(state)
}

pub fn save_workspace_state(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let (dir, path) = openwork_state_paths(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    fs::write(
        &path,
        serde_json::to_string_pretty(state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

pub fn stable_workspace_id_for_remote(base_url: &str, directory: Option<&str>) -> String {
    let mut key = format!("remote::{base_url}");
    if let Some(dir) = directory {
        if !dir.trim().is_empty() {
            key.push_str("::");
            key.push_str(dir.trim());
        }
    }
    stable_workspace_id(&key)
}

pub fn stable_workspace_id_for_openwork(host_url: &str, workspace_id: Option<&str>) -> String {
    let mut key = format!("openwork::{host_url}");
    if let Some(id) = workspace_id {
        if !id.trim().is_empty() {
            key.push_str("::");
            key.push_str(id.trim());
        }
    }
    stable_workspace_id(&key)
}
