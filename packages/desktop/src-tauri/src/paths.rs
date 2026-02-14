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

/// Returns common paths where user-installed tools are typically located.
/// On macOS, GUI apps don't inherit shell profile modifications (.zshrc, .bashrc),
/// so tools installed via Homebrew, nvm, volta, etc. won't be found unless we
/// explicitly include these common locations.
fn common_tool_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // Homebrew paths (Apple Silicon and Intel)
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/opt/homebrew/sbin"));
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/usr/local/sbin"));

        // User-specific paths for common version managers
        if let Some(home) = home_dir() {
            // nvm, fnm (Node version managers)
            paths.push(home.join(".nvm/current/bin"));
            paths.push(home.join(".fnm/current/bin"));
            // volta
            paths.push(home.join(".volta/bin"));
            // pnpm
            paths.push(home.join("Library/pnpm"));
            // bun
            paths.push(home.join(".bun/bin"));
            // cargo/rustup
            paths.push(home.join(".cargo/bin"));
            // pyenv
            paths.push(home.join(".pyenv/shims"));
            // local bin
            paths.push(home.join(".local/bin"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/usr/local/sbin"));

        if let Some(home) = home_dir() {
            // nvm, fnm
            paths.push(home.join(".nvm/current/bin"));
            paths.push(home.join(".fnm/current/bin"));
            // volta
            paths.push(home.join(".volta/bin"));
            // pnpm
            paths.push(home.join(".local/share/pnpm"));
            // bun
            paths.push(home.join(".bun/bin"));
            // cargo
            paths.push(home.join(".cargo/bin"));
            // pyenv
            paths.push(home.join(".pyenv/shims"));
            // local bin
            paths.push(home.join(".local/bin"));
        }
    }

    #[cfg(windows)]
    {
        if let Some(home) = home_dir() {
            // volta
            paths.push(home.join(".volta/bin"));
            // pnpm
            if let Some(local) = env::var_os("LOCALAPPDATA") {
                paths.push(PathBuf::from(local).join("pnpm"));
            }
            // bun
            paths.push(home.join(".bun/bin"));
            // cargo
            paths.push(home.join(".cargo/bin"));
        }

        // npm global
        if let Some(app_data) = env::var_os("APPDATA") {
            paths.push(PathBuf::from(app_data).join("npm"));
        }
    }

    paths
}

pub fn prepended_path_env(prefixes: &[PathBuf]) -> Option<std::ffi::OsString> {
    let mut entries = Vec::<PathBuf>::new();

    for prefix in prefixes {
        if prefix.is_dir() {
            entries.push(prefix.clone());
        }
    }

    // Add common tool paths that may not be in the GUI app's inherited PATH
    for path in common_tool_paths() {
        if path.is_dir() && !entries.contains(&path) {
            entries.push(path);
        }
    }

    if let Some(existing) = env::var_os("PATH") {
        for path in env::split_paths(&existing) {
            if !entries.contains(&path) {
                entries.push(path);
            }
        }
    }

    if entries.is_empty() {
        return None;
    }

    env::join_paths(entries).ok()
}
