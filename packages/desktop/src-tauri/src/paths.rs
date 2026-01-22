use std::env;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
const MACOS_APP_SUPPORT_DIR: &str = "Library/Application Support";

pub fn home_dir() -> Option<PathBuf> {
  if let Ok(home) = env::var("HOME") {
    if !home.trim().is_empty() {
      return Some(PathBuf::from(home));
    }
  }

  if let Ok(profile) = env::var("USERPROFILE") {
    if !profile.trim().is_empty() {
      return Some(PathBuf::from(profile));
    }
  }

  None
}

pub fn candidate_xdg_data_dirs() -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let Some(home) = home_dir() else {
    return candidates;
  };

  candidates.push(home.join(".local").join("share"));
  candidates.push(home.join(".config"));

  #[cfg(target_os = "macos")]
  {
    candidates.push(home.join(MACOS_APP_SUPPORT_DIR));
  }

  candidates
}

pub fn candidate_xdg_config_dirs() -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let Some(home) = home_dir() else {
    return candidates;
  };

  candidates.push(home.join(".config"));

  #[cfg(target_os = "macos")]
  {
    candidates.push(home.join(MACOS_APP_SUPPORT_DIR));
  }

  candidates
}

pub fn maybe_infer_xdg_home(
  var_name: &str,
  candidates: Vec<PathBuf>,
  relative_marker: &Path,
) -> Option<String> {
  if env::var_os(var_name).is_some() {
    return None;
  }

  for base in candidates {
    if base.join(relative_marker).is_file() {
      return Some(base.to_string_lossy().to_string());
    }
  }

  None
}

pub fn path_entries() -> Vec<PathBuf> {
  let mut entries = Vec::new();
  let Some(path) = env::var_os("PATH") else {
    return entries;
  };

  entries.extend(env::split_paths(&path));
  entries
}

pub fn resolve_in_path(name: &str) -> Option<PathBuf> {
  for dir in path_entries() {
    let candidate = dir.join(name);
    if candidate.is_file() {
      return Some(candidate);
    }
  }
  None
}
