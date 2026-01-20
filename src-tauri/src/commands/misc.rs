use tauri::Manager;

use std::collections::HashSet;
use std::path::PathBuf;

use crate::engine::doctor::resolve_engine_path;
use crate::paths::home_dir;
use crate::platform::command_for_program;
use crate::types::ExecResult;
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
  let project_dir = project_dir.trim();
  let server_name = server_name.trim();

  if project_dir.is_empty() {
    return Err("project_dir is required".to_string());
  }
  if server_name.is_empty() {
    return Err("server_name is required".to_string());
  }

  let resource_dir = app.path().resource_dir().ok();
  let (program, _in_path, notes) = resolve_engine_path(true, resource_dir.as_deref());
  let Some(program) = program else {
    let notes_text = notes.join("\n");
    return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
    ));
  };

  let output = command_for_program(&program)
    .arg("mcp")
    .arg("auth")
    .arg(server_name)
    .current_dir(project_dir)
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
