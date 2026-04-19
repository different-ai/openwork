use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::DesktopBootstrapConfig;

const DESKTOP_BOOTSTRAP_FILE_NAME: &str = "desktop-bootstrap.json";
const DESKTOP_BOOTSTRAP_PATH_ENV: &str = "OPENWORK_DESKTOP_BOOTSTRAP_PATH";
const DEFAULT_DEN_BASE_URL: &str = "https://app.openworklabs.com";

fn trim_to_option(value: Option<&'static str>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn env_truthy(value: Option<&'static str>) -> bool {
    matches!(
        value.map(|entry| entry.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn normalize_desktop_bootstrap_config(
    config: &DesktopBootstrapConfig,
) -> Result<DesktopBootstrapConfig, String> {
    let base_url = config.base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("baseUrl is required".to_string());
    }

    Ok(DesktopBootstrapConfig {
        base_url,
        api_base_url: config
            .api_base_url
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        require_signin: config.require_signin,
    })
}

fn default_desktop_bootstrap_config() -> DesktopBootstrapConfig {
    DesktopBootstrapConfig {
        base_url: DEFAULT_DEN_BASE_URL.to_string(),
        api_base_url: None,
        require_signin: false,
    }
}

fn seed_desktop_bootstrap_config() -> Result<DesktopBootstrapConfig, String> {
    normalize_desktop_bootstrap_config(&DesktopBootstrapConfig {
        base_url: trim_to_option(
            option_env!("OPENWORK_DESKTOP_DEN_BASE_URL").or(option_env!("VITE_DEN_BASE_URL")),
        )
        .unwrap_or_else(|| DEFAULT_DEN_BASE_URL.to_string()),
        api_base_url: trim_to_option(
            option_env!("OPENWORK_DESKTOP_DEN_API_BASE_URL")
                .or(option_env!("VITE_DEN_API_BASE_URL")),
        ),
        require_signin: env_truthy(
            option_env!("OPENWORK_DESKTOP_DEN_REQUIRE_SIGNIN")
                .or(option_env!("VITE_DEN_REQUIRE_SIGNIN")),
        ),
    })
}

fn is_non_default_seed(config: &DesktopBootstrapConfig) -> bool {
    let default_config = default_desktop_bootstrap_config();
    config.base_url != default_config.base_url
        || config.api_base_url != default_config.api_base_url
        || config.require_signin != default_config.require_signin
}

fn desktop_bootstrap_path() -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os(DESKTOP_BOOTSTRAP_PATH_ENV) {
        let path = PathBuf::from(explicit);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }

    let config_root = dirs::config_dir()
        .ok_or_else(|| "Failed to resolve a desktop bootstrap config directory".to_string())?;
    Ok(config_root
        .join("OpenWork")
        .join(DESKTOP_BOOTSTRAP_FILE_NAME))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err(format!(
            "Bootstrap path {} has no parent directory",
            path.display()
        ));
    };

    fs::create_dir_all(parent).map_err(|e| format!("Failed to create {}: {e}", parent.display()))
}

pub fn load_desktop_bootstrap_config() -> Result<Option<DesktopBootstrapConfig>, String> {
    let path = desktop_bootstrap_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let parsed = serde_json::from_str::<DesktopBootstrapConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    Ok(Some(normalize_desktop_bootstrap_config(&parsed)?))
}

pub fn save_desktop_bootstrap_config(
    config: &DesktopBootstrapConfig,
) -> Result<DesktopBootstrapConfig, String> {
    let path = desktop_bootstrap_path()?;
    ensure_parent_dir(&path)?;

    let normalized = normalize_desktop_bootstrap_config(config)?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(normalized)
}

pub fn read_or_init_desktop_bootstrap_config() -> Result<DesktopBootstrapConfig, String> {
    let seeded = seed_desktop_bootstrap_config()?;
    let existing = load_desktop_bootstrap_config()?;

    if is_non_default_seed(&seeded) {
        if existing.as_ref() != Some(&seeded) {
            save_desktop_bootstrap_config(&seeded)?;
        }
        return Ok(seeded);
    }

    if let Some(config) = existing {
        return Ok(config);
    }

    Ok(seeded)
}
