use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::paths::home_dir;
use crate::types::{WorkspaceState, WorkspaceType, WORKSPACE_STATE_VERSION};

pub fn stable_workspace_id(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    let hex = format!("{:x}", digest);
    format!("ws_{}", &hex[..12])
}

pub fn normalize_local_workspace_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let expanded = if trimmed == "~" {
        home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = home_dir() {
            let suffix = trimmed[2..].trim_start_matches(['/', '\\']);
            home.join(suffix)
        } else {
            PathBuf::from(trimmed)
        }
    } else {
        PathBuf::from(trimmed)
    };

    let normalized = fs::canonicalize(&expanded).unwrap_or(expanded);
    normalized.to_string_lossy().to_string()
}

pub fn normalize_local_workspace_path_fast(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let expanded = if trimmed == "~" {
        home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = home_dir() {
            let suffix = trimmed[2..].trim_start_matches(['/', '\\']);
            home.join(suffix)
        } else {
            PathBuf::from(trimmed)
        }
    } else {
        PathBuf::from(trimmed)
    };

    expanded.to_string_lossy().to_string()
}

pub fn openwork_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let file_path = data_dir.join("openwork-workspaces.json");
    Ok((data_dir, file_path))
}

pub fn repair_workspace_state(state: &mut WorkspaceState) {
    let mut changed_ids = false;
    let old_selected_workspace_id = state.selected_workspace_id.clone();
    let old_watched_workspace_id = state.watched_workspace_id.clone();
    for workspace in state.workspaces.iter_mut() {
        let next_id = match workspace.workspace_type {
            WorkspaceType::Local => {
                // Canonicalize only currently selected/watched entries. Full canonicalization across
                // every workspace can block startup/switch paths when mounts are slow.
                let canonicalize_for_active_workspace =
                    workspace.id == old_selected_workspace_id
                        || workspace.id == old_watched_workspace_id;
                let normalized = if canonicalize_for_active_workspace {
                    normalize_local_workspace_path(&workspace.path)
                } else {
                    normalize_local_workspace_path_fast(&workspace.path)
                };
                if !normalized.is_empty() {
                    workspace.path = normalized;
                }
                stable_workspace_id(&workspace.path)
            }
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
            if old_selected_workspace_id == workspace.id {
                state.selected_workspace_id = next_id.clone();
            }
            if old_watched_workspace_id == workspace.id {
                state.watched_workspace_id = next_id.clone();
            }
            workspace.id = next_id;
            changed_ids = true;
        }
    }

    if state.version < WORKSPACE_STATE_VERSION {
        state.version = WORKSPACE_STATE_VERSION;
    }

    if changed_ids && state.selected_workspace_id.is_empty() {
        state.selected_workspace_id = state
            .workspaces
            .first()
            .map(|workspace| workspace.id.clone())
            .unwrap_or_default();
    }

    if !state.watched_workspace_id.is_empty()
        && !state
            .workspaces
            .iter()
            .any(|workspace| workspace.id == state.watched_workspace_id)
    {
        state.watched_workspace_id.clear();
    }

    if state.watched_workspace_id.is_empty() {
        state.watched_workspace_id = state.selected_workspace_id.clone();
    }
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
    repair_workspace_state(&mut state);

    Ok(state)
}

pub fn load_workspace_state_fast(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (_, path) = openwork_state_paths(app)?;
    if !path.exists() {
        return Ok(WorkspaceState::default());
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
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

#[cfg(test)]
mod tests {
    use super::{normalize_local_workspace_path, repair_workspace_state, stable_workspace_id};
    use crate::types::{WorkspaceInfo, WorkspaceState, WorkspaceType};
    use std::fs;

    #[test]
    fn normalize_local_workspace_path_expands_home_prefix() {
        let home = crate::paths::home_dir().expect("home dir");
        let expected = home.join("OpenWork").join("openwork-state-test-expand");
        let actual = normalize_local_workspace_path("~/OpenWork/openwork-state-test-expand");
        assert_eq!(actual, expected.to_string_lossy());
    }

    #[test]
    fn normalize_local_workspace_path_keeps_canonical_id_stable() {
        let temp = std::env::temp_dir().join(format!(
            "openwork-workspace-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let nested = temp.join("starter");
        fs::create_dir_all(&nested).expect("create temp workspace");

        let raw = format!("{}/../starter", nested.display());
        let normalized = normalize_local_workspace_path(&raw);

        let canonical = fs::canonicalize(&nested).expect("canonical starter workspace");
        assert_eq!(normalized, canonical.to_string_lossy());
        assert_eq!(
            stable_workspace_id(&normalized),
            stable_workspace_id(&canonical.to_string_lossy())
        );

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn repair_workspace_state_preserves_selected_and_watched_ids_independently() {
        let temp = std::env::temp_dir().join(format!(
            "openwork-workspace-state-selected-watched-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let first = temp.join("first");
        let second = temp.join("second");
        fs::create_dir_all(&first).expect("create first workspace");
        fs::create_dir_all(&second).expect("create second workspace");

        let mut state = WorkspaceState {
            version: 1,
            selected_workspace_id: "selected-legacy".to_string(),
            watched_workspace_id: "watched-legacy".to_string(),
            workspaces: vec![
                WorkspaceInfo {
                    id: "selected-legacy".to_string(),
                    name: "First".to_string(),
                    path: first.to_string_lossy().to_string(),
                    preset: "starter".to_string(),
                    workspace_type: WorkspaceType::Local,
                    remote_type: None,
                    base_url: None,
                    directory: None,
                    display_name: None,
                    openwork_host_url: None,
                    openwork_token: None,
                    openwork_client_token: None,
                    openwork_host_token: None,
                    openwork_workspace_id: None,
                    openwork_workspace_name: None,
                    sandbox_backend: None,
                    sandbox_run_id: None,
                    sandbox_container_name: None,
                },
                WorkspaceInfo {
                    id: "watched-legacy".to_string(),
                    name: "Second".to_string(),
                    path: second.to_string_lossy().to_string(),
                    preset: "starter".to_string(),
                    workspace_type: WorkspaceType::Local,
                    remote_type: None,
                    base_url: None,
                    directory: None,
                    display_name: None,
                    openwork_host_url: None,
                    openwork_token: None,
                    openwork_client_token: None,
                    openwork_host_token: None,
                    openwork_workspace_id: None,
                    openwork_workspace_name: None,
                    sandbox_backend: None,
                    sandbox_run_id: None,
                    sandbox_container_name: None,
                },
            ],
        };

        repair_workspace_state(&mut state);

        assert_ne!(state.selected_workspace_id, state.watched_workspace_id);
        assert_eq!(state.selected_workspace_id, state.workspaces[0].id);
        assert_eq!(state.watched_workspace_id, state.workspaces[1].id);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn repair_workspace_state_defaults_watched_id_to_selected_when_missing() {
        let temp = std::env::temp_dir().join(format!(
            "openwork-workspace-state-default-watch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let first = temp.join("first");
        fs::create_dir_all(&first).expect("create workspace");

        let mut state = WorkspaceState {
            version: 1,
            selected_workspace_id: "selected-legacy".to_string(),
            watched_workspace_id: "missing-legacy".to_string(),
            workspaces: vec![WorkspaceInfo {
                id: "selected-legacy".to_string(),
                name: "First".to_string(),
                path: first.to_string_lossy().to_string(),
                preset: "starter".to_string(),
                workspace_type: WorkspaceType::Local,
                remote_type: None,
                base_url: None,
                directory: None,
                display_name: None,
                openwork_host_url: None,
                openwork_token: None,
                openwork_client_token: None,
                openwork_host_token: None,
                openwork_workspace_id: None,
                openwork_workspace_name: None,
                sandbox_backend: None,
                sandbox_run_id: None,
                sandbox_container_name: None,
            }],
        };

        repair_workspace_state(&mut state);

        assert_eq!(state.watched_workspace_id, state.selected_workspace_id);

        let _ = fs::remove_dir_all(&temp);
    }
}
