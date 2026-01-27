use std::path::Path;

use tauri::AppHandle;
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::paths::{candidate_xdg_config_dirs, candidate_xdg_data_dirs, maybe_infer_xdg_home};

pub fn find_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_engine_args(bind_host: &str, port: u16) -> Vec<String> {
    vec![
        "serve".to_string(),
        "--hostname".to_string(),
        bind_host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--cors".to_string(),
        "http://localhost:5173".to_string(),
        "--cors".to_string(),
        "tauri://localhost".to_string(),
        "--cors".to_string(),
        "http://tauri.localhost".to_string(),
    ]
}

pub fn spawn_engine(
    app: &AppHandle,
    program: &Path,
    hostname: &str,
    port: u16,
    project_dir: &str,
    use_sidecar: bool,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let args = build_engine_args(hostname, port);

    let command = if use_sidecar {
        app
            .shell()
            .sidecar("opencode")
            .map_err(|e| format!("Failed to locate bundled OpenCode sidecar: {e}"))?
    } else {
        app.shell().command(program)
    };

    let mut command = command.args(args).current_dir(project_dir);

    if let Some(xdg_data_home) = maybe_infer_xdg_home(
        "XDG_DATA_HOME",
        candidate_xdg_data_dirs(),
        Path::new("opencode/auth.json"),
    ) {
        command = command.env("XDG_DATA_HOME", xdg_data_home);
    }

    let xdg_config_home = maybe_infer_xdg_home(
        "XDG_CONFIG_HOME",
        candidate_xdg_config_dirs(),
        Path::new("opencode/opencode.jsonc"),
    )
    .or_else(|| {
        maybe_infer_xdg_home(
            "XDG_CONFIG_HOME",
            candidate_xdg_config_dirs(),
            Path::new("opencode/opencode.json"),
        )
    });

    if let Some(xdg_config_home) = xdg_config_home {
        command = command.env("XDG_CONFIG_HOME", xdg_config_home);
    }

    command = command.env("OPENCODE_CLIENT", "openwork");
    command = command.env("OPENWORK", "1");

    command
        .spawn()
        .map_err(|e| format!("Failed to start opencode: {e}"))
}
