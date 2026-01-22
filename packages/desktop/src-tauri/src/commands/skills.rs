use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{candidate_xdg_config_dirs, home_dir};
use crate::types::ExecResult;

fn ensure_project_skill_root(project_dir: &str) -> Result<PathBuf, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let base = PathBuf::from(project_dir).join(".opencode");
  let legacy = base.join("skill");
  let modern = base.join("skills");

  if legacy.is_dir() && !modern.exists() {
    fs::rename(&legacy, &modern)
      .map_err(|e| format!("Failed to move {} -> {}: {e}", legacy.display(), modern.display()))?;
  }

  fs::create_dir_all(&modern)
    .map_err(|e| format!("Failed to create {}: {e}", modern.display()))?;
  Ok(modern)
}

fn collect_project_skill_roots(project_dir: &Path) -> Vec<PathBuf> {
  let mut roots = Vec::new();
  let mut current = Some(project_dir);

  while let Some(dir) = current {
    let opencode_root = dir.join(".opencode").join("skills");
    if opencode_root.is_dir() {
      roots.push(opencode_root);
    } else {
      let legacy_root = dir.join(".opencode").join("skill");
      if legacy_root.is_dir() {
        roots.push(legacy_root);
      }
    }

    let claude_root = dir.join(".claude").join("skills");
    if claude_root.is_dir() {
      roots.push(claude_root);
    }

    if dir.join(".git").exists() {
      break;
    }

    current = dir.parent();
  }

  roots
}

fn collect_global_skill_roots() -> Vec<PathBuf> {
  let mut roots = Vec::new();
  for dir in candidate_xdg_config_dirs() {
    let opencode_root = dir.join("opencode").join("skills");
    if opencode_root.is_dir() {
      roots.push(opencode_root);
    }
  }

  if let Some(home) = home_dir() {
    let claude_root = home.join(".claude").join("skills");
    if claude_root.is_dir() {
      roots.push(claude_root);
    }
  }

  roots
}

fn collect_skill_roots(project_dir: &str) -> Result<Vec<PathBuf>, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let mut roots = Vec::new();
  let project_path = PathBuf::from(project_dir);
  roots.extend(collect_project_skill_roots(&project_path));
  roots.extend(collect_global_skill_roots());

  let mut seen = HashSet::new();
  let mut unique = Vec::new();
  for root in roots {
    let key = root.to_string_lossy().to_string();
    if seen.insert(key) {
      unique.push(root);
    }
  }

  Ok(unique)
}

fn validate_skill_name(name: &str) -> Result<String, String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("skill name is required".to_string());
  }

  if trimmed.len() > 100 {
    return Err("skill name must be 1-100 characters".to_string());
  }

  if !trimmed
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
  {
    return Err("skill name must be kebab-case".to_string());
  }

  if trimmed.starts_with('-') || trimmed.ends_with('-') || trimmed.contains("--") {
    return Err("skill name must be kebab-case".to_string());
  }

  Ok(trimmed.to_string())
}

fn gather_skills(root: &Path, seen: &mut HashSet<String>, out: &mut Vec<PathBuf>) -> Result<(), String> {
  if !root.is_dir() {
    return Ok(());
  }

  for entry in fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))? {
    let entry = entry.map_err(|e| e.to_string())?;
    let file_type = entry.file_type().map_err(|e| e.to_string())?;
    if !file_type.is_dir() {
      continue;
    }

    let path = entry.path();
    if !path.join("SKILL.md").is_file() {
      continue;
    }

    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
      continue;
    };

    if seen.insert(name.to_string()) {
      out.push(path);
    }
  }

  Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillCard {
  pub name: String,
  pub path: String,
  pub description: Option<String>,
}

fn extract_description(raw: &str) -> Option<String> {
  // Keep this lightweight: take the first non-empty line that isn't a header or frontmatter marker.
  let mut in_frontmatter = false;

  for line in raw.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if trimmed == "---" {
      in_frontmatter = !in_frontmatter;
      continue;
    }
    if in_frontmatter {
      continue;
    }
    if trimmed.starts_with('#') {
      continue;
    }

    let cleaned = trimmed.replace('`', "");
    if cleaned.is_empty() {
      continue;
    }

    let max = 180;
    if cleaned.len() > max {
      return Some(format!("{}...", &cleaned[..max]));
    }
    return Some(cleaned);
  }

  None
}

#[tauri::command]
pub fn list_local_skills(project_dir: String) -> Result<Vec<LocalSkillCard>, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let skill_roots = collect_skill_roots(project_dir)?;
  let mut found: Vec<PathBuf> = Vec::new();
  let mut seen = HashSet::new();
  for root in skill_roots {
    gather_skills(&root, &mut seen, &mut found)?;
  }

  let mut out = Vec::new();
  for path in found {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
      continue;
    };

    let description = match fs::read_to_string(path.join("SKILL.md")) {
      Ok(raw) => extract_description(&raw),
      Err(_) => None,
    };

    out.push(LocalSkillCard {
      name: name.to_string(),
      path: path.to_string_lossy().to_string(),
      description,
    });
  }

  out.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(out)
}

#[tauri::command]
pub fn install_skill_template(
  project_dir: String,
  name: String,
  content: String,
  overwrite: bool,
) -> Result<ExecResult, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let name = validate_skill_name(&name)?;
  let skill_root = ensure_project_skill_root(project_dir)?;
  let dest = skill_root.join(&name);

  if dest.exists() {
    if overwrite {
      fs::remove_dir_all(&dest)
        .map_err(|e| format!("Failed to remove existing skill dir {}: {e}", dest.display()))?;
    } else {
      return Ok(ExecResult {
        ok: false,
        status: 1,
        stdout: String::new(),
        stderr: format!("Skill already exists at {}", dest.display()),
      });
    }
  }

  fs::create_dir_all(&dest)
    .map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
  fs::write(dest.join("SKILL.md"), content)
    .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Installed skill to {}", dest.display()),
    stderr: String::new(),
  })
}

#[tauri::command]
pub fn uninstall_skill(project_dir: String, name: String) -> Result<ExecResult, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let name = validate_skill_name(&name)?;
  let skill_roots = collect_skill_roots(project_dir)?;
  let mut removed = false;

  for root in skill_roots {
    let dest = root.join(&name);
    if !dest.exists() {
      continue;
    }

    fs::remove_dir_all(&dest)
      .map_err(|e| format!("Failed to remove {}: {e}", dest.display()))?;
    removed = true;
  }

  if !removed {
    return Ok(ExecResult {
      ok: false,
      status: 1,
      stdout: String::new(),
      stderr: "Skill not found in .opencode/skills or .claude/skills".to_string(),
    });
  }

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Removed skill {}", name),
    stderr: String::new(),
  })
}
