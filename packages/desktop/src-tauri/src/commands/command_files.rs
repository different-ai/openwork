use std::env;
use std::fs;
use std::path::PathBuf;

use crate::types::{ExecResult, OpencodeCommand};
use crate::workspace::commands::{sanitize_command_name, serialize_command_frontmatter};

fn resolve_commands_dir(scope: &str, project_dir: &str) -> Result<PathBuf, String> {
    match scope {
        "workspace" => {
            if project_dir.trim().is_empty() {
                return Err("projectDir is required".to_string());
            }
            Ok(PathBuf::from(project_dir).join(".opencode").join("commands"))
        }
        "global" => {
            let base = if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
                PathBuf::from(dir)
            } else if let Ok(home) = env::var("HOME") {
                PathBuf::from(home).join(".config")
            } else {
                return Err("Unable to resolve config directory".to_string());
            };
            Ok(base.join("opencode").join("commands"))
        }
        _ => Err("scope must be 'workspace' or 'global'".to_string()),
    }
}

fn list_command_names(dir: &PathBuf) -> Result<Vec<String>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            names.push(stem.to_string());
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn opencode_command_list(scope: String, project_dir: String) -> Result<Vec<String>, String> {
    let dir = resolve_commands_dir(scope.trim(), project_dir.trim())?;
    list_command_names(&dir)
}

#[tauri::command]
pub fn opencode_command_write(
    scope: String,
    project_dir: String,
    command: OpencodeCommand,
) -> Result<ExecResult, String> {
    let scope = scope.trim();
    let safe_name = sanitize_command_name(&command.name)
        .ok_or_else(|| "command.name is required".to_string())?;

    let dir = resolve_commands_dir(scope, project_dir.trim())?;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let payload = OpencodeCommand {
        name: safe_name.clone(),
        ..command
    };
    let file_path = dir.join(format!("{safe_name}.md"));
    let serialized = serialize_command_frontmatter(&payload)?;
    fs::write(&file_path, serialized)
        .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", file_path.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn opencode_command_delete(
    scope: String,
    project_dir: String,
    name: String,
) -> Result<ExecResult, String> {
    let scope = scope.trim();
    let safe_name = sanitize_command_name(&name).ok_or_else(|| "name is required".to_string())?;
    let dir = resolve_commands_dir(scope, project_dir.trim())?;
    let file_path = dir.join(format!("{safe_name}.md"));

    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete {}: {e}", file_path.display()))?;
    }

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Deleted {}", file_path.display()),
        stderr: String::new(),
    })
}
