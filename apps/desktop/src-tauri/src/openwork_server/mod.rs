use gethostname::gethostname;
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use uuid::Uuid;

use crate::types::OpenworkServerInfo;
use crate::utils::now_ms;
use crate::utils::truncate_output;

pub mod manager;
pub mod spawn;

use manager::OpenworkServerManager;
use spawn::{resolve_openwork_port, spawn_openwork_server};

fn generate_token() -> String {
    Uuid::new_v4().to_string()
}

const OPENWORK_SERVER_TOKEN_STORE_VERSION: u32 = 1;

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

fn openwork_server_token_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(data_dir.join("openwork-server-tokens.json"))
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
    if let Some(tokens) = store.workspaces.get(workspace_key) {
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
        .insert(workspace_key.to_string(), tokens.clone());
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
    let Some(tokens) = store.workspaces.get_mut(workspace_key) else {
        return Ok(());
    };
    tokens.owner_token = Some(owner_token.to_string());
    tokens.updated_at = now_ms();
    save_openwork_server_token_store(path, &store)
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
    let port = resolve_openwork_port(&host)?;
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");
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
    state.remote_access_enabled = remote_access_enabled;
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
    state.last_stdout = None;
    state.last_stderr = None;

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
}
