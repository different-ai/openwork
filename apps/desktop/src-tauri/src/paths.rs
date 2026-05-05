use std::env;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::fs::{self, OpenOptions};
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use tauri::Manager;

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

#[cfg(windows)]
fn writable_probe_name() -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(".openwork-write-test-{}-{nonce}", std::process::id())
}

#[cfg(windows)]
fn ensure_dir_writable(path: &Path) -> bool {
    if fs::create_dir_all(path).is_err() {
        return false;
    }

    let probe = path.join(writable_probe_name());
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn resolve_process_working_dir(
    app: &tauri::AppHandle,
    preferred: &Path,
    fallback_name: &str,
) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = fallback_name;
        return Ok(preferred.to_path_buf());
    }

    #[cfg(windows)]
    {
        if ensure_dir_writable(preferred) {
            return Ok(preferred.to_path_buf());
        }

        let fallback = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Failed to resolve app local data dir: {e}"))?
            .join("runtime-cwd")
            .join(fallback_name);

        if ensure_dir_writable(&fallback) {
            return Ok(fallback);
        }

        Err(format!(
            "Failed to find a writable working directory. Preferred: {} Fallback: {}",
            preferred.display(),
            fallback.display()
        ))
    }
}
