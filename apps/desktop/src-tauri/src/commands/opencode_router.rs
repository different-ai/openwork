#![allow(non_snake_case)]

use std::time::{Duration, Instant};

use tauri::{AppHandle, State};
use tauri_plugin_shell::process::CommandEvent;

use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::opencode_router::spawn::{
    resolve_opencode_router_health_port, spawn_opencode_router, DEFAULT_OPENCODE_ROUTER_HEALTH_PORT,
};
use crate::types::OpenCodeRouterInfo;
use crate::utils::truncate_output;

/// Check if opencodeRouter health endpoint is responding on given port
fn check_health_endpoint(port: u16) -> Option<serde_json::Value> {
    let url = format!("http://127.0.0.1:{}/health", port);
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(2))
        .build();
    let response = agent.get(&url).call().ok()?;
    if response.status() == 200 {
        response.into_json().ok()
    } else {
        None
    }
}

const OPENCODE_ROUTER_STARTUP_WAIT_MS: u64 = 5_000;
const OPENCODE_ROUTER_MAX_START_ATTEMPTS: usize = 5;

fn append_output(slot: &mut Option<String>, line: &str) {
    let existing = slot.as_deref().unwrap_or_default();
    let next = format!("{existing}{line}");
    *slot = Some(truncate_output(&next, 8000));
}

fn is_port_in_use_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("port is in use")
        || lower.contains("eaddrinuse")
        || lower.contains("address already in use")
}

fn format_startup_failure(
    code: Option<i32>,
    startup_stdout: &Option<String>,
    startup_stderr: &Option<String>,
) -> String {
    let mut parts = Vec::new();
    if let Some(stdout) = startup_stdout {
        if !stdout.trim().is_empty() {
            parts.push(format!("stdout:\n{}", stdout.trim()));
        }
    }
    if let Some(stderr) = startup_stderr {
        if !stderr.trim().is_empty() {
            parts.push(format!("stderr:\n{}", stderr.trim()));
        }
    }

    let suffix = if parts.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", parts.join("\n\n"))
    };

    format!(
        "OpenCodeRouter exited during startup (code {}).{}",
        code.unwrap_or(-1),
        suffix
    )
}

fn await_router_startup(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    health_port: u16,
    startup_stdout: &mut Option<String>,
    startup_stderr: &mut Option<String>,
) -> Result<(), String> {
    if check_health_endpoint(health_port).is_some() {
        return Ok(());
    }

    let deadline = Instant::now() + Duration::from_millis(OPENCODE_ROUTER_STARTUP_WAIT_MS);
    loop {
        while let Ok(event) = rx.try_recv() {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    append_output(startup_stdout, &line);
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    append_output(startup_stderr, &line);
                }
                CommandEvent::Terminated(payload) => {
                    return Err(format_startup_failure(
                        payload.code,
                        startup_stdout,
                        startup_stderr,
                    ));
                }
                CommandEvent::Error(message) => {
                    append_output(startup_stderr, &message);
                    return Err(format!("OpenCodeRouter failed during startup: {message}"));
                }
                _ => {}
            }
        }

        if check_health_endpoint(health_port).is_some() {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Ok(());
        }

        std::thread::sleep(Duration::from_millis(80));
    }
}

#[tauri::command]
pub async fn opencodeRouter_info(
    app: AppHandle,
    manager: State<'_, OpenCodeRouterManager>,
) -> Result<OpenCodeRouterInfo, String> {
    let mut info = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "opencodeRouter mutex poisoned".to_string())?;
        OpenCodeRouterManager::snapshot_locked(&mut state)
    };

    // If manager doesn't think opencodeRouter is running, check health endpoint as fallback
    // This handles cases where opencodeRouter was started externally or by a previous app instance
    if !info.running {
        let health_port = { manager.inner.lock().ok().and_then(|s| s.health_port) }
            .unwrap_or(DEFAULT_OPENCODE_ROUTER_HEALTH_PORT);

        if let Some(health) = check_health_endpoint(health_port) {
            info.running = true;
            if let Some(opencode) = health.get("opencode") {
                if let Some(url) = opencode.get("url").and_then(|v| v.as_str()) {
                    info.opencode_url = Some(url.to_string());
                }
            }
        }
    }

    if info.version.is_none() {
        if let Some(version) = opencodeRouter_version(&app).await {
            info.version = Some(version.clone());
            if let Ok(mut state) = manager.inner.lock() {
                state.version = Some(version);
            }
        }
    }

    // Only fetch from CLI status if manager doesn't have values (fallback for when sidecar isn't started)
    if info.opencode_url.is_none() || info.workspace_path.is_none() {
        if let Ok(status) = opencodeRouter_json(&app, &["status", "--json"], "get status").await {
            if let Some(opencode) = status.get("opencode") {
                if info.opencode_url.is_none() {
                    if let Some(url) = opencode.get("url").and_then(|value| value.as_str()) {
                        let trimmed = url.trim();
                        if !trimmed.is_empty() {
                            info.opencode_url = Some(trimmed.to_string());
                        }
                    }
                }
                if info.workspace_path.is_none() {
                    if let Some(directory) =
                        opencode.get("directory").and_then(|value| value.as_str())
                    {
                        let trimmed = directory.trim();
                        if !trimmed.is_empty() {
                            info.workspace_path = Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(info)
}

#[tauri::command]
pub fn opencodeRouter_start(
    app: AppHandle,
    manager: State<OpenCodeRouterManager>,
    workspace_path: String,
    opencode_url: Option<String>,
    opencode_username: Option<String>,
    opencode_password: Option<String>,
    health_port: Option<u16>,
) -> Result<OpenCodeRouterInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "opencodeRouter mutex poisoned".to_string())?;
    OpenCodeRouterManager::stop_locked(&mut state);

    let max_attempts = if health_port.is_some() {
        1
    } else {
        OPENCODE_ROUTER_MAX_START_ATTEMPTS
    };

    let mut last_error: Option<String> = None;

    for attempt in 0..max_attempts {
        let resolved_health_port = if attempt == 0 {
            match health_port {
                Some(port) => port,
                None => resolve_opencode_router_health_port()?,
            }
        } else {
            resolve_opencode_router_health_port()?
        };

        let (mut rx, child) = match spawn_opencode_router(
            &app,
            &workspace_path,
            opencode_url.as_deref(),
            opencode_username.as_deref(),
            opencode_password.as_deref(),
            resolved_health_port,
        ) {
            Ok(value) => value,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };

        let mut startup_stdout: Option<String> = None;
        let mut startup_stderr: Option<String> = None;

        match await_router_startup(
            &mut rx,
            resolved_health_port,
            &mut startup_stdout,
            &mut startup_stderr,
        ) {
            Ok(()) => {
                state.child = Some(child);
                state.child_exited = false;
                state.workspace_path = Some(workspace_path.clone());
                state.opencode_url = opencode_url.clone();
                state.health_port = Some(resolved_health_port);
                state.last_stdout = startup_stdout;
                state.last_stderr = startup_stderr;

                let state_handle = manager.inner.clone();

                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line_bytes) => {
                                let line = String::from_utf8_lossy(&line_bytes).to_string();
                                if let Ok(mut state) = state_handle.try_lock() {
                                    let next = state
                                        .last_stdout
                                        .as_deref()
                                        .unwrap_or_default()
                                        .to_string()
                                        + &line;
                                    state.last_stdout = Some(truncate_output(&next, 8000));
                                }
                            }
                            CommandEvent::Stderr(line_bytes) => {
                                let line = String::from_utf8_lossy(&line_bytes).to_string();
                                if let Ok(mut state) = state_handle.try_lock() {
                                    let next = state
                                        .last_stderr
                                        .as_deref()
                                        .unwrap_or_default()
                                        .to_string()
                                        + &line;
                                    state.last_stderr = Some(truncate_output(&next, 8000));
                                }
                            }
                            CommandEvent::Terminated(payload) => {
                                if let Ok(mut state) = state_handle.try_lock() {
                                    state.child_exited = true;
                                    if let Some(code) = payload.code {
                                        let next = format!("OpenCodeRouter exited (code {code}).");
                                        state.last_stderr = Some(truncate_output(&next, 8000));
                                    }
                                }
                            }
                            CommandEvent::Error(message) => {
                                if let Ok(mut state) = state_handle.try_lock() {
                                    state.child_exited = true;
                                    let next = state
                                        .last_stderr
                                        .as_deref()
                                        .unwrap_or_default()
                                        .to_string()
                                        + &message;
                                    state.last_stderr = Some(truncate_output(&next, 8000));
                                }
                            }
                            _ => {}
                        }
                    }
                });

                return Ok(OpenCodeRouterManager::snapshot_locked(&mut state));
            }
            Err(error) => {
                let _ = child.kill();
                let retryable = health_port.is_none() && is_port_in_use_error(&error);
                last_error = Some(error);
                if !retryable {
                    break;
                }
            }
        }
    }

    let message = match last_error {
        Some(error) if max_attempts > 1 => {
            format!("Failed to start OpenCodeRouter after {max_attempts} attempts: {error}")
        }
        Some(error) => error,
        None => "Failed to start OpenCodeRouter".to_string(),
    };
    Err(message)
}

#[tauri::command]
pub fn opencodeRouter_stop(
    manager: State<OpenCodeRouterManager>,
) -> Result<OpenCodeRouterInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "opencodeRouter mutex poisoned".to_string())?;
    OpenCodeRouterManager::stop_locked(&mut state);
    Ok(OpenCodeRouterManager::snapshot_locked(&mut state))
}

#[tauri::command]
pub async fn opencodeRouter_status(
    app: AppHandle,
    manager: State<'_, OpenCodeRouterManager>,
) -> Result<serde_json::Value, String> {
    let status = opencodeRouter_json(&app, &["status", "--json"], "get status").await?;

    let mut running = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "opencodeRouter mutex poisoned".to_string())?;
        OpenCodeRouterManager::snapshot_locked(&mut state).running
    };

    if !running {
        let check_port = { manager.inner.lock().ok().and_then(|s| s.health_port) }
            .unwrap_or(DEFAULT_OPENCODE_ROUTER_HEALTH_PORT);

        if check_health_endpoint(check_port).is_some() {
            running = true;
        }
    }

    let config_path = status
        .get("config")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    let cli_health_port = status.get("healthPort").and_then(|value| value.as_u64());
    let manager_health_port = {
        let state = manager
            .inner
            .lock()
            .map_err(|_| "opencodeRouter mutex poisoned".to_string())?;
        state.health_port
    };
    let health_port = manager_health_port
        .map(|value| value as u64)
        .or(cli_health_port);

    let telegram_items: Vec<serde_json::Value> = status
        .get("telegram")
        .and_then(|value| value.as_array())
        .map(|arr| arr.iter().cloned().collect())
        .unwrap_or_default();

    let slack_items: Vec<serde_json::Value> = status
        .get("slack")
        .and_then(|value| value.as_array())
        .map(|arr| arr.iter().cloned().collect())
        .unwrap_or_default();

    let opencode_url = status
        .get("opencode")
        .and_then(|value| value.get("url"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    let opencode_directory = status
        .get("opencode")
        .and_then(|value| value.get("directory"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let mut opencode = serde_json::Map::new();
    opencode.insert(
        "url".to_string(),
        serde_json::Value::String(opencode_url.to_string()),
    );
    if let Some(directory) = opencode_directory {
        opencode.insert(
            "directory".to_string(),
            serde_json::Value::String(directory.to_string()),
        );
    }

    Ok(serde_json::json!({
        "running": running,
        "config": config_path,
        "healthPort": health_port,
        "telegram": {
            "items": telegram_items,
        },
        "slack": {
            "items": slack_items,
        },
        "opencode": serde_json::Value::Object(opencode),
    }))
}

#[tauri::command]
pub async fn opencodeRouter_config_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("opencode-router") {
        Ok(command) => command,
        Err(_) => app.shell().command("opencode-router"),
    };

    let output = command
        .args(["config", "set", &key, &value])
        .output()
        .await
        .map_err(|e| format!("Failed to set config: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to set config: {stderr}"));
    }

    Ok(())
}

async fn opencodeRouter_json(
    app: &AppHandle,
    args: &[&str],
    context: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("opencode-router") {
        Ok(command) => command,
        Err(_) => app.shell().command("opencode-router"),
    };

    let output = command
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to {context}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to {context}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse {context}: {e}"))
}

async fn opencodeRouter_version(app: &AppHandle) -> Option<String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("opencode-router") {
        Ok(command) => command,
        Err(_) => app.shell().command("opencode-router"),
    };

    let output = command.args(["--version"]).output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}
