use std::path::Path;

use std::net::TcpListener;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_OWPENBOT_HEALTH_PORT: u16 = 3005;

pub fn resolve_owpenbot_health_port() -> Result<u16, String> {
    if TcpListener::bind(("0.0.0.0", DEFAULT_OWPENBOT_HEALTH_PORT)).is_ok() {
        return Ok(DEFAULT_OWPENBOT_HEALTH_PORT);
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_owpenbot_args(workspace_path: &str, opencode_url: Option<&str>) -> Vec<String> {
    let mut args = vec!["start".to_string(), workspace_path.to_string()];

    if let Some(url) = opencode_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            args.push("--opencode-url".to_string());
            args.push(trimmed.to_string());
        }
    }

    args
}

pub fn spawn_owpenbot(
    app: &AppHandle,
    workspace_path: &str,
    opencode_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    health_port: u16,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let args = build_owpenbot_args(workspace_path, opencode_url);

    let mut command = command
        .args(args)
        .current_dir(Path::new(workspace_path))
        .env("OWPENBOT_HEALTH_PORT", health_port.to_string());

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

    command
        .spawn()
        .map_err(|e| format!("Failed to start owpenbot: {e}"))
}
