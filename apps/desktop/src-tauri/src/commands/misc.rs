use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::engine::doctor::resolve_engine_path;
use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::openwork_server::manager::OpenworkServerManager;
use crate::orchestrator;
use crate::orchestrator::manager::OrchestratorManager;
use crate::paths::home_dir;
use crate::platform::command_for_program;
use crate::types::{ExecResult, WorkspaceOpenworkConfig};
use crate::workspace::state::load_workspace_state;
use tauri::{AppHandle, Manager, State};

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
        format!(
            "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
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
pub fn nuke_opencode_dev_config_and_exit(
    app: AppHandle,
    engine_manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    openwork_manager: State<OpenworkServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<(), String> {
    if !env_truthy("OPENWORK_DEV_MODE") {
        return Err("OpenCode dev mode is not enabled.".to_string());
    }

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

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let desktop_dev_dir = app_data_dir.join("opencode-dev");
    if desktop_dev_dir.exists() {
        fs::remove_dir_all(&desktop_dev_dir)
            .map_err(|e| format!("Failed to remove {}: {e}", desktop_dev_dir.display()))?;
    }

    let orchestrator_data_dir = PathBuf::from(orchestrator::resolve_orchestrator_data_dir());
    let orchestrator_dev_dir = orchestrator_data_dir.join("opencode-dev");
    if orchestrator_dev_dir.exists() {
        fs::remove_dir_all(&orchestrator_dev_dir)
            .map_err(|e| format!("Failed to remove {}: {e}", orchestrator_dev_dir.display()))?;
    }

    for path in [
        orchestrator_data_dir.join("openwork-orchestrator-state.json"),
        orchestrator_data_dir.join("openwork-orchestrator-auth.json"),
    ] {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
        }
    }

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn obsidian_is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/Obsidian.app")];
        if let Some(home) = home_dir() {
            candidates.push(home.join("Applications").join("Obsidian.app"));
        }
        return candidates.into_iter().any(|path| path.exists());
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub fn open_in_obsidian(file_path: String) -> Result<(), String> {
    let trimmed = file_path.trim();
    println!("[misc][obsidian] open request path={trimmed}");
    if trimmed.is_empty() {
        println!("[misc][obsidian] rejected: empty path");
        return Err("file_path is required".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        println!(
            "[misc][obsidian] rejected: non-absolute path={}",
            path.display()
        );
        return Err("file_path must be an absolute path".to_string());
    }
    if !path.exists() {
        println!(
            "[misc][obsidian] missing path={} cwd={}",
            path.display(),
            std::env::current_dir()
                .map(|dir| dir.display().to_string())
                .unwrap_or_else(|_| "(unknown)".to_string())
        );
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        if !obsidian_is_available() {
            println!("[misc][obsidian] rejected: app not installed");
            return Err("Obsidian is not installed.".to_string());
        }

        println!("[misc][obsidian] launching path={}", path.display());
        let status = std::process::Command::new("open")
            .arg("-a")
            .arg("Obsidian")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to launch Obsidian: {e}"))?;
        if status.success() {
            println!("[misc][obsidian] launch success path={}", path.display());
            return Ok(());
        }
        println!(
            "[misc][obsidian] launch failed path={} status={status}",
            path.display()
        );
        return Err(format!(
            "Failed to launch Obsidian (exit status: {status})."
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!(
            "[misc][obsidian] unsupported platform request path={}",
            path.display()
        );
        Err("Open in Obsidian is currently supported on macOS only.".to_string())
    }
}

fn sanitize_obsidian_workspace_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };

        if normalized == '-' {
            if last_dash {
                continue;
            }
            out.push('-');
            last_dash = true;
            continue;
        }

        out.push(normalized);
        last_dash = false;
    }

    out.trim_matches('-').to_string()
}

fn normalize_obsidian_mirror_relative_path(file_path: &str) -> Result<PathBuf, String> {
    let mut value = file_path.trim().replace('\\', "/");
    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    while let Some(stripped) = value.strip_prefix("./") {
        value = stripped.to_string();
    }

    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("workspace/") {
        value = value["workspace/".len()..].to_string();
    } else if lower.starts_with("/workspace/") {
        let without_leading_slash = value.trim_start_matches('/').to_string();
        if without_leading_slash
            .to_ascii_lowercase()
            .starts_with("workspace/")
        {
            value = without_leading_slash["workspace/".len()..].to_string();
        }
    }

    let bytes = value.as_bytes();
    let is_windows_abs =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';

    if value.starts_with('/') || value.starts_with('~') || is_windows_abs {
        return Err("file_path must be worker-relative".to_string());
    }

    let mut relative = PathBuf::new();
    for part in value.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err("file_path must not contain '.' or '..' segments".to_string());
        }
        relative.push(part);
    }

    if relative.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }

    Ok(relative)
}

#[tauri::command]
pub fn write_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
    content: String,
) -> Result<String, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;

    Ok(target.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianMirrorFileContent {
    pub exists: bool,
    pub path: String,
    pub content: Option<String>,
    pub updated_at_ms: Option<u64>,
}

#[tauri::command]
pub fn read_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
) -> Result<ObsidianMirrorFileContent, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);
    let path_string = target.to_string_lossy().to_string();

    if !target.exists() {
        return Ok(ObsidianMirrorFileContent {
            exists: false,
            path: path_string,
            content: None,
            updated_at_ms: None,
        });
    }

    let metadata =
        fs::metadata(&target).map_err(|e| format!("Failed to stat {}: {e}", target.display()))?;
    if !metadata.is_file() {
        return Err(format!("Mirror path is not a file: {}", target.display()));
    }

    let content = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read {}: {e}", target.display()))?;
    let updated_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(ObsidianMirrorFileContent {
        exists: true,
        path: path_string,
        content: Some(content),
        updated_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::{normalize_obsidian_mirror_relative_path, sanitize_obsidian_workspace_id};

    #[test]
    fn sanitize_workspace_id_collapses_separators() {
        let out = sanitize_obsidian_workspace_id(" Team Alpha / Worker #1 ");
        assert_eq!(out, "team-alpha-worker-1");
    }

    #[test]
    fn normalize_mirror_path_strips_workspace_prefixes() {
        let path = normalize_obsidian_mirror_relative_path("/workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path.to_string_lossy(), "notes/plan.md");

        let path = normalize_obsidian_mirror_relative_path("workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path.to_string_lossy(), "notes/plan.md");
    }

    #[test]
    fn normalize_mirror_path_rejects_parent_segments() {
        let err = normalize_obsidian_mirror_relative_path("notes/../secret.md")
            .expect_err("parent segments should be rejected");
        assert!(err.contains("must not contain"));
    }

    #[test]
    fn normalize_mirror_path_rejects_absolute_paths() {
        let err = normalize_obsidian_mirror_relative_path("/etc/passwd")
            .expect_err("absolute path should be rejected");
        assert!(err.contains("worker-relative"));
    }
}

#[tauri::command]
pub fn opencode_db_migrate(
    app: AppHandle,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let program =
        resolve_opencode_program(&app, prefer_sidecar.unwrap_or(false), opencode_bin_path)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("db")
        .arg("migrate")
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode db migrate: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
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
