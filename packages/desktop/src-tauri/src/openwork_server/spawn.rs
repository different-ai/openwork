use std::net::TcpListener;
use std::path::Path;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_OPENWORK_PORT: u16 = 8787;

pub fn resolve_openwork_port() -> Result<u16, String> {
    if TcpListener::bind(("0.0.0.0", DEFAULT_OPENWORK_PORT)).is_ok() {
        return Ok(DEFAULT_OPENWORK_PORT);
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_openwork_args(
    host: &str,
    port: u16,
    workspace_paths: &[String],
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--token".to_string(),
        token.to_string(),
        "--host-token".to_string(),
        host_token.to_string(),
        // Always allow all origins since the OpenWork server is designed to accept
        // remote connections from client devices (phones, laptops) which may use
        // different origins (localhost dev servers, tauri apps, web browsers).
        "--cors".to_string(),
        "*".to_string(),
        // Auto-approve write operations when running from the desktop app.
        // The user is already authenticated as host and in control of the UI.
        "--approval".to_string(),
        "auto".to_string(),
    ];

    for workspace_path in workspace_paths {
        if !workspace_path.trim().is_empty() {
            args.push("--workspace".to_string());
            args.push(workspace_path.to_string());
        }
    }

    if let Some(base_url) = opencode_base_url {
        if !base_url.trim().is_empty() {
            args.push("--opencode-base-url".to_string());
            args.push(base_url.to_string());
        }
    }

    if let Some(directory) = opencode_directory {
        if !directory.trim().is_empty() {
            args.push("--opencode-directory".to_string());
            args.push(directory.to_string());
        }
    }

    args
}

pub fn spawn_openwork_server(
    app: &AppHandle,
    host: &str,
    port: u16,
    workspace_paths: &[String],
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    owpenbot_health_port: Option<u16>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("openwork-server") {
        Ok(command) => command,
        Err(_) => app.shell().command("openwork-server"),
    };

    let args = build_openwork_args(
        host,
        port,
        workspace_paths,
        token,
        host_token,
        opencode_base_url,
        opencode_directory,
    );
    let cwd = workspace_paths
        .first()
        .map(|path| Path::new(path))
        .unwrap_or_else(|| Path::new("."));
    let mut command = command.args(args).current_dir(cwd);

    if let Some(port) = owpenbot_health_port {
        command = command.env("OWPENBOT_HEALTH_PORT", port.to_string());
    }

    if let Some(username) = opencode_username {
        if !username.trim().is_empty() {
            command = command.env("OPENWORK_OPENCODE_USERNAME", username);
        }
    }

    if let Some(password) = opencode_password {
        if !password.trim().is_empty() {
            command = command.env("OPENWORK_OPENCODE_PASSWORD", password);
        }
    }

    command
        .spawn()
        .map_err(|e| format!("Failed to start OpenWork server: {e}"))
}
