use std::path::PathBuf;

use crate::paths::{home_dir, resolve_in_path};

#[cfg(windows)]
const OPENCODE_EXECUTABLE: &str = "opencode.exe";

#[cfg(windows)]
const OPENCODE_CMD: &str = "opencode.cmd";

#[cfg(not(windows))]
const OPENCODE_EXECUTABLE: &str = "opencode";

pub fn opencode_executable_name() -> &'static str {
  OPENCODE_EXECUTABLE
}

pub fn opencode_cmd_name() -> Option<&'static str> {
  #[cfg(windows)]
  {
    Some(OPENCODE_CMD)
  }
  #[cfg(not(windows))]
  {
    None
  }
}

pub fn candidate_opencode_paths() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  if let Some(home) = home_dir() {
    candidates.push(home.join(".opencode").join("bin").join(OPENCODE_EXECUTABLE));
  }

  #[cfg(windows)]
  {
    if let Some(app_data) = std::env::var_os("APPDATA") {
      let base = PathBuf::from(app_data).join("npm");
      candidates.push(base.join(OPENCODE_EXECUTABLE));
      candidates.push(base.join(OPENCODE_CMD));
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
      let npm = PathBuf::from(local_app_data).join("npm");
      candidates.push(npm.join(OPENCODE_EXECUTABLE));
      candidates.push(npm.join(OPENCODE_CMD));
      candidates.push(PathBuf::from(local_app_data).join("OpenCode").join(OPENCODE_EXECUTABLE));
    }

    if let Some(home) = home_dir() {
      let scoop = home.join("scoop").join("shims");
      candidates.push(scoop.join(OPENCODE_EXECUTABLE));
      candidates.push(scoop.join(OPENCODE_CMD));
    }

    candidates.push(PathBuf::from("C:\\ProgramData\\chocolatey\\bin").join(OPENCODE_EXECUTABLE));
    candidates.push(PathBuf::from("C:\\ProgramData\\chocolatey\\bin").join(OPENCODE_CMD));
  }

  #[cfg(not(windows))]
  {
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(OPENCODE_EXECUTABLE));
    candidates.push(PathBuf::from("/usr/local/bin").join(OPENCODE_EXECUTABLE));
    candidates.push(PathBuf::from("/usr/bin").join(OPENCODE_EXECUTABLE));
    candidates.push(PathBuf::from("/usr/local/bin").join(OPENCODE_EXECUTABLE));
  }

  candidates
}

pub fn resolve_opencode_executable() -> (Option<PathBuf>, bool, Vec<String>) {
  let mut notes = Vec::new();

  if let Ok(custom) = std::env::var("OPENCODE_BIN_PATH") {
    let custom = custom.trim();
    if !custom.is_empty() {
      let candidate = PathBuf::from(custom);
      if candidate.is_file() {
        notes.push(format!("Using OPENCODE_BIN_PATH: {}", candidate.display()));
        return (Some(candidate), false, notes);
      }
      notes.push(format!("OPENCODE_BIN_PATH set but missing: {}", candidate.display()));
    }
  }

  if let Some(path) = resolve_in_path(OPENCODE_EXECUTABLE) {
    notes.push(format!("Found in PATH: {}", path.display()));
    return (Some(path), true, notes);
  }

  #[cfg(windows)]
  {
    if let Some(path) = resolve_in_path(OPENCODE_CMD) {
      notes.push(format!("Found in PATH: {}", path.display()));
      return (Some(path), true, notes);
    }
  }

  notes.push("Not found on PATH".to_string());

  for candidate in candidate_opencode_paths() {
    if candidate.is_file() {
      notes.push(format!("Found at {}", candidate.display()));
      return (Some(candidate), false, notes);
    }

    notes.push(format!("Missing: {}", candidate.display()));
  }

  (None, false, notes)
}
