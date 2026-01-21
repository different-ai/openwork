use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::fs::copy_dir_recursive;
use crate::platform::configure_hidden;
use crate::types::ExecResult;
use crate::utils::now_ms;

fn resolve_skill_root(project_dir: &str) -> Result<PathBuf, String> {
  let base = PathBuf::from(project_dir).join(".opencode");
  let plural = base.join("skills");
  let singular = base.join("skill");
  let root = if plural.exists() { plural } else { singular };
  fs::create_dir_all(&root)
    .map_err(|e| format!("Failed to create {}: {e}", root.display()))?;
  Ok(root)
}

fn validate_skill_name(name: &str) -> Result<String, String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("skill name is required".to_string());
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

fn run_command(command: &mut Command, not_found: &str) -> Result<ExecResult, String> {
  match command.output() {
    Ok(output) => Ok(ExecResult {
      ok: output.status.success(),
      status: output.status.code().unwrap_or(-1),
      stdout: String::from_utf8_lossy(&output.stdout).to_string(),
      stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ExecResult {
      ok: false,
      status: -1,
      stdout: String::new(),
      stderr: not_found.to_string(),
    }),
    Err(e) => Err(format!(
      "Failed to run {}: {e}",
      command.get_program().to_string_lossy()
    )),
  }
}

fn create_temp_dir(prefix: &str) -> PathBuf {
  let mut dir = std::env::temp_dir();
  dir.push(format!("openwork-{}-{}", prefix, now_ms()));
  dir
}

struct RepoSource {
  repo_url: String,
  branch: Option<String>,
  subdir: Option<PathBuf>,
}

fn parse_repo_source(source: &str) -> RepoSource {
  let trimmed = source.trim().trim_end_matches('/');
  if let Some(parsed) = parse_github_tree_url(trimmed) {
    return parsed;
  }

  RepoSource {
    repo_url: trimmed.to_string(),
    branch: None,
    subdir: None,
  }
}

fn parse_github_tree_url(source: &str) -> Option<RepoSource> {
  let prefix = "https://github.com/";
  if !source.starts_with(prefix) {
    return None;
  }

  let remainder = &source[prefix.len()..];
  let parts: Vec<&str> = remainder.split('/').collect();
  if parts.len() < 4 {
    return None;
  }

  let owner = parts[0];
  let repo = parts[1];
  let marker = parts[2];
  if marker != "tree" && marker != "blob" {
    return None;
  }

  let branch = parts[3].to_string();
  let subdir = if parts.len() > 4 {
    Some(PathBuf::from(parts[4..].join("/")))
  } else {
    None
  };

  Some(RepoSource {
    repo_url: format!("https://github.com/{owner}/{repo}.git"),
    branch: Some(branch),
    subdir,
  })
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

fn discover_skills(repo_root: &Path, start_dir: &Path) -> Result<Vec<PathBuf>, String> {
  if !start_dir.exists() {
    return Err(format!("Path not found in repo: {}", start_dir.display()));
  }

  if !start_dir.starts_with(repo_root) {
    return Err("Start path is outside repo root".to_string());
  }

  let mut current = start_dir.to_path_buf();
  let mut out = Vec::new();
  let mut seen = HashSet::new();

  loop {
    let candidates = [
      current.join(".opencode").join("skills"),
      current.join(".opencode").join("skill"),
      current.join(".claude").join("skills"),
      current.join(".claude").join("skill"),
    ];

    for candidate in candidates {
      gather_skills(&candidate, &mut seen, &mut out)?;
    }

    if current == repo_root {
      break;
    }

    match current.parent() {
      Some(parent) => current = parent.to_path_buf(),
      None => break,
    }
  }

  Ok(out)
}

fn cleanup_temp_dir(path: &Path) {
  let _ = fs::remove_dir_all(path);
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
  let skill_root = resolve_skill_root(project_dir)?;
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
pub fn import_skills_from_repo(project_dir: String, repo: String) -> Result<ExecResult, String> {
  let project_dir = project_dir.trim();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let repo = repo.trim();
  if repo.is_empty() {
    return Err("repo is required".to_string());
  }

  let repo_source = parse_repo_source(repo);
  let temp_dir = create_temp_dir("skills");
  let repo_dir = temp_dir.join("repo");

  fs::create_dir_all(&temp_dir)
    .map_err(|e| format!("Failed to create temp dir {}: {e}", temp_dir.display()))?;

  let mut git = Command::new("git");
  configure_hidden(&mut git);
  git.arg("clone").arg("--depth").arg("1");
  if let Some(branch) = &repo_source.branch {
    git.arg("--branch").arg(branch);
  }
  git.arg(&repo_source.repo_url).arg(&repo_dir);

  let clone_result = run_command(&mut git, "Git CLI not found. Install git to import skills.")?;
  if !clone_result.ok {
    cleanup_temp_dir(&temp_dir);
    return Ok(clone_result);
  }

  let start_dir = match repo_source.subdir {
    Some(subdir) => repo_dir.join(subdir),
    None => repo_dir.clone(),
  };

  let skills = match discover_skills(&repo_dir, &start_dir) {
    Ok(found) => found,
    Err(message) => {
      cleanup_temp_dir(&temp_dir);
      return Ok(ExecResult {
        ok: false,
        status: 1,
        stdout: String::new(),
        stderr: message,
      });
    }
  };

  if skills.is_empty() {
    cleanup_temp_dir(&temp_dir);
    return Ok(ExecResult {
      ok: false,
      status: 1,
      stdout: String::new(),
      stderr: "No skills found in repo.".to_string(),
    });
  }

  let skill_root = resolve_skill_root(project_dir)?;
  let mut imported = 0;
  let mut skipped = 0;

  for skill_dir in skills {
    let Some(name) = skill_dir.file_name().and_then(|s| s.to_str()) else {
      continue;
    };

    let dest = skill_root.join(name);
    if dest.exists() {
      skipped += 1;
      continue;
    }

    copy_dir_recursive(&skill_dir, &dest)?;
    imported += 1;
  }

  cleanup_temp_dir(&temp_dir);

  let summary = if imported == 0 {
    format!("No new skills imported ({} already installed).", skipped)
  } else if skipped > 0 {
    format!("Imported {} skill(s); skipped {} existing.", imported, skipped)
  } else {
    format!("Imported {} skill(s).", imported)
  };

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: summary,
    stderr: String::new(),
  })
}
