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

pub fn sidecar_path_candidates(
    resource_dir: Option<&Path>,
    current_bin_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(current_bin_dir) = current_bin_dir {
        candidates.push(current_bin_dir.to_path_buf());
    }

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("sidecars"));
        candidates.push(resource_dir.to_path_buf());
    }

    candidates.push(PathBuf::from("src-tauri/sidecars"));

    let mut unique = Vec::new();
    for candidate in candidates {
        if !candidate.is_dir() {
            continue;
        }
        if unique
            .iter()
            .any(|existing: &PathBuf| existing == &candidate)
        {
            continue;
        }
        unique.push(candidate);
    }

    unique
}

pub fn prepended_path_env(prefixes: &[PathBuf]) -> Option<std::ffi::OsString> {
    let mut entries = Vec::<PathBuf>::new();

    for prefix in prefixes {
        if prefix.is_dir() {
            entries.push(prefix.clone());
        }
    }

    if let Some(existing) = env::var_os("PATH") {
        entries.extend(env::split_paths(&existing));
    }

    if entries.is_empty() {
        return None;
    }

    env::join_paths(entries).ok()
}
