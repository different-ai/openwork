use std::path::Path;

use tauri::AppHandle;
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub fn build_owpenbot_args(
    workspace_path: &str,
    opencode_url: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["start".to_string(), workspace_path.to_string()];

    if let Some(url) = opencode_url {
        if !url.trim().is_empty() {
            // Set via environment variable instead since CLI doesn't have --opencode-url flag
            // The bridge will use OPENCODE_URL env var
        }
    }

    args
}

pub fn spawn_owpenbot(
    app: &AppHandle,
    workspace_path: &str,
    opencode_url: Option<&str>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let args = build_owpenbot_args(workspace_path, opencode_url);
    
    let mut cmd = command.args(args);
    
    // Pass opencode URL via environment if provided
    if let Some(url) = opencode_url {
        if !url.trim().is_empty() {
            cmd = cmd.env("OPENCODE_URL", url);
        }
    }
    
    // Set the opencode directory
    cmd = cmd.env("OPENCODE_DIRECTORY", workspace_path);
    
    cmd.current_dir(Path::new(workspace_path))
        .spawn()
        .map_err(|e| format!("Failed to start owpenbot: {e}"))
}
