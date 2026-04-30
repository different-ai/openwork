use std::fs;
use std::path::{Path, PathBuf};

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::paths::{candidate_xdg_config_dirs, candidate_xdg_data_dirs, maybe_infer_xdg_home};
use crate::paths::{prepended_path_env, sidecar_path_candidates};

struct DevModePaths {
    home_dir: PathBuf,
    xdg_config_home: PathBuf,
    xdg_data_home: PathBuf,
    xdg_cache_home: PathBuf,
    xdg_state_home: PathBuf,
    opencode_config_dir: PathBuf,
}

const OPENWORK_DEV_DATA_DIR: &str = "openwork-dev-data";

fn resolve_dev_mode_paths(app: &AppHandle) -> Result<DevModePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let root_dir = app_data_dir.join(OPENWORK_DEV_DATA_DIR);

    let paths = DevModePaths {
        home_dir: root_dir.join("home"),
        xdg_config_home: root_dir.join("xdg").join("config"),
        xdg_data_home: root_dir.join("xdg").join("data"),
        xdg_cache_home: root_dir.join("xdg").join("cache"),
        xdg_state_home: root_dir.join("xdg").join("state"),
        opencode_config_dir: root_dir.join("config").join("opencode"),
    };

    for dir in [
        &paths.home_dir,
        &paths.xdg_config_home,
        &paths.xdg_data_home,
        &paths.xdg_cache_home,
        &paths.xdg_state_home,
        &paths.opencode_config_dir,
        &paths.xdg_data_home.join("opencode"),
    ] {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    }

    Ok(paths)
}

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
        // Allow all origins since the engine may be accessed remotely from client
        // devices or from the dev UI running on localhost:5173.
        "--cors".to_string(),
        "*".to_string(),
    ]
}

pub fn spawn_engine(
    app: &AppHandle,
    program: &Path,
    hostname: &str,
    port: u16,
    project_dir: &str,
    use_sidecar: bool,
    dev_mode: bool,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let args = build_engine_args(hostname, port);

    let command = if use_sidecar {
        app.shell()
            .sidecar("opencode")
            .map_err(|e| format!("Failed to locate bundled OpenCode sidecar: {e}"))?
    } else {
        app.shell().command(program)
    };

    let mut command = command.args(args).current_dir(project_dir);

    if dev_mode {
        let dev_paths = resolve_dev_mode_paths(app)?;
        command = command.env("OPENWORK_DEV_MODE", "1");
        command = command.env("OPENCODE_TEST_HOME", &dev_paths.home_dir);
        command = command.env("HOME", dev_paths.home_dir);
        command = command.env("XDG_CONFIG_HOME", dev_paths.xdg_config_home);
        command = command.env("XDG_DATA_HOME", dev_paths.xdg_data_home);
        command = command.env("XDG_CACHE_HOME", dev_paths.xdg_cache_home);
        command = command.env("XDG_STATE_HOME", dev_paths.xdg_state_home);
        command = command.env("OPENCODE_CONFIG_DIR", dev_paths.opencode_config_dir);
    } else {
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
    }

    command = command.env("OPENCODE_CLIENT", "openwork");
    command = command.env("OPENWORK", "1");

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let sidecar_paths =
        sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref());
    if let Some(path_env) = prepended_path_env(&sidecar_paths) {
        command = command.env("PATH", path_env);
    }

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
        .map_err(|e| format!("Failed to start opencode: {e}"))
}
