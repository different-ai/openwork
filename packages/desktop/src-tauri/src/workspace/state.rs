use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use tauri::Manager;

use crate::types::{WorkspaceInfo, WorkspaceState, WorkspaceType, WORKSPACE_STATE_VERSION};

pub fn stable_workspace_id(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("ws-{:x}", hasher.finish())
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

    if state.version < WORKSPACE_STATE_VERSION {
        state.version = WORKSPACE_STATE_VERSION;
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

pub fn ensure_starter_workspace(app: &tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let starter_dir = data_dir.join("workspaces").join("starter");
    fs::create_dir_all(&starter_dir)
        .map_err(|e| format!("Failed to create starter workspace: {e}"))?;

    Ok(WorkspaceInfo {
        id: stable_workspace_id(starter_dir.to_string_lossy().as_ref()),
        name: "Starter".to_string(),
        path: starter_dir.to_string_lossy().to_string(),
        preset: "starter".to_string(),
        workspace_type: WorkspaceType::Local,
        base_url: None,
        directory: None,
        display_name: None,
    })
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
