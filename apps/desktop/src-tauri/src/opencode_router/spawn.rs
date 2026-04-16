use std::fs;
use std::path::Path;

use std::net::TcpListener;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_OPENCODE_ROUTER_HEALTH_PORT: u16 = 3005;

pub fn resolve_opencode_router_health_port() -> Result<u16, String> {
    // Pick an ephemeral localhost port by default to avoid conflicts when
    // multiple OpenWork desktop instances run on the same machine.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

/// Write the router's health port to ~/.openwork/opencode-router/port so that
/// the orchestrator tool can discover it without needing an env var.
pub fn write_router_port_file(port: u16) {
    if let Some(home) = crate::paths::home_dir() {
        let dir = home.join(".openwork").join("opencode-router");
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::write(dir.join("port"), port.to_string());
        }
    }
}

/// Remove the port file on router shutdown so stale ports are never read.
pub fn remove_router_port_file() {
    if let Some(home) = crate::paths::home_dir() {
        let _ = fs::remove_file(home.join(".openwork").join("opencode-router").join("port"));
    }
}

pub fn build_opencode_router_args(workspace_path: &str, opencode_url: Option<&str>) -> Vec<String> {
    let mut args = vec!["serve".to_string(), workspace_path.to_string()];

    if let Some(url) = opencode_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            args.push("--opencode-url".to_string());
            args.push(trimmed.to_string());
        }
    }

    args
}

pub fn spawn_opencode_router(
    app: &AppHandle,
    workspace_path: &str,
    opencode_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    health_port: u16,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("opencode-router") {
        Ok(command) => command,
        Err(_) => app.shell().command("opencode-router"),
    };

    let args = build_opencode_router_args(workspace_path, opencode_url);

    let mut command = command
        .args(args)
        .current_dir(Path::new(workspace_path))
        .env("OPENCODE_ROUTER_HEALTH_PORT", health_port.to_string());

    if let Some(username) = opencode_username {
        if !username.trim().is_empty() {
            command = command.env("OPENCODE_SERVER_USERNAME", username);
        }
    }

    if let Some(password) = opencode_password {
        if !password.trim().is_empty() {
            command = command.env("OPENCODE_SERVER_PASSWORD", password);
        }
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    write_router_port_file(health_port);

    command
        .spawn()
        .map_err(|e| format!("Failed to start opencodeRouter: {e}"))
}
