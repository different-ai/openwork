use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::engine::doctor::{resolve_engine_path, MIN_SAFE_ENGINE_VERSION};
use crate::paths::home_dir;
use crate::platform::command_for_program;
use crate::types::{ExecResult, WorkspaceOpenworkConfig};
use crate::workspace::state::load_workspace_state;
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
pub struct CacheResetResult {
  pub removed: Vec<String>,
  pub missing: Vec<String>,
  pub errors: Vec<String>,
}

fn opencode_cache_candidates() -> Vec<PathBuf> {
  let mut candidates: Vec<PathBuf> = Vec::new();

  if let Ok(value) = std::env::var("XDG_CACHE_HOME") {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
      candidates.push(PathBuf::from(trimmed).join("opencode"));
    }
  }

  if let Some(home) = home_dir() {
    candidates.push(home.join(".cache").join("opencode"));

    #[cfg(target_os = "macos")]
    {
      candidates.push(home.join("Library").join("Caches").join("opencode"));
    }
  }

  #[cfg(windows)]
  {
    if let Ok(value) = std::env::var("LOCALAPPDATA") {
      let trimmed = value.trim();
      if !trimmed.is_empty() {
        candidates.push(PathBuf::from(trimmed).join("opencode"));
      }
    }
    if let Ok(value) = std::env::var("APPDATA") {
      let trimmed = value.trim();
      if !trimmed.is_empty() {
        candidates.push(PathBuf::from(trimmed).join("opencode"));
      }
    }
  }

  let mut seen = HashSet::new();
  candidates
    .into_iter()
    .filter(|path| seen.insert(path.to_string_lossy().to_string()))
    .collect()
}

fn validate_server_name(name: &str) -> Result<String, String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("server_name is required".to_string());
  }

  if trimmed.starts_with('-') {
    return Err("server_name must not start with '-'".to_string());
  }

  if !trimmed
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
  {
    return Err("server_name must be alphanumeric with '-' or '_'".to_string());
  }

  Ok(trimmed.to_string())
}

fn read_workspace_openwork_config(workspace_path: &Path) -> Result<WorkspaceOpenworkConfig, String> {
  let openwork_path = workspace_path.join(".opencode").join("openwork.json");
  if !openwork_path.exists() {
    let mut cfg = WorkspaceOpenworkConfig::default();
    let workspace_value = workspace_path.to_string_lossy().to_string();
    if !workspace_value.trim().is_empty() {
      cfg.authorized_roots.push(workspace_value);
    }
    return Ok(cfg);
  }

  let raw = fs::read_to_string(&openwork_path)
    .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

  serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
    .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

fn load_authorized_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
  let state = load_workspace_state(app)?;
  let mut roots = Vec::new();

  for workspace in state.workspaces {
    let workspace_path = PathBuf::from(&workspace.path);
    let mut config = read_workspace_openwork_config(&workspace_path)?;

    if config.authorized_roots.is_empty() {
      config.authorized_roots.push(workspace.path.clone());
    }

    for root in config.authorized_roots {
      let trimmed = root.trim();
      if !trimmed.is_empty() {
        roots.push(PathBuf::from(trimmed));
      }
    }
  }

  if roots.is_empty() {
    return Err("No authorized roots configured".to_string());
  }

  Ok(roots)
}

fn validate_project_dir(app: &AppHandle, project_dir: &str) -> Result<PathBuf, String> {
  let trimmed = project_dir.trim();
  if trimmed.is_empty() {
    return Err("project_dir is required".to_string());
  }

  let project_path = PathBuf::from(trimmed);
  if !project_path.is_absolute() {
    return Err("project_dir must be an absolute path".to_string());
  }

  let canonical = fs::canonicalize(&project_path)
    .map_err(|e| format!("Failed to resolve project_dir: {e}"))?;

  if !canonical.is_dir() {
    return Err("project_dir must be a directory".to_string());
  }

  let roots = load_authorized_roots(app)?;
  let mut allowed = false;
  for root in roots {
    let Ok(root) = fs::canonicalize(&root) else {
      continue;
    };
    if canonical.starts_with(&root) {
      allowed = true;
      break;
    }
  }

  if !allowed {
    return Err("project_dir is not within an authorized root".to_string());
  }

  Ok(canonical)
}

#[tauri::command]
pub fn reset_opencode_cache() -> Result<CacheResetResult, String> {
  let candidates = opencode_cache_candidates();
  let mut removed = Vec::new();
  let mut missing = Vec::new();
  let mut errors = Vec::new();

  for path in candidates {
    if path.exists() {
      if let Err(err) = std::fs::remove_dir_all(&path) {
        errors.push(format!("Failed to remove {}: {err}", path.display()));
      } else {
        removed.push(path.to_string_lossy().to_string());
      }
    } else {
      missing.push(path.to_string_lossy().to_string());
    }
  }

  Ok(CacheResetResult {
    removed,
    missing,
    errors,
  })
}

#[tauri::command]
pub fn reset_openwork_state(app: tauri::AppHandle, mode: String) -> Result<(), String> {
  let mode = mode.trim();
  if mode != "onboarding" && mode != "all" {
    return Err("mode must be 'onboarding' or 'all'".to_string());
  }

  let cache_dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?;

  if cache_dir.exists() {
    std::fs::remove_dir_all(&cache_dir)
      .map_err(|e| format!("Failed to remove cache dir {}: {e}", cache_dir.display()))?;
  }

  if mode == "all" {
    let data_dir = app
      .path()
      .app_data_dir()
      .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    if data_dir.exists() {
      std::fs::remove_dir_all(&data_dir)
        .map_err(|e| format!("Failed to remove data dir {}: {e}", data_dir.display()))?;
    }
  }

  Ok(())
}

/// Run `opencode mcp auth <server_name>` in the given project directory.
/// This spawns the process detached so the OAuth flow can open a browser.
#[tauri::command]
pub fn opencode_mcp_auth(
  app: AppHandle,
  project_dir: String,
  server_name: String,
) -> Result<ExecResult, String> {
  let project_dir = validate_project_dir(&app, &project_dir)?;
  let server_name = validate_server_name(&server_name)?;

  let resource_dir = app.path().resource_dir().ok();
  let current_bin_dir = tauri::process::current_binary(&app.env())
    .ok()
    .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
  let (program, _in_path, notes) =
    resolve_engine_path(true, resource_dir.as_deref(), current_bin_dir.as_deref());
  let Some(program) = program else {
    let notes_text = notes.join("\n");
    return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- Or follow the instructions at https://opencode.ai/install\n\nNotes:\n{notes_text}"
    ));
  };

  let output = command_for_program(&program)
    .arg("mcp")
    .arg("auth")
    .arg(server_name)
    .current_dir(&project_dir)
    .output()
    .map_err(|e| format!("Failed to run opencode mcp auth: {e}"))?;

  let status = output.status.code().unwrap_or(-1);
  Ok(ExecResult {
    ok: output.status.success(),
    status,
    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
  })
}
