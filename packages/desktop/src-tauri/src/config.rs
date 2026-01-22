use std::env;
use std::fs;
use std::path::PathBuf;

use crate::types::{ExecResult, OpencodeConfigFile};

fn opencode_config_candidates(scope: &str, project_dir: &str) -> Result<(PathBuf, PathBuf), String> {
  match scope {
    "project" => {
      if project_dir.trim().is_empty() {
        return Err("projectDir is required".to_string());
      }
      let root = PathBuf::from(project_dir);
      Ok((root.join("opencode.jsonc"), root.join("opencode.json")))
    }
    "global" => {
      let base = if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
        PathBuf::from(dir)
      } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home).join(".config")
      } else {
        return Err("Unable to resolve config directory".to_string());
      };

      let root = base.join("opencode");
      Ok((root.join("opencode.jsonc"), root.join("opencode.json")))
    }
    _ => Err("scope must be 'project' or 'global'".to_string()),
  }
}

pub fn resolve_opencode_config_path(scope: &str, project_dir: &str) -> Result<PathBuf, String> {
  let (jsonc_path, json_path) = opencode_config_candidates(scope, project_dir)?;

  if jsonc_path.exists() {
    return Ok(jsonc_path);
  }

  if json_path.exists() {
    return Ok(json_path);
  }

  Ok(jsonc_path)
}

pub fn read_opencode_config(scope: &str, project_dir: &str) -> Result<OpencodeConfigFile, String> {
  let path = resolve_opencode_config_path(scope.trim(), project_dir)?;
  let exists = path.exists();

  let content = if exists {
    Some(fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?)
  } else {
    None
  };

  Ok(OpencodeConfigFile {
    path: path.to_string_lossy().to_string(),
    exists,
    content,
  })
}

pub fn write_opencode_config(scope: &str, project_dir: &str, content: &str) -> Result<ExecResult, String> {
  let path = resolve_opencode_config_path(scope.trim(), project_dir)?;

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Failed to create config dir {}: {e}", parent.display()))?;
  }

  fs::write(&path, content)
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Wrote {}", path.display()),
    stderr: String::new(),
  })
}
