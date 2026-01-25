use std::fs;
use std::path::PathBuf;

use crate::types::{ExecResult, WorkspaceInfo, WorkspaceList, WorkspaceOpenworkConfig, WorkspaceType};
use crate::workspace::files::ensure_workspace_files;
use crate::workspace::state::{
    ensure_starter_workspace, load_workspace_state, save_workspace_state, stable_workspace_id,
    stable_workspace_id_for_remote,
};

#[tauri::command]
pub fn workspace_bootstrap(app: tauri::AppHandle) -> Result<WorkspaceList, String> {
    println!("[workspace] bootstrap");
    let mut state = load_workspace_state(&app)?;

    let starter = ensure_starter_workspace(&app)?;
    ensure_workspace_files(&starter.path, &starter.preset)?;

    if !state.workspaces.iter().any(|w| w.id == starter.id) {
        state.workspaces.push(starter.clone());
    }

    if state.active_id.trim().is_empty() {
        state.active_id = starter.id.clone();
    }

    if !state.workspaces.iter().any(|w| w.id == state.active_id) {
        state.active_id = starter.id.clone();
    }

    save_workspace_state(&app, &state)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_forget(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<WorkspaceList, String> {
    println!("[workspace] forget request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let before = state.workspaces.len();
    state.workspaces.retain(|w| w.id != id);
    if before == state.workspaces.len() {
        return Err("Unknown workspaceId".to_string());
    }

    if state.active_id == id {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| "".to_string());
    }

    if state.workspaces.is_empty() {
        let starter = ensure_starter_workspace(&app)?;
        ensure_workspace_files(&starter.path, &starter.preset)?;
        state.active_id = starter.id.clone();
        state.workspaces.push(starter);
    }

    save_workspace_state(&app, &state)?;
    println!("[workspace] forget complete");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_set_active(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<WorkspaceList, String> {
    println!("[workspace] set_active request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    if !state.workspaces.iter().any(|w| w.id == id) {
        return Err("Unknown workspaceId".to_string());
    }

    state.active_id = id.to_string();
    save_workspace_state(&app, &state)?;
    println!("[workspace] set_active complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_create(
    app: tauri::AppHandle,
    folder_path: String,
    name: String,
    preset: String,
) -> Result<WorkspaceList, String> {
    println!("[workspace] create local request");
    let folder = folder_path.trim().to_string();
    if folder.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let workspace_name = name.trim().to_string();
    if workspace_name.is_empty() {
        return Err("name is required".to_string());
    }

    let preset = preset.trim().to_string();
    let preset = if preset.is_empty() {
        "starter".to_string()
    } else {
        preset
    };

    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create workspace folder: {e}"))?;

    let id = stable_workspace_id(&folder);

    ensure_workspace_files(&folder, &preset)?;

    let mut state = load_workspace_state(&app)?;

    state.workspaces.retain(|w| w.id != id);
    state.workspaces.push(WorkspaceInfo {
        id: id.clone(),
        name: workspace_name,
        path: folder,
        preset,
        workspace_type: WorkspaceType::Local,
        base_url: None,
        directory: None,
        display_name: None,
    });

    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    println!("[workspace] create local complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_create_remote(
    app: tauri::AppHandle,
    base_url: String,
    directory: Option<String>,
    display_name: Option<String>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] create remote request");
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("baseUrl is required".to_string());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl must start with http:// or https://".to_string());
    }

    let directory = directory
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let display_name = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let id = stable_workspace_id_for_remote(&base_url, directory.as_deref());
    let name = display_name.clone().unwrap_or_else(|| base_url.clone());
    let path = directory.clone().unwrap_or_default();

    let mut state = load_workspace_state(&app)?;
    state.workspaces.retain(|w| w.id != id);
    state.workspaces.push(WorkspaceInfo {
        id: id.clone(),
        name,
        path,
        preset: "remote".to_string(),
        workspace_type: WorkspaceType::Remote,
        base_url: Some(base_url),
        directory,
        display_name,
    });
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    println!("[workspace] create remote complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_update_remote(
    app: tauri::AppHandle,
    workspace_id: String,
    base_url: Option<String>,
    directory: Option<String>,
    display_name: Option<String>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] update remote request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();
    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let entry = state.workspaces.iter_mut().find(|w| w.id == id);
    let Some(entry) = entry else {
        return Err("Unknown workspaceId".to_string());
    };

    if entry.workspace_type != WorkspaceType::Remote {
        return Err("workspaceId is not remote".to_string());
    }

    if let Some(next_base_url) = base_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !next_base_url.starts_with("http://") && !next_base_url.starts_with("https://") {
            return Err("baseUrl must start with http:// or https://".to_string());
        }
        entry.base_url = Some(next_base_url);
    }

    let next_directory = directory
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if directory.is_some() {
        entry.directory = next_directory.clone();
        entry.path = next_directory.unwrap_or_default();
    }

    if let Some(next_name) = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.display_name = Some(next_name.clone());
        entry.name = next_name;
    }

    save_workspace_state(&app, &state)?;
    println!("[workspace] update remote complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_add_authorized_root(
    _app: tauri::AppHandle,
    workspace_path: String,
    folder_path: String,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    let folder_path = folder_path.trim().to_string();

    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let openwork_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("openwork.json");

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let mut config: WorkspaceOpenworkConfig = if openwork_path.exists() {
        let raw = fs::read_to_string(&openwork_path)
            .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        let mut cfg = WorkspaceOpenworkConfig::default();
        if !cfg.authorized_roots.iter().any(|p| p == &workspace_path) {
            cfg.authorized_roots.push(workspace_path.clone());
        }
        cfg
    };

    if !config.authorized_roots.iter().any(|p| p == &folder_path) {
        config.authorized_roots.push(folder_path);
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: "Updated authorizedRoots".to_string(),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn workspace_openwork_read(
    _app: tauri::AppHandle,
    workspace_path: String,
) -> Result<WorkspaceOpenworkConfig, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("openwork.json");

    if !openwork_path.exists() {
        let mut cfg = WorkspaceOpenworkConfig::default();
        cfg.authorized_roots.push(workspace_path);
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&openwork_path)
        .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

    serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

#[tauri::command]
pub fn workspace_openwork_write(
    _app: tauri::AppHandle,
    workspace_path: String,
    config: WorkspaceOpenworkConfig,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("openwork.json");

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", openwork_path.display()),
        stderr: String::new(),
    })
}
