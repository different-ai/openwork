use gethostname::gethostname;
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

use crate::paths::sidecar_path_candidates;
use crate::types::{OpenworkServerInfo, OpenworkServerStartupMode};
use crate::utils::now_ms;
use crate::utils::truncate_output;
use crate::workspace::state::load_workspace_state;
use crate::workspace::state::normalize_local_workspace_path;
use crate::types::WorkspaceType;

pub mod manager;
pub mod spawn;
pub mod startup_mode;

use manager::OpenworkServerManager;
use spawn::{resolve_openwork_port, spawn_openwork_server};

fn generate_token() -> String {
    Uuid::new_v4().to_string()
}

const OPENWORK_SERVER_TOKEN_STORE_VERSION: u32 = 1;
const OPENWORK_SERVER_STATE_VERSION: u32 = 3;
const LEGACY_FIXED_OPENWORK_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedOpenworkServerTokens {
    client_token: String,
    host_token: String,
    owner_token: Option<String>,
    updated_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedOpenworkServerTokenStore {
    version: u32,
    workspaces: HashMap<String, PersistedOpenworkServerTokens>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedOpenworkServerState {
    version: u32,
    #[serde(default)]
    workspace_ports: HashMap<String, u16>,
    #[serde(default)]
    preferred_port: Option<u16>,
}

fn openwork_server_token_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(data_dir.join("openwork-server-tokens.json"))
}

fn openwork_server_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(data_dir.join("openwork-server-state.json"))
}

fn normalize_workspace_key(workspace_key: &str) -> String {
    let trimmed = workspace_key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    normalize_local_workspace_path(trimmed)
}

fn load_openwork_server_token_store(
    path: &Path,
) -> Result<PersistedOpenworkServerTokenStore, String> {
    if !path.exists() {
        return Ok(PersistedOpenworkServerTokenStore {
            version: OPENWORK_SERVER_TOKEN_STORE_VERSION,
            workspaces: HashMap::new(),
        });
    }

    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut store: PersistedOpenworkServerTokenStore = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    if store.version < OPENWORK_SERVER_TOKEN_STORE_VERSION {
        store.version = OPENWORK_SERVER_TOKEN_STORE_VERSION;
    }
    Ok(store)
}

fn save_openwork_server_token_store(
    path: &Path,
    store: &PersistedOpenworkServerTokenStore,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, payload).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn load_openwork_server_state(path: &Path) -> Result<PersistedOpenworkServerState, String> {
    if !path.exists() {
        return Ok(PersistedOpenworkServerState {
            version: OPENWORK_SERVER_STATE_VERSION,
            workspace_ports: HashMap::new(),
            preferred_port: None,
        });
    }

    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut state: PersistedOpenworkServerState = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    if state.version < OPENWORK_SERVER_STATE_VERSION {
        if state.version < 2 && state.preferred_port == Some(LEGACY_FIXED_OPENWORK_PORT) {
            state.preferred_port = None;
        }
        if state.version < 3 && state.preferred_port == Some(LEGACY_FIXED_OPENWORK_PORT) {
            state.preferred_port = None;
        }
        state.version = OPENWORK_SERVER_STATE_VERSION;
    }
    Ok(state)
}

fn save_openwork_server_state(
    path: &Path,
    state: &PersistedOpenworkServerState,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, payload).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn read_preferred_openwork_port_at_path(
    path: &Path,
    workspace_key: &str,
) -> Result<Option<u16>, String> {
    let state = load_openwork_server_state(path)?;
    let normalized = normalize_workspace_key(workspace_key);
    if !normalized.is_empty() {
        if let Some(port) = state.workspace_ports.get(&normalized) {
            return Ok(Some(*port));
        }
    }
    if !state.workspace_ports.is_empty() {
        return Ok(None);
    }
    Ok(state.preferred_port)
}

fn read_preferred_openwork_port(app: &AppHandle, workspace_key: &str) -> Result<Option<u16>, String> {
    let path = openwork_server_state_path(app)?;
    read_preferred_openwork_port_at_path(&path, workspace_key)
}

fn reserved_openwork_ports_at_path(
    path: &Path,
    exclude_workspace_key: &str,
) -> Result<HashSet<u16>, String> {
    let state = load_openwork_server_state(path)?;
    let excluded = normalize_workspace_key(exclude_workspace_key);
    let mut reserved = HashSet::new();
    for (workspace_key, port) in state.workspace_ports {
        if workspace_key == excluded {
            continue;
        }
        reserved.insert(port);
    }
    if excluded.is_empty() {
        if let Some(port) = state.preferred_port {
            reserved.insert(port);
        }
    }
    Ok(reserved)
}

fn reserved_openwork_ports(app: &AppHandle, exclude_workspace_key: &str) -> Result<HashSet<u16>, String> {
    let path = openwork_server_state_path(app)?;
    reserved_openwork_ports_at_path(&path, exclude_workspace_key)
}

fn persist_preferred_openwork_port_at_path(
    path: &Path,
    workspace_key: &str,
    port: u16,
) -> Result<(), String> {
    let mut state = load_openwork_server_state(path)?;
    state.version = OPENWORK_SERVER_STATE_VERSION;
    let normalized = normalize_workspace_key(workspace_key);
    if normalized.is_empty() {
        state.preferred_port = Some(port);
    } else {
        state.workspace_ports.insert(normalized, port);
        state.preferred_port = None;
    }
    save_openwork_server_state(path, &state)
}

fn persist_preferred_openwork_port(
    app: &AppHandle,
    workspace_key: &str,
    port: u16,
) -> Result<(), String> {
    let path = openwork_server_state_path(app)?;
    persist_preferred_openwork_port_at_path(&path, workspace_key, port)
}

fn load_or_create_workspace_tokens(
    app: &AppHandle,
    workspace_key: &str,
) -> Result<PersistedOpenworkServerTokens, String> {
    let path = openwork_server_token_store_path(app)?;
    load_or_create_workspace_tokens_at_path(&path, workspace_key)
}

fn load_or_create_workspace_tokens_at_path(
    path: &Path,
    workspace_key: &str,
) -> Result<PersistedOpenworkServerTokens, String> {
    let mut store = load_openwork_server_token_store(path)?;
    let normalized = normalize_workspace_key(workspace_key);
    if let Some(tokens) = store.workspaces.get(&normalized) {
        return Ok(tokens.clone());
    }

    let tokens = PersistedOpenworkServerTokens {
        client_token: generate_token(),
        host_token: generate_token(),
        owner_token: None,
        updated_at: now_ms(),
    };
    store
        .workspaces
        .insert(normalized, tokens.clone());
    save_openwork_server_token_store(path, &store)?;
    Ok(tokens)
}

fn persist_workspace_owner_token(
    app: &AppHandle,
    workspace_key: &str,
    owner_token: &str,
) -> Result<(), String> {
    let path = openwork_server_token_store_path(app)?;
    persist_workspace_owner_token_at_path(&path, workspace_key, owner_token)
}

fn persist_workspace_owner_token_at_path(
    path: &Path,
    workspace_key: &str,
    owner_token: &str,
) -> Result<(), String> {
    let mut store = load_openwork_server_token_store(path)?;
    let normalized = normalize_workspace_key(workspace_key);
    let Some(tokens) = store.workspaces.get_mut(&normalized) else {
        return Ok(());
    };
    tokens.owner_token = Some(owner_token.to_string());
    tokens.updated_at = now_ms();
    save_openwork_server_token_store(path, &store)
}

fn read_workspace_tokens(
    app: &AppHandle,
    workspace_key: &str,
) -> Result<Option<PersistedOpenworkServerTokens>, String> {
    let path = openwork_server_token_store_path(app)?;
    let store = load_openwork_server_token_store(&path)?;
    let normalized = normalize_workspace_key(workspace_key);
    Ok(store.workspaces.get(&normalized).cloned())
}

fn workspace_probe_candidates(app: &AppHandle) -> Result<Vec<String>, String> {
    let state = load_workspace_state(app)?;
    let mut candidates = Vec::new();
    let selected = state.selected_workspace_id.trim().to_string();
    if !selected.is_empty() {
        if let Some(workspace) = state
            .workspaces
            .iter()
            .find(|workspace| workspace.id == selected && workspace.workspace_type == WorkspaceType::Local)
        {
            let path = workspace.path.trim();
            if !path.is_empty() {
                candidates.push(path.to_string());
            }
        }
    }
    for workspace in state.workspaces {
        if workspace.workspace_type != WorkspaceType::Local {
            continue;
        }
        let path = workspace.path.trim();
        if path.is_empty() || candidates.iter().any(|candidate| candidate == path) {
            continue;
        }
        candidates.push(path.to_string());
    }
    candidates.push(String::new());
    Ok(candidates)
}

pub fn probe_server_v2_snapshot(
    app: &AppHandle,
    manager: &OpenworkServerManager,
) -> Result<Option<OpenworkServerInfo>, String> {
    let candidates = workspace_probe_candidates(app)?;
    for workspace_key in candidates {
        let preferred_port = read_preferred_openwork_port(app, &workspace_key)?;
        let Some(port) = preferred_port else {
            continue;
        };
        let base_url = format!("http://127.0.0.1:{port}");
        if wait_for_server_v2_health(&base_url, Duration::from_millis(750)).is_err() {
            continue;
        }

        let (server_version, opencode_base_url, opencode_status, router_base_url, router_status) =
            read_server_v2_details(&base_url)?;
        let tokens = read_workspace_tokens(app, &workspace_key)?;

        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "openwork server mutex poisoned".to_string())?;
        state.child = None;
        state.child_exited = false;
        state.detected_running_without_child = true;
        state.remote_access_enabled = false;
        state.startup_mode = OpenworkServerStartupMode::ServerV2;
        state.host = Some("127.0.0.1".to_string());
        state.port = Some(port);
        state.base_url = Some(base_url);
        state.connect_url = None;
        state.mdns_url = None;
        state.lan_url = None;
        state.client_token = tokens.as_ref().map(|value| value.client_token.clone());
        state.owner_token = tokens.as_ref().and_then(|value| value.owner_token.clone());
        state.host_token = tokens.as_ref().map(|value| value.host_token.clone());
        state.server_version = server_version;
        state.opencode_base_url = opencode_base_url;
        state.opencode_status = opencode_status;
        state.router_base_url = router_base_url;
        state.router_status = router_status;
        return Ok(Some(OpenworkServerManager::snapshot_locked(&mut state)));
    }

    Ok(None)
}

fn wait_for_openwork_health(base_url: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let health_url = format!("{}/health", base_url.trim_end_matches('/'));
    let mut last_error = "OpenWork server did not become healthy".to_string();

    while Instant::now() < deadline {
        match ureq::get(&health_url).call() {
            Ok(response) if response.status() >= 200 && response.status() < 300 => return Ok(()),
            Ok(response) => {
                last_error = format!(
                    "OpenWork server health check returned {}",
                    response.status()
                )
            }
            Err(error) => last_error = error.to_string(),
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(last_error)
}

fn issue_owner_token(base_url: &str, host_token: &str) -> Result<String, String> {
    let response = ureq::post(&format!("{}/tokens", base_url.trim_end_matches('/')))
        .set("X-OpenWork-Host-Token", host_token)
        .set("Content-Type", "application/json")
        .send_string(r#"{"scope":"owner","label":"OpenWork desktop owner token"}"#)
        .map_err(|error| error.to_string())?;

    let payload: Value = response
        .into_json()
        .map_err(|error| format!("Failed to parse owner token response: {error}"))?;

    payload
        .get("token")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OpenWork server did not return an owner token".to_string())
}

fn build_urls(port: u16) -> (Option<String>, Option<String>, Option<String>) {
    let hostname = gethostname().to_string_lossy().trim().to_string();
    let mdns_url = if hostname.is_empty() {
        None
    } else {
        let trimmed = hostname.trim_end_matches(".local");
        Some(format!("http://{trimmed}.local:{port}"))
    };

    let lan_url = local_ip().ok().map(|ip| format!("http://{ip}:{port}"));
    let connect_url = lan_url.clone().or(mdns_url.clone());

    (connect_url, mdns_url, lan_url)
}

fn wait_for_server_v2_health(base_url: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let health_url = format!("{}/system/health", base_url.trim_end_matches('/'));
    let mut last_error = "OpenWork Server V2 did not become healthy".to_string();

    while Instant::now() < deadline {
        match ureq::get(&health_url).call() {
            Ok(response) if response.status() >= 200 && response.status() < 300 => return Ok(()),
            Ok(response) => {
                last_error = format!(
                    "OpenWork Server V2 health check returned {}",
                    response.status()
                )
            }
            Err(error) => last_error = error.to_string(),
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(last_error)
}

fn wait_for_server_v2_opencode(base_url: &str, timeout: Duration) -> Result<(String, String), String> {
    let deadline = Instant::now() + timeout;
    let health_url = format!("{}/system/opencode/health", base_url.trim_end_matches('/'));
    let mut last_error = "OpenWork Server V2 did not start OpenCode".to_string();

    while Instant::now() < deadline {
        match ureq::get(&health_url).call() {
            Ok(response) if response.status() >= 200 && response.status() < 300 => {
                let payload: Value = response
                    .into_json()
                    .map_err(|error| format!("Failed to parse Server V2 OpenCode health: {error}"))?;
                let status = payload
                    .pointer("/data/status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let base_url = payload
                    .pointer("/data/baseUrl")
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                if status == "running" {
                    if let Some(opencode_base_url) = base_url {
                        return Ok((opencode_base_url, status));
                    }
                }
                last_error = format!("OpenCode status is {status}");
            }
            Ok(response) => {
                last_error = format!(
                    "OpenWork Server V2 OpenCode health returned {}",
                    response.status()
                )
            }
            Err(error) => last_error = error.to_string(),
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err(last_error)
}

fn resolve_sidecar_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref())
        .into_iter()
        .next()
}

fn read_server_v2_details(base_url: &str) -> Result<(Option<String>, Option<String>, Option<String>, Option<String>, Option<String>), String> {
    let root: Value = ureq::get(base_url)
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| format!("Failed to parse Server V2 root response: {error}"))?;
    let opencode: Value = ureq::get(&format!("{}/system/opencode/health", base_url.trim_end_matches('/')))
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| format!("Failed to parse Server V2 OpenCode response: {error}"))?;
    let router: Value = ureq::get(&format!("{}/system/router/health", base_url.trim_end_matches('/')))
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| format!("Failed to parse Server V2 router response: {error}"))?;

    Ok((
        root.pointer("/data/version")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        opencode.pointer("/data/baseUrl")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        opencode.pointer("/data/status")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        router.pointer("/data/baseUrl")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        router.pointer("/data/status")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    ))
}

pub fn start_openwork_server_v2(
    app: &AppHandle,
    manager: &OpenworkServerManager,
    workspace_paths: &[String],
    remote_access_enabled: bool,
) -> Result<OpenworkServerInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "openwork server mutex poisoned".to_string())?;
    OpenworkServerManager::stop_locked(&mut state);

    let host = if remote_access_enabled {
        "0.0.0.0".to_string()
    } else {
        "127.0.0.1".to_string()
    };
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");
    let preferred_port = read_preferred_openwork_port(app, active_workspace)?;
    let reserved_ports = reserved_openwork_ports(app, active_workspace)?;
    let port = resolve_openwork_port(&host, preferred_port, &reserved_ports)?;
    let base_url = format!("http://127.0.0.1:{port}");
    let workspace_tokens = load_or_create_workspace_tokens(app, active_workspace)?;
    let client_token = workspace_tokens.client_token.clone();
    let host_token = workspace_tokens.host_token.clone();
    let sidecar_dir = resolve_sidecar_dir(app)
        .ok_or_else(|| "Unable to resolve the desktop sidecar directory for Server V2 runtime assets.".to_string())?;
    let runtime_manifest_path = sidecar_dir.join("manifest.json");

    let command = match app.shell().sidecar("openwork-server-v2") {
        Ok(command) => command,
        Err(_) => app.shell().command("openwork-server-v2"),
    };
    let cwd = workspace_paths
        .first()
        .map(|path| Path::new(path))
        .unwrap_or_else(|| Path::new("."));
    let port_text = port.to_string();

    let mut command = command
        .args(["--host", host.as_str(), "--port", port_text.as_str()])
        .current_dir(cwd)
        .env("OPENWORK_DESKTOP_HOSTED", "1")
        .env("OPENWORK_HOST_TOKEN", host_token.clone())
        .env("OPENWORK_TOKEN", client_token.clone())
        .env("OPENWORK_SERVER_V2_HOSTING_KIND", "desktop")
        .env("OPENWORK_SERVER_V2_RUNTIME_BOOTSTRAP", "eager")
        .env("OPENWORK_SERVER_V2_RUNTIME_BUNDLE_DIR", sidecar_dir.to_string_lossy().to_string())
        .env("OPENWORK_SERVER_V2_RUNTIME_SOURCE", "release");

    if runtime_manifest_path.is_file() {
        command = command.env(
            "OPENWORK_SERVER_V2_RUNTIME_MANIFEST_PATH",
            runtime_manifest_path.to_string_lossy().to_string(),
        );
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("Failed to start OpenWork Server V2: {e}"))?;

    state.child = Some(child);
    state.child_exited = false;
    state.detected_running_without_child = false;
    state.remote_access_enabled = remote_access_enabled;
    state.startup_mode = OpenworkServerStartupMode::ServerV2;
    state.host = Some(host.clone());
    state.port = Some(port);
    state.base_url = Some(base_url.clone());
    let (connect_url, mdns_url, lan_url) = if remote_access_enabled {
        build_urls(port)
    } else {
        (None, None, None)
    };
    state.connect_url = connect_url;
    state.mdns_url = mdns_url;
    state.lan_url = lan_url;
    state.client_token = Some(client_token);
    state.owner_token = None;
    state.host_token = Some(host_token);
    state.server_version = None;
    state.opencode_base_url = None;
    state.opencode_status = None;
    state.router_base_url = None;
    state.router_status = None;
    state.last_stdout = None;
    state.last_stderr = None;
    let _ = persist_preferred_openwork_port(app, active_workspace, port);

    let state_handle = manager.inner.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stdout.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        if let Some(code) = payload.code {
                            let next = format!("OpenWork Server V2 exited (code {code}).");
                            state.last_stderr = Some(truncate_output(&next, 8000));
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &message;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    drop(state);
    wait_for_server_v2_health(&base_url, Duration::from_secs(15))?;
    let (opencode_base_url, opencode_status) =
        wait_for_server_v2_opencode(&base_url, Duration::from_secs(30))?;
    let (server_version, _, _, router_base_url, router_status) =
        read_server_v2_details(&base_url)?;

    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "openwork server mutex poisoned".to_string())?;
    state.server_version = server_version;
    state.opencode_base_url = Some(opencode_base_url);
    state.opencode_status = Some(opencode_status);
    state.router_base_url = router_base_url;
    state.router_status = router_status;

    Ok(OpenworkServerManager::snapshot_locked(&mut state))
}

pub fn start_openwork_server(
    app: &AppHandle,
    manager: &OpenworkServerManager,
    workspace_paths: &[String],
    opencode_base_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
    remote_access_enabled: bool,
) -> Result<OpenworkServerInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "openwork server mutex poisoned".to_string())?;
    OpenworkServerManager::stop_locked(&mut state);

    let host = if remote_access_enabled {
        "0.0.0.0".to_string()
    } else {
        "127.0.0.1".to_string()
    };
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");
    let preferred_port = read_preferred_openwork_port(app, active_workspace)?;
    let reserved_ports = reserved_openwork_ports(app, active_workspace)?;
    let port = resolve_openwork_port(&host, preferred_port, &reserved_ports)?;
    let workspace_tokens = load_or_create_workspace_tokens(app, active_workspace)?;
    let client_token = workspace_tokens.client_token.clone();
    let host_token = workspace_tokens.host_token.clone();

    let (mut rx, child) = spawn_openwork_server(
        app,
        &host,
        port,
        workspace_paths,
        &client_token,
        &host_token,
        opencode_base_url,
        if active_workspace.is_empty() {
            None
        } else {
            Some(active_workspace)
        },
        opencode_username,
        opencode_password,
        opencode_router_health_port,
    )?;

    state.child = Some(child);
    state.child_exited = false;
    state.detected_running_without_child = false;
    state.remote_access_enabled = remote_access_enabled;
    state.startup_mode = OpenworkServerStartupMode::Legacy;
    state.host = Some(host.clone());
    state.port = Some(port);
    state.base_url = Some(format!("http://127.0.0.1:{port}"));
    let base_url = state
        .base_url
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let (connect_url, mdns_url, lan_url) = if remote_access_enabled {
        build_urls(port)
    } else {
        (None, None, None)
    };
    state.connect_url = connect_url;
    state.mdns_url = mdns_url;
    state.lan_url = lan_url;
    state.client_token = Some(client_token);
    state.owner_token = workspace_tokens.owner_token.clone();
    if state.owner_token.is_none() {
        state.owner_token = wait_for_openwork_health(&base_url, Duration::from_secs(10))
            .ok()
            .and_then(|_| issue_owner_token(&base_url, &host_token).ok());
        if let Some(owner_token) = state.owner_token.as_deref() {
            let _ = persist_workspace_owner_token(app, active_workspace, owner_token);
        }
    }
    state.host_token = Some(host_token);
    state.server_version = None;
    state.opencode_base_url = opencode_base_url.map(|value| value.to_string());
    state.opencode_status = Some("running".to_string());
    state.router_base_url = opencode_router_health_port.map(|value| format!("http://127.0.0.1:{value}"));
    state.router_status = Some(if opencode_router_health_port.is_some() {
        "running".to_string()
    } else {
        "disabled".to_string()
    });
    state.last_stdout = None;
    state.last_stderr = None;
    let _ = persist_preferred_openwork_port(app, active_workspace, port);

    let state_handle = manager.inner.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stdout.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        if let Some(code) = payload.code {
                            let next = format!("OpenWork server exited (code {code}).");
                            state.last_stderr = Some(truncate_output(&next, 8000));
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &message;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    Ok(OpenworkServerManager::snapshot_locked(&mut state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("openwork-server-{name}-{nonce}.json"))
    }

    #[test]
    fn reuses_tokens_for_the_same_workspace_after_restart() {
        let path = unique_temp_path("reuse");
        let first = load_or_create_workspace_tokens_at_path(&path, "/tmp/workspace")
            .expect("create first token set");
        let second = load_or_create_workspace_tokens_at_path(&path, "/tmp/workspace")
            .expect("load existing token set");

        assert_eq!(first.client_token, second.client_token);
        assert_eq!(first.host_token, second.host_token);
        assert_eq!(first.owner_token, second.owner_token);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn migrates_legacy_fixed_port_to_no_preference() {
        let path = unique_temp_path("port-migrate");
        fs::write(
            &path,
            r#"{"version":1,"preferred_port":8787}"#,
        )
        .expect("write legacy state");

        let state = load_openwork_server_state(&path).expect("load migrated state");
        assert_eq!(state.version, OPENWORK_SERVER_STATE_VERSION);
        assert_eq!(state.preferred_port, None);
        assert!(state.workspace_ports.is_empty());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn reuses_workspace_tokens_across_canonical_path_aliases() {
        let path = unique_temp_path("token-path-alias");
        let workspace = PathBuf::from(format!(
            "/tmp/openwork-workspace-token-alias-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&workspace).expect("create temp workspace");
        let canonical = fs::canonicalize(&workspace).expect("canonical workspace path");

        let first = load_or_create_workspace_tokens_at_path(&path, &workspace.to_string_lossy())
            .expect("store tokens using raw path");
        let second = load_or_create_workspace_tokens_at_path(&path, &canonical.to_string_lossy())
            .expect("load tokens using canonical path");

        assert_eq!(first.client_token, second.client_token);
        assert_eq!(first.host_token, second.host_token);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn reuses_workspace_port_across_canonical_path_aliases() {
        let path = unique_temp_path("port-path-alias");
        let workspace = PathBuf::from(format!(
            "/tmp/openwork-workspace-port-alias-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&workspace).expect("create temp workspace");
        let canonical = fs::canonicalize(&workspace).expect("canonical workspace path");

        persist_preferred_openwork_port_at_path(&path, &workspace.to_string_lossy(), 49_123)
            .expect("persist preferred port using raw path");

        let preferred = read_preferred_openwork_port_at_path(&path, &canonical.to_string_lossy())
            .expect("read preferred port using canonical path");
        let reserved = reserved_openwork_ports_at_path(&path, &canonical.to_string_lossy())
            .expect("read reserved ports using canonical path");

        assert_eq!(preferred, Some(49_123));
        assert!(!reserved.contains(&49_123));

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(workspace);
    }
}
