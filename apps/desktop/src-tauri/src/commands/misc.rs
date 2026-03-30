use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::engine::doctor::resolve_engine_path;
use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::openwork_server::manager::OpenworkServerManager;
use crate::orchestrator;
use crate::orchestrator::manager::OrchestratorManager;
use crate::paths::{candidate_xdg_config_dirs, candidate_xdg_data_dirs, home_dir};
use crate::platform::command_for_program;
use crate::types::{ExecResult, WorkspaceOpenworkConfig};
use crate::workspace::state::load_workspace_state;
use tauri::{AppHandle, Manager, State};

fn pinned_opencode_install_command() -> String {
    let constants = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../constants.json"
    ));
    let parsed: serde_json::Value =
        serde_json::from_str(constants).expect("constants.json must be valid JSON");
    let version = parsed["opencodeVersion"]
        .as_str()
        .expect("constants.json must include opencodeVersion")
        .trim()
        .trim_start_matches('v');
    format!(
        "curl -fsSL https://opencode.ai/install | bash -s -- --version {} --no-modify-path",
        version
    )
}

#[derive(serde::Serialize)]
pub struct CacheResetResult {
    pub removed: Vec<String>,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    pub version: String,
    pub git_sha: Option<String>,
    pub build_epoch: Option<String>,
    pub openwork_dev_mode: bool,
}

fn env_truthy(key: &str) -> bool {
    matches!(
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "1" || value == "true" || value == "yes" || value == "on"
    )
}

fn opencode_cache_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(value) = std::env::var("XDG_CACHE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed).join("opencode"));
        }
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".cache").join("opencode"));

        #[cfg(target_os = "macos")]
        {
            candidates.push(home.join("Library").join("Caches").join("opencode"));
        }
    }

    #[cfg(windows)]
    {
        if let Ok(value) = std::env::var("LOCALAPPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
        if let Ok(value) = std::env::var("APPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn push_opencode_env_path(candidates: &mut Vec<PathBuf>, key: &str) {
    let Ok(value) = std::env::var(key) else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    candidates.push(PathBuf::from(trimmed).join("opencode"));
}

fn opencode_standard_state_paths() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    push_opencode_env_path(&mut candidates, "XDG_CONFIG_HOME");
    push_opencode_env_path(&mut candidates, "XDG_DATA_HOME");
    push_opencode_env_path(&mut candidates, "XDG_STATE_HOME");
    candidates.extend(opencode_cache_candidates());

    for dir in candidate_xdg_config_dirs() {
        candidates.push(dir.join("opencode"));
    }

    for dir in candidate_xdg_data_dirs() {
        candidates.push(dir.join("opencode"));
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".local").join("state").join("opencode"));

        #[cfg(target_os = "macos")]
        {
            candidates.push(
                home.join("Library")
                    .join("Application Support")
                    .join("opencode"),
            );
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn current_openwork_state_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut paths = vec![
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?,
        app.path()
            .app_config_dir()
            .map_err(|e| format!("Failed to resolve app config dir: {e}"))?,
        app.path()
            .app_local_data_dir()
            .map_err(|e| format!("Failed to resolve app local data dir: {e}"))?,
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?,
        PathBuf::from(orchestrator::resolve_orchestrator_data_dir()),
    ];

    if let Some(home) = home_dir() {
        paths.push(
            home.join("OpenWork")
                .join("Welcome")
                .join(".opencode")
                .join("openwork.json"),
        );
    }

    Ok(paths)
}

fn stop_host_services(
    engine_manager: &State<EngineManager>,
    orchestrator_manager: &State<OrchestratorManager>,
    openwork_manager: &State<OpenworkServerManager>,
    opencode_router_manager: &State<OpenCodeRouterManager>,
) {
    if let Ok(mut engine) = engine_manager.inner.lock() {
        EngineManager::stop_locked(&mut engine);
    }
    if let Ok(mut orchestrator_state) = orchestrator_manager.inner.lock() {
        OrchestratorManager::stop_locked(&mut orchestrator_state);
    }
    if let Ok(mut openwork_state) = openwork_manager.inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_state);
    }
    if let Ok(mut opencode_router_state) = opencode_router_manager.inner.lock() {
        OpenCodeRouterManager::stop_locked(&mut opencode_router_state);
    }
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {}: {e}", path.display()))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove file {}: {e}", path.display()))
    }
}

fn validate_server_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("server_name is required".to_string());
    }

    if trimmed.starts_with('-') {
        return Err("server_name must not start with '-'".to_string());
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("server_name must be alphanumeric with '-' or '_'".to_string());
    }

    Ok(trimmed.to_string())
}

fn read_workspace_openwork_config(
    workspace_path: &Path,
) -> Result<WorkspaceOpenworkConfig, String> {
    let openwork_path = workspace_path.join(".opencode").join("openwork.json");
    if !openwork_path.exists() {
        let mut cfg = WorkspaceOpenworkConfig::default();
        let workspace_value = workspace_path.to_string_lossy().to_string();
        if !workspace_value.trim().is_empty() {
            cfg.authorized_roots.push(workspace_value);
        }
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&openwork_path)
        .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

    serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

fn load_authorized_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let state = load_workspace_state(app)?;
    let mut roots = Vec::new();

    for workspace in state.workspaces {
        let workspace_path = PathBuf::from(&workspace.path);
        let mut config = read_workspace_openwork_config(&workspace_path)?;

        if config.authorized_roots.is_empty() {
            config.authorized_roots.push(workspace.path.clone());
        }

        for root in config.authorized_roots {
            let trimmed = root.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }

    if roots.is_empty() {
        return Err("No authorized roots configured".to_string());
    }

    Ok(roots)
}

fn validate_project_dir(app: &AppHandle, project_dir: &str) -> Result<PathBuf, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return Err("project_dir is required".to_string());
    }

    let project_path = PathBuf::from(trimmed);
    if !project_path.is_absolute() {
        return Err("project_dir must be an absolute path".to_string());
    }

    let canonical = fs::canonicalize(&project_path)
        .map_err(|e| format!("Failed to resolve project_dir: {e}"))?;

    if !canonical.is_dir() {
        return Err("project_dir must be a directory".to_string());
    }

    let roots = load_authorized_roots(app)?;
    let mut allowed = false;
    for root in roots {
        let Ok(root) = fs::canonicalize(&root) else {
            continue;
        };
        if canonical.starts_with(&root) {
            allowed = true;
            break;
        }
    }

    if !allowed {
        return Err("project_dir is not within an authorized root".to_string());
    }

    Ok(canonical)
}

fn resolve_opencode_program(
    app: &AppHandle,
    prefer_sidecar: bool,
    opencode_bin_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(custom) = opencode_bin_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let (program, _in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );

    program.ok_or_else(|| {
        let notes_text = notes.join("\n");
        let install_command = pinned_opencode_install_command();
        format!(
            "OpenCode CLI not found.\n\nInstall with:\n- {install_command}\n\nNotes:\n{notes_text}"
        )
    })
}

#[tauri::command]
pub fn reset_opencode_cache() -> Result<CacheResetResult, String> {
    let candidates = opencode_cache_candidates();
    let mut removed = Vec::new();
    let mut missing = Vec::new();
    let mut errors = Vec::new();

    for path in candidates {
        if path.exists() {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                errors.push(format!("Failed to remove {}: {err}", path.display()));
            } else {
                removed.push(path.to_string_lossy().to_string());
            }
        } else {
            missing.push(path.to_string_lossy().to_string());
        }
    }

    Ok(CacheResetResult {
        removed,
        missing,
        errors,
    })
}

#[tauri::command]
pub fn reset_openwork_state(
    app: tauri::AppHandle,
    mode: String,
    engine_manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    openwork_manager: State<OpenworkServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<(), String> {
    let mode = mode.trim();
    if mode != "onboarding" && mode != "all" {
        return Err("mode must be 'onboarding' or 'all'".to_string());
    }

    stop_host_services(
        &engine_manager,
        &orchestrator_manager,
        &openwork_manager,
        &opencode_router_manager,
    );

    let mut paths = vec![
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?,
        app.path()
            .app_config_dir()
            .map_err(|e| format!("Failed to resolve app config dir: {e}"))?,
        app.path()
            .app_local_data_dir()
            .map_err(|e| format!("Failed to resolve app local data dir: {e}"))?,
    ];

    if mode == "all" {
        paths.push(
            app.path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app data dir: {e}"))?,
        );
        paths.push(PathBuf::from(orchestrator::resolve_orchestrator_data_dir()));
    }

    let mut seen = HashSet::new();
    for path in paths {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            remove_path_if_exists(&path)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn app_build_info(app: AppHandle) -> AppBuildInfo {
    let version = app.package_info().version.to_string();
    let git_sha = option_env!("OPENWORK_GIT_SHA").map(|value| value.to_string());
    let build_epoch = option_env!("OPENWORK_BUILD_EPOCH").map(|value| value.to_string());
    AppBuildInfo {
        version,
        git_sha,
        build_epoch,
        openwork_dev_mode: env_truthy("OPENWORK_DEV_MODE"),
    }
}

#[tauri::command]
pub fn nuke_openwork_and_opencode_config_and_exit(
    app: AppHandle,
    engine_manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    openwork_manager: State<OpenworkServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<(), String> {
    stop_host_services(
        &engine_manager,
        &orchestrator_manager,
        &openwork_manager,
        &opencode_router_manager,
    );

    let dev_mode = env_truthy("OPENWORK_DEV_MODE");
    let mut paths = current_openwork_state_paths(&app)?;
    if dev_mode {
        // In dev mode, the current app + orchestrator directories are already isolated
        // by the dev app identity and OPENWORK_DATA_DIR, so only clear those dev paths.
    } else {
        // In production, clear the normal app/orchestrator paths plus the standard
        // user OpenCode config/data/cache/state locations.
        paths.extend(opencode_standard_state_paths());
    }

    let mut seen = HashSet::new();
    for path in paths {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            remove_path_if_exists(&path)?;
        }
    }

    app.exit(0);
    Ok(())
}

/// Run `opencode mcp auth <server_name>` in the given project directory.
/// This spawns the process detached so the OAuth flow can open a browser.
#[tauri::command]
pub fn opencode_mcp_auth(
    app: AppHandle,
    project_dir: String,
    server_name: String,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let server_name = validate_server_name(&server_name)?;

    let program = resolve_opencode_program(&app, true, None)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("mcp")
        .arg("auth")
        .arg(server_name)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode mcp auth: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}
