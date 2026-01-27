use std::net::TcpListener;
use std::path::Path;

use tauri::AppHandle;
use tauri::async_runtime::Receiver;
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

pub fn build_openwork_args(host: &str, port: u16, workspace_path: &str, token: &str, host_token: &str) -> Vec<String> {
    vec![
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--token".to_string(),
        token.to_string(),
        "--host-token".to_string(),
        host_token.to_string(),
        "--workspace".to_string(),
        workspace_path.to_string(),
        "--cors".to_string(),
        "http://localhost:5173".to_string(),
        "--cors".to_string(),
        "tauri://localhost".to_string(),
        "--cors".to_string(),
        "http://tauri.localhost".to_string(),
    ]
}

pub fn spawn_openwork_server(
    app: &AppHandle,
    host: &str,
    port: u16,
    workspace_path: &str,
    token: &str,
    host_token: &str,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("openwork-server") {
        Ok(command) => command,
        Err(_) => app.shell().command("openwork-server"),
    };

    let args = build_openwork_args(host, port, workspace_path, token, host_token);
    command
        .args(args)
        .current_dir(Path::new(workspace_path))
        .spawn()
        .map_err(|e| format!("Failed to start OpenWork server: {e}"))
}
