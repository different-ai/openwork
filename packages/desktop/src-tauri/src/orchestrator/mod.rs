use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::paths::home_dir;
use crate::paths::{prepended_path_env, sidecar_path_candidates};
use crate::types::{
    OrchestratorBinaryState, OrchestratorDaemonState, OrchestratorOpencodeState,
    OrchestratorSidecarInfo, OrchestratorStatus, OrchestratorWorkspace,
};

pub mod manager;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorAuthFile {
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
    pub project_dir: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStateFile {
    #[allow(dead_code)]
    pub version: Option<u32>,
    pub daemon: Option<OrchestratorDaemonState>,
    pub opencode: Option<OrchestratorOpencodeState>,
    pub cli_version: Option<String>,
    pub sidecar: Option<OrchestratorSidecarInfo>,
    pub binaries: Option<OrchestratorBinaryState>,
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<OrchestratorWorkspace>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorHealth {
    pub ok: bool,
    pub daemon: Option<OrchestratorDaemonState>,
    pub opencode: Option<OrchestratorOpencodeState>,
    pub cli_version: Option<String>,
    pub sidecar: Option<OrchestratorSidecarInfo>,
    pub binaries: Option<OrchestratorBinaryState>,
    pub active_id: Option<String>,
    pub workspace_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorWorkspaceList {
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<OrchestratorWorkspace>,
}

pub struct OrchestratorSpawnOptions {
    pub data_dir: String,
    pub daemon_host: String,
    pub daemon_port: u16,
    pub opencode_bin: String,
    pub opencode_host: String,
    pub opencode_workdir: String,
    pub opencode_port: Option<u16>,
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
    pub cors: Option<String>,
}

pub fn resolve_orchestrator_data_dir() -> String {
    let env_dir = env::var("OPENWORK_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if let Some(dir) = env_dir {
        return dir;
    }

    if let Some(home) = home_dir() {
        return home
            .join(".openwork")
            .join("openwork-orchestrator")
            .to_string_lossy()
            .to_string();
    }

    ".openwork/openwork-orchestrator".to_string()
}

fn orchestrator_state_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("openwork-orchestrator-state.json")
}

fn orchestrator_auth_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("openwork-orchestrator-auth.json")
}

pub fn read_orchestrator_auth(data_dir: &str) -> Option<OrchestratorAuthFile> {
    let path = orchestrator_auth_path(data_dir);
    let payload = fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

pub fn write_orchestrator_auth(
    data_dir: &str,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    project_dir: Option<&str>,
) -> Result<(), String> {
    let path = orchestrator_auth_path(data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let payload = OrchestratorAuthFile {
        opencode_username: opencode_username.map(|value| value.to_string()),
        opencode_password: opencode_password.map(|value| value.to_string()),
        project_dir: project_dir.map(|value| value.to_string()),
        updated_at: Some(crate::utils::now_ms()),
    };
    fs::write(
        &path,
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

pub fn clear_orchestrator_auth(data_dir: &str) {
    let path = orchestrator_auth_path(data_dir);
    let _ = fs::remove_file(path);
}

pub fn read_orchestrator_state(data_dir: &str) -> Option<OrchestratorStateFile> {
    let path = orchestrator_state_path(data_dir);
    let payload = fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

fn fetch_json<T: DeserializeOwned>(url: &str) -> Result<T, String> {
    let response = ureq::get(url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("{e}"))?;
    response
        .into_json::<T>()
        .map_err(|e| format!("Failed to parse response: {e}"))
}

pub fn fetch_orchestrator_health(base_url: &str) -> Result<OrchestratorHealth, String> {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    fetch_json(&url)
}

pub fn fetch_orchestrator_workspaces(base_url: &str) -> Result<OrchestratorWorkspaceList, String> {
    let url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    fetch_json(&url)
}

pub fn wait_for_orchestrator(
    base_url: &str,
    timeout_ms: u64,
) -> Result<OrchestratorHealth, String> {
    let start = std::time::Instant::now();
    let mut last_error = None;
    while start.elapsed().as_millis() < timeout_ms as u128 {
        match fetch_orchestrator_health(base_url) {
            Ok(health) if health.ok => return Ok(health),
            Ok(_) => last_error = Some("Orchestrator reported unhealthy".to_string()),
            Err(err) => last_error = Some(err),
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err(last_error.unwrap_or_else(|| "Timed out waiting for orchestrator".to_string()))
}

pub fn spawn_orchestrator_daemon(
    app: &AppHandle,
    options: &OrchestratorSpawnOptions,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("openwork-orchestrator") {
        Ok(command) => command,
        Err(_) => app.shell().command("openwork"),
    };

    let mut args = vec![
        "daemon".to_string(),
        "run".to_string(),
        "--data-dir".to_string(),
        options.data_dir.clone(),
        "--daemon-host".to_string(),
        options.daemon_host.clone(),
        "--daemon-port".to_string(),
        options.daemon_port.to_string(),
        "--opencode-bin".to_string(),
        options.opencode_bin.clone(),
        "--opencode-host".to_string(),
        options.opencode_host.clone(),
        "--opencode-workdir".to_string(),
        options.opencode_workdir.clone(),
        "--allow-external".to_string(),
    ];

    if let Some(port) = options.opencode_port {
        args.push("--opencode-port".to_string());
        args.push(port.to_string());
    }

    if let Some(username) = &options.opencode_username {
        if !username.trim().is_empty() {
            args.push("--opencode-username".to_string());
            args.push(username.to_string());
        }
    }

    if let Some(password) = &options.opencode_password {
        if !password.trim().is_empty() {
            args.push("--opencode-password".to_string());
            args.push(password.to_string());
        }
    }

    if let Some(cors) = &options.cors {
        if !cors.trim().is_empty() {
            args.push("--cors".to_string());
            args.push(cors.to_string());
        }
    }

    let mut command = command.args(args);

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let sidecar_paths =
        sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref());
    if let Some(path_env) = prepended_path_env(&sidecar_paths) {
        command = command.env("PATH", path_env);
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    command
        .spawn()
        .map_err(|e| format!("Failed to start orchestrator: {e}"))
}

pub fn orchestrator_status_from_state(
    data_dir: &str,
    last_error: Option<String>,
) -> OrchestratorStatus {
    let state = read_orchestrator_state(data_dir);
    let workspaces = state
        .as_ref()
        .map(|state| state.workspaces.clone())
        .unwrap_or_default();
    let workspace_count = workspaces.len();
    let active_id = state
        .as_ref()
        .and_then(|state| state.active_id.clone())
        .filter(|id| !id.trim().is_empty());
    OrchestratorStatus {
        running: false,
        data_dir: data_dir.to_string(),
        daemon: state.as_ref().and_then(|state| state.daemon.clone()),
        opencode: state.as_ref().and_then(|state| state.opencode.clone()),
        cli_version: state.as_ref().and_then(|state| state.cli_version.clone()),
        sidecar: state.as_ref().and_then(|state| state.sidecar.clone()),
        binaries: state.as_ref().and_then(|state| state.binaries.clone()),
        active_id,
        workspace_count,
        workspaces,
        last_error,
    }
}

pub fn resolve_orchestrator_status(
    data_dir: &str,
    last_error: Option<String>,
) -> OrchestratorStatus {
    let fallback = orchestrator_status_from_state(data_dir, last_error);
    let base_url = fallback
        .daemon
        .as_ref()
        .map(|daemon| daemon.base_url.clone());
    let Some(base_url) = base_url else {
        return fallback;
    };

    match fetch_orchestrator_health(&base_url) {
        Ok(health) => {
            let workspace_payload = fetch_orchestrator_workspaces(&base_url).ok();
            let workspaces = workspace_payload
                .as_ref()
                .map(|payload| payload.workspaces.clone())
                .unwrap_or_else(|| fallback.workspaces.clone());
            let active_id = workspace_payload
                .as_ref()
                .and_then(|payload| payload.active_id.clone())
                .or_else(|| health.active_id.clone())
                .filter(|id| !id.trim().is_empty());
            let workspace_count = workspace_payload
                .as_ref()
                .map(|payload| payload.workspaces.len())
                .or(health.workspace_count)
                .unwrap_or(workspaces.len());
            OrchestratorStatus {
                running: health.ok,
                data_dir: data_dir.to_string(),
                daemon: health.daemon,
                opencode: health.opencode,
                cli_version: health.cli_version,
                sidecar: health.sidecar,
                binaries: health.binaries,
                active_id,
                workspace_count,
                workspaces,
                last_error: None,
            }
        }
        Err(error) => OrchestratorStatus {
            last_error: Some(error),
            ..fallback
        },
    }
}
