use tauri::{AppHandle, Manager, State};

use crate::config::{read_opencode_config, write_opencode_config};
use crate::engine::doctor::{opencode_serve_help, opencode_version, resolve_engine_path};
use crate::engine::manager::EngineManager;
use crate::openwork_server::{manager::OpenworkServerManager, start_openwork_server};
use crate::types::{EngineDoctorResult, EngineInfo, EngineRuntime, ExecResult};
use crate::utils::truncate_output;
use serde::Deserialize;
use serde_json::json;

struct EnvVarGuard {
    key: &'static str,
    original: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn apply(key: &'static str, value: Option<&str>) -> Self {
        let original = std::env::var_os(key);
        match value {
            Some(next) if !next.trim().is_empty() => {
                std::env::set_var(key, next.trim());
            }
            _ => {
                std::env::remove_var(key);
            }
        }
        Self { key, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

fn pinned_opencode_version() -> String {
    let constants = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../constants.json"
    ));
    let parsed: serde_json::Value =
        serde_json::from_str(constants).expect("constants.json must be valid JSON");
    parsed["opencodeVersion"]
        .as_str()
        .expect("constants.json must include opencodeVersion")
        .trim()
        .trim_start_matches('v')
        .to_string()
}

fn pinned_opencode_install_command() -> String {
    format!(
        "curl -fsSL https://opencode.ai/install | bash -s -- --version {} --no-modify-path",
        pinned_opencode_version()
    )
}

#[derive(Debug, Deserialize)]
struct OpenworkWorkspaceListResponse {
    #[serde(default)]
    items: Vec<OpenworkWorkspaceEntry>,
}

#[derive(Debug, Deserialize)]
struct OpenworkWorkspaceEntry {
    opencode: Option<OpenworkWorkspaceOpencode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenworkWorkspaceOpencode {
    base_url: String,
    directory: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

fn parse_base_url_host(base_url: &str) -> Option<String> {
    let without_scheme = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    let host_port = without_scheme.split('/').next()?.trim();
    let host = host_port
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(host_port);
    if host.is_empty() {
        None
    } else {
        Some(host.trim_matches(['[', ']']).to_string())
    }
}

fn parse_base_url_port(base_url: &str) -> Option<u16> {
    let without_scheme = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    let host_port = without_scheme.split('/').next()?.trim();
    host_port
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
}

fn opencode_bin_source(notes: &[String], in_path: bool) -> Option<String> {
    if notes
        .iter()
        .any(|note| note.contains("Using OPENCODE_BIN_PATH"))
    {
        return Some("custom".to_string());
    }
    if notes
        .iter()
        .any(|note| note.contains("Using bundled sidecar"))
    {
        return Some("bundled".to_string());
    }
    if in_path {
        return Some("path".to_string());
    }
    if notes.iter().any(|note| note.starts_with("Found at ")) {
        return Some("known-location".to_string());
    }

    None
}

fn probe_openwork_managed_opencode(
    server_base_url: &str,
    owner_token: &str,
) -> Result<Option<OpenworkWorkspaceOpencode>, String> {
    let response = ureq::get(&format!(
        "{}/workspaces",
        server_base_url.trim_end_matches('/')
    ))
    .set("Authorization", &format!("Bearer {owner_token}"))
    .call()
    .map_err(|error| error.to_string())?;
    let payload: OpenworkWorkspaceListResponse = response
        .into_json()
        .map_err(|error| format!("Failed to parse OpenWork workspaces response: {error}"))?;

    Ok(payload.items.into_iter().find_map(|entry| {
        entry
            .opencode
            .filter(|opencode| !opencode.base_url.trim().is_empty())
    }))
}

#[tauri::command]
pub fn engine_info(manager: State<EngineManager>) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_stop(
    manager: State<EngineManager>,
    openwork_manager: State<OpenworkServerManager>,
) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);
    if let Ok(mut openwork_state) = openwork_manager.inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_state);
    }
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_restart(
    app: AppHandle,
    manager: State<EngineManager>,
    openwork_manager: State<OpenworkServerManager>,
    opencode_enable_exa: Option<bool>,
    openwork_remote_access: Option<bool>,
) -> Result<EngineInfo, String> {
    let project_dir = {
        let state = manager.inner.lock().expect("engine mutex poisoned");
        state
            .project_dir
            .clone()
            .ok_or_else(|| "OpenCode is not configured for a local workspace".to_string())?
    };

    let workspace_paths = vec![project_dir.clone()];
    engine_start(
        app,
        manager,
        openwork_manager,
        project_dir,
        None,
        None,
        opencode_enable_exa,
        openwork_remote_access,
        None,
        Some(workspace_paths),
    )
}

#[tauri::command]
pub fn engine_doctor(
    app: AppHandle,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
) -> EngineDoctorResult {
    let prefer_sidecar = prefer_sidecar.unwrap_or(true);
    let resource_dir = app.path().resource_dir().ok();

    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let _guard = EnvVarGuard::apply("OPENCODE_BIN_PATH", opencode_bin_path.as_deref());

    let (resolved, in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );
    let resolved_source = opencode_bin_source(&notes, in_path);

    let (version, supports_serve, serve_help_status, serve_help_stdout, serve_help_stderr) =
        match resolved.as_ref() {
            Some(path) => {
                let (ok, status, stdout, stderr) = opencode_serve_help(path.as_os_str());
                (
                    opencode_version(path.as_os_str()),
                    ok,
                    status,
                    stdout,
                    stderr,
                )
            }
            None => (None, false, None, None, None),
        };

    EngineDoctorResult {
        found: resolved.is_some(),
        in_path,
        resolved_path: resolved.map(|path| path.to_string_lossy().to_string()),
        resolved_source,
        version,
        supports_serve,
        notes,
        serve_help_status,
        serve_help_stdout,
        serve_help_stderr,
    }
}

#[tauri::command]
pub fn engine_install() -> Result<ExecResult, String> {
    #[cfg(windows)]
    {
        return Ok(ExecResult {
      ok: false,
      status: -1,
      stdout: String::new(),
      stderr: "Guided install is not supported on Windows yet. Install the OpenWork-pinned OpenCode version manually, then restart OpenWork.".to_string(),
    });
    }

    #[cfg(not(windows))]
    {
        let install_dir = crate::paths::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".opencode")
            .join("bin");

        let output = std::process::Command::new("bash")
            .arg("-lc")
            .arg(pinned_opencode_install_command())
            .env("OPENCODE_INSTALL_DIR", install_dir)
            .output()
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        let status = output.status.code().unwrap_or(-1);
        Ok(ExecResult {
            ok: output.status.success(),
            status,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

#[tauri::command]
pub fn engine_start(
    app: AppHandle,
    manager: State<EngineManager>,
    openwork_manager: State<OpenworkServerManager>,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
    _opencode_enable_exa: Option<bool>,
    openwork_remote_access: Option<bool>,
    _runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
) -> Result<EngineInfo, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    // OpenCode is spawned with `current_dir(project_dir)`. If the user selected a
    // workspace path that doesn't exist yet (common during onboarding), spawning
    // fails with `os error 2`.
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create projectDir directory: {e}"))?;

    let config = read_opencode_config("project", &project_dir)?;
    if !config.exists {
        let content = serde_json::to_string_pretty(&json!({
            "$schema": "https://opencode.ai/config.json",
        }))
        .map_err(|e| format!("Failed to serialize opencode config: {e}"))?;
        let write_result = write_opencode_config("project", &project_dir, &format!("{content}\n"))?;
        if !write_result.ok {
            return Err(write_result.stderr);
        }
    }

    let mut workspace_paths = workspace_paths.unwrap_or_default();
    workspace_paths.retain(|path| !path.trim().is_empty());
    workspace_paths.retain(|path| path.trim() != project_dir);
    workspace_paths.insert(0, project_dir.clone());

    let openwork_remote_access_enabled = openwork_remote_access.unwrap_or(false);

    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);
    state.runtime = EngineRuntime::Direct;

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let prefer_sidecar = prefer_sidecar.unwrap_or(true);
    let _guard = EnvVarGuard::apply("OPENCODE_BIN_PATH", opencode_bin_path.as_deref());
    let (program, in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );
    let opencode_bin_source = opencode_bin_source(&notes, in_path);
    let Some(program) = program else {
        let notes_text = notes.join("\n");
        let install_command = pinned_opencode_install_command();
        return Err(format!(
            "OpenCode CLI not found.\n\nInstall with:\n- {install_command}\n\nNotes:\n{notes_text}"
        ));
    };

    let opencode_bin = program.to_string_lossy().to_string();
    let opencode_bin_path = Some(opencode_bin.clone());
    drop(state);

    if let Ok(mut openwork_state) = openwork_manager.inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_state);
    }

    let openwork_info = start_openwork_server(
        &app,
        &openwork_manager,
        &workspace_paths,
        None,
        None,
        None,
        openwork_remote_access_enabled,
        true,
        Some(&opencode_bin),
        opencode_bin_source.as_deref(),
    )?;

    let managed_opencode = match (
        openwork_info.base_url.as_deref(),
        openwork_info.owner_token.as_deref(),
    ) {
        (Some(server_base_url), Some(owner_token)) => {
            probe_openwork_managed_opencode(server_base_url, owner_token)
        }
        _ => Err("OpenWork server did not report a base URL and owner token".to_string()),
    };

    match managed_opencode {
        Ok(Some(opencode)) => {
            if let Ok(mut state) = manager.inner.lock() {
                state.runtime = EngineRuntime::Direct;
                state.child = None;
                state.child_exited = false;
                state.project_dir = opencode.directory.clone().or(Some(project_dir.clone()));
                state.hostname = parse_base_url_host(&opencode.base_url);
                state.port = parse_base_url_port(&opencode.base_url);
                state.base_url = Some(opencode.base_url.clone());
                state.opencode_username = opencode.username.clone();
                state.opencode_password = opencode.password.clone();
                state.opencode_bin_path = opencode_bin_path.clone();
                state.opencode_bin_source = opencode_bin_source.clone();
                state.last_stdout = None;
                state.last_stderr = None;
            }
        }
        Ok(None) => {
            if let Ok(mut state) = manager.inner.lock() {
                state.runtime = EngineRuntime::Direct;
                state.project_dir = Some(project_dir.clone());
                state.opencode_bin_path = opencode_bin_path.clone();
                state.opencode_bin_source = opencode_bin_source.clone();
                state.last_stderr = Some(truncate_output(
                    "OpenWork server did not report a managed OpenCode workspace",
                    8000,
                ));
            }
        }
        Err(error) => {
            if let Ok(mut state) = manager.inner.lock() {
                state.runtime = EngineRuntime::Direct;
                state.project_dir = Some(project_dir.clone());
                state.opencode_bin_path = opencode_bin_path.clone();
                state.opencode_bin_source = opencode_bin_source.clone();
                state.last_stderr = Some(truncate_output(
                    &format!("OpenWork server workspace probe: {error}"),
                    8000,
                ));
            }
        }
    }

    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    Ok(EngineManager::snapshot_locked(&mut state))
}
