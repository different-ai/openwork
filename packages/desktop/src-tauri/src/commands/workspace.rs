use std::fs;
use std::path::PathBuf;

use crate::types::{ExecResult, WorkspaceList, WorkspaceOpenworkConfig, WorkspaceTemplate};
use crate::workspace::files::ensure_workspace_files;
use crate::workspace::state::{ensure_starter_workspace, load_workspace_state, save_workspace_state, stable_workspace_id};
use crate::workspace::templates::{delete_template, write_template};

#[tauri::command]
pub fn workspace_bootstrap(app: tauri::AppHandle) -> Result<WorkspaceList, String> {
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
pub fn workspace_set_active(app: tauri::AppHandle, workspace_id: String) -> Result<WorkspaceList, String> {
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
  let folder = folder_path.trim().to_string();
  if folder.is_empty() {
    return Err("folderPath is required".to_string());
  }

  let workspace_name = name.trim().to_string();
  if workspace_name.is_empty() {
    return Err("name is required".to_string());
  }

  let preset = preset.trim().to_string();
  let preset = if preset.is_empty() { "starter".to_string() } else { preset };

  fs::create_dir_all(&folder)
    .map_err(|e| format!("Failed to create workspace folder: {e}"))?;

  let id = stable_workspace_id(&folder);

  ensure_workspace_files(&folder, &preset)?;

  let mut state = load_workspace_state(&app)?;

  state.workspaces.retain(|w| w.id != id);
  state.workspaces.push(crate::types::WorkspaceInfo {
    id: id.clone(),
    name: workspace_name,
    path: folder,
    preset,
  });

  state.active_id = id;
  save_workspace_state(&app, &state)?;

  Ok(WorkspaceList {
    active_id: state.active_id,
    workspaces: state.workspaces,
  })
}

#[tauri::command]
pub fn workspace_remove(app: tauri::AppHandle, workspace_id: String) -> Result<WorkspaceList, String> {
  let mut state = load_workspace_state(&app)?;
  let id = workspace_id.trim();

  if id.is_empty() {
    return Err("workspaceId is required".to_string());
  }

  let starter = ensure_starter_workspace(&app)?;
  if id == starter.id {
    return Err("Cannot remove starter workspace".to_string());
  }

  if !state.workspaces.iter().any(|w| w.id == id) {
    return Err("Unknown workspaceId".to_string());
  }

  state.workspaces.retain(|w| w.id != id);

  if !state.workspaces.iter().any(|w| w.id == starter.id) {
    state.workspaces.push(starter.clone());
  }

  if state.active_id == id {
    state.active_id = starter.id.clone();
  }

  save_workspace_state(&app, &state)?;

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
pub fn workspace_template_write(
  _app: tauri::AppHandle,
  workspace_path: String,
  template: WorkspaceTemplate,
) -> Result<ExecResult, String> {
  let workspace_path = workspace_path.trim().to_string();
  if workspace_path.is_empty() {
    return Err("workspacePath is required".to_string());
  }

  let file_path = write_template(&workspace_path, template)?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Wrote {}", file_path.display()),
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

  serde_json::from_str::<WorkspaceOpenworkConfig>(&raw).map_err(|e| {
    format!("Failed to parse {}: {e}", openwork_path.display())
  })
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

#[tauri::command]
pub fn workspace_template_delete(
  _app: tauri::AppHandle,
  workspace_path: String,
  template_id: String,
) -> Result<ExecResult, String> {
  let workspace_path = workspace_path.trim().to_string();
  if workspace_path.is_empty() {
    return Err("workspacePath is required".to_string());
  }

  let file_path = delete_template(&workspace_path, &template_id)?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Deleted {}", file_path.display()),
    stderr: String::new(),
  })
}
