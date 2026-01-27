use gethostname::gethostname;
use local_ip_address::local_ip;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use uuid::Uuid;

use crate::types::OpenworkServerInfo;
use crate::utils::truncate_output;

pub mod manager;
pub mod spawn;

use manager::OpenworkServerManager;
use spawn::{resolve_openwork_port, spawn_openwork_server};

fn generate_token() -> String {
    Uuid::new_v4().to_string()
}

fn build_urls(port: u16) -> (Option<String>, Option<String>, Option<String>) {
    let hostname = gethostname().to_string_lossy().trim().to_string();
    let mdns_url = if hostname.is_empty() {
        None
    } else {
        let trimmed = hostname.trim_end_matches(".local");
        Some(format!("http://{trimmed}.local:{port}"))
    };

    let lan_url = local_ip()
        .ok()
        .map(|ip| format!("http://{ip}:{port}"));

    let connect_url = lan_url.clone().or(mdns_url.clone());

    (connect_url, mdns_url, lan_url)
}

pub fn start_openwork_server(
    app: &AppHandle,
    manager: &OpenworkServerManager,
    workspace_path: &str,
) -> Result<OpenworkServerInfo, String> {
    let mut state = manager.inner.lock().map_err(|_| "openwork server mutex poisoned".to_string())?;
    OpenworkServerManager::stop_locked(&mut state);

    let host = "0.0.0.0".to_string();
    let port = resolve_openwork_port()?;
    let client_token = generate_token();
    let host_token = generate_token();

    let (mut rx, child) = spawn_openwork_server(app, &host, port, workspace_path, &client_token, &host_token)?;

    state.child = Some(child);
    state.child_exited = false;
    state.host = Some(host.clone());
    state.port = Some(port);
    state.base_url = Some(format!("http://127.0.0.1:{port}"));
    let (connect_url, mdns_url, lan_url) = build_urls(port);
    state.connect_url = connect_url;
    state.mdns_url = mdns_url;
    state.lan_url = lan_url;
    state.client_token = Some(client_token);
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
                        let next = state.last_stdout.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next = state.last_stderr.as_deref().unwrap_or_default().to_string() + &line;
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
                        let next = state.last_stderr.as_deref().unwrap_or_default().to_string() + &message;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    Ok(OpenworkServerManager::snapshot_locked(&mut state))
}
