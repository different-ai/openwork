use tauri::{AppHandle, Manager, State};

use crate::config::{read_opencode_config, write_opencode_config};
use crate::engine::doctor::{
    opencode_serve_help, opencode_version, resolve_engine_path, resolve_sidecar_candidate,
};
use crate::engine::manager::EngineManager;
use crate::engine::spawn::{find_free_port, spawn_engine};
use crate::commands::owpenbot::owpenbot_start;
use crate::openwrk::{self, OpenwrkSpawnOptions};
use crate::openwrk::manager::OpenwrkManager;
use crate::openwork_server::{manager::OpenworkServerManager, resolve_connect_url, start_openwork_server};
use crate::owpenbot::manager::OwpenbotManager;
use crate::owpenbot::spawn::resolve_owpenbot_health_port;
use crate::types::{EngineDoctorResult, EngineInfo, EngineRuntime, ExecResult};
use crate::utils::truncate_output;
use serde_json::json;
use tauri_plugin_shell::process::CommandEvent;
use uuid::Uuid;

#[derive(Default)]
struct OutputState {
    stdout: String,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
}

#[tauri::command]
pub fn engine_info(manager: State<EngineManager>, openwrk_manager: State<OpenwrkManager>) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    if state.runtime == EngineRuntime::Openwrk {
        let data_dir = openwrk_manager
            .inner
            .lock()
            .ok()
            .and_then(|state| state.data_dir.clone())
            .unwrap_or_else(openwrk::resolve_openwrk_data_dir);
        let last_stdout = openwrk_manager
            .inner
            .lock()
            .ok()
            .and_then(|state| state.last_stdout.clone());
        let last_stderr = openwrk_manager
            .inner
            .lock()
            .ok()
            .and_then(|state| state.last_stderr.clone());
        let status = openwrk::resolve_openwrk_status(&data_dir, last_stderr.clone());
        let opencode = status.opencode.clone();
        let base_url = opencode
            .as_ref()
            .map(|entry| format!("http://127.0.0.1:{}", entry.port));
        let project_dir = status
            .active_id
            .as_ref()
            .and_then(|active| status.workspaces.iter().find(|ws| &ws.id == active))
            .map(|ws| ws.path.clone())
            .or_else(|| state.project_dir.clone());
        return EngineInfo {
            running: status.running,
            runtime: state.runtime.clone(),
            base_url,
            project_dir,
            hostname: Some("127.0.0.1".to_string()),
            port: opencode.as_ref().map(|entry| entry.port),
            opencode_username: state.opencode_username.clone(),
            opencode_password: state.opencode_password.clone(),
            pid: opencode.as_ref().map(|entry| entry.pid),
            last_stdout,
            last_stderr,
        };
    }
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_stop(
    manager: State<EngineManager>,
    openwrk_manager: State<OpenwrkManager>,
    openwork_manager: State<OpenworkServerManager>,
    owpenbot_manager: State<OwpenbotManager>,
) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    if let Ok(mut openwrk_state) = openwrk_manager.inner.lock() {
        OpenwrkManager::stop_locked(&mut openwrk_state);
    }
    EngineManager::stop_locked(&mut state);
    if let Ok(mut openwork_state) = openwork_manager.inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_state);
    }
    if let Ok(mut owpenbot_state) = owpenbot_manager.inner.lock() {
        OwpenbotManager::stop_locked(&mut owpenbot_state);
    }
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_doctor(app: AppHandle, prefer_sidecar: Option<bool>) -> EngineDoctorResult {
    let prefer_sidecar = prefer_sidecar.unwrap_or(false);
    let resource_dir = app.path().resource_dir().ok();

    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let (resolved, in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );

    let (version, supports_serve, serve_help_status, serve_help_stdout, serve_help_stderr) =
        match resolved.as_ref() {
            Some(path) => {
                let (ok, status, stdout, stderr) = opencode_serve_help(path.as_os_str());
                (
                    opencode_version(path.as_os_str()),
                    ok,
                    status,
                    stdout,
                    stderr,
                )
            }
            None => (None, false, None, None, None),
        };

    EngineDoctorResult {
        found: resolved.is_some(),
        in_path,
        resolved_path: resolved.map(|path| path.to_string_lossy().to_string()),
        version,
        supports_serve,
        notes,
        serve_help_status,
        serve_help_stdout,
        serve_help_stderr,
    }
}

#[tauri::command]
pub fn engine_install() -> Result<ExecResult, String> {
    #[cfg(windows)]
    {
        return Ok(ExecResult {
      ok: false,
      status: -1,
      stdout: String::new(),
      stderr: "Guided install is not supported on Windows yet. Install OpenCode via Scoop/Chocolatey or https://opencode.ai/install, then restart OpenWork.".to_string(),
    });
    }

    #[cfg(not(windows))]
    {
        let install_dir = crate::paths::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".opencode")
            .join("bin");

        let output = std::process::Command::new("bash")
            .arg("-lc")
            .arg("curl -fsSL https://opencode.ai/install | bash")
            .env("OPENCODE_INSTALL_DIR", install_dir)
            .output()
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        let status = output.status.code().unwrap_or(-1);
        Ok(ExecResult {
            ok: output.status.success(),
            status,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

#[tauri::command]
pub fn engine_start(
    app: AppHandle,
    manager: State<EngineManager>,
    openwrk_manager: State<OpenwrkManager>,
    openwork_manager: State<OpenworkServerManager>,
    owpenbot_manager: State<OwpenbotManager>,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
) -> Result<EngineInfo, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    // OpenCode is spawned with `current_dir(project_dir)`. If the user selected a
    // workspace path that doesn't exist yet (common during onboarding), spawning
    // fails with `os error 2`.
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create projectDir directory: {e}"))?;

    let config = read_opencode_config("project", &project_dir)?;
    if !config.exists {
        let content = serde_json::to_string_pretty(&json!({
            "$schema": "https://opencode.ai/config.json",
        }))
        .map_err(|e| format!("Failed to serialize opencode config: {e}"))?;
        let write_result = write_opencode_config("project", &project_dir, &format!("{content}\n"))?;
        if !write_result.ok {
            return Err(write_result.stderr);
        }
    }

    let runtime = runtime.unwrap_or(EngineRuntime::Direct);
    let mut workspace_paths = workspace_paths.unwrap_or_default();
    workspace_paths.retain(|path| !path.trim().is_empty());
    workspace_paths.retain(|path| path.trim() != project_dir);
    workspace_paths.insert(0, project_dir.clone());

    let bind_host = std::env::var("OPENWORK_OPENCODE_BIND_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "0.0.0.0".to_string());
    let client_host = "127.0.0.1".to_string();
    let port = find_free_port()?;
    let enable_auth = std::env::var("OPENWORK_OPENCODE_AUTH")
        .ok()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let opencode_username = if enable_auth {
        Some("opencode".to_string())
    } else {
        None
    };
    let opencode_password = if enable_auth {
        Some(Uuid::new_v4().to_string())
    } else {
        None
    };

    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);
    if let Ok(mut openwrk_state) = openwrk_manager.inner.lock() {
        OpenwrkManager::stop_locked(&mut openwrk_state);
    }
    state.runtime = runtime.clone();

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let prefer_sidecar = prefer_sidecar.unwrap_or(false);
    let (program, _in_path, notes) =
        resolve_engine_path(prefer_sidecar, resource_dir.as_deref(), current_bin_dir.as_deref());
    let Some(program) = program else {
        let notes_text = notes.join("\n");
        return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
    ));
    };

    let (sidecar_candidate, _sidecar_notes) =
        resolve_sidecar_candidate(prefer_sidecar, resource_dir.as_deref(), current_bin_dir.as_deref());
    let use_sidecar = prefer_sidecar
        && sidecar_candidate
            .as_ref()
            .is_some_and(|candidate| candidate == &program);

    if runtime == EngineRuntime::Openwrk {
        drop(state);
        let data_dir = openwrk::resolve_openwrk_data_dir();
        let daemon_port = find_free_port()?;
        let daemon_host = "127.0.0.1".to_string();
        let opencode_bin = program.to_string_lossy().to_string();
        let spawn_options = OpenwrkSpawnOptions {
            data_dir: data_dir.clone(),
            daemon_host: daemon_host.clone(),
            daemon_port,
            opencode_bin,
            opencode_host: bind_host.clone(),
            opencode_workdir: project_dir.clone(),
            opencode_port: None,
            opencode_username: opencode_username.clone(),
            opencode_password: opencode_password.clone(),
            cors: Some("*".to_string()),
        };

        let (mut rx, child) = openwrk::spawn_openwrk_daemon(&app, &spawn_options)?;
        {
            let mut openwrk_state = openwrk_manager
                .inner
                .lock()
                .map_err(|_| "openwrk mutex poisoned".to_string())?;
            openwrk_state.child = Some(child);
            openwrk_state.child_exited = false;
            openwrk_state.data_dir = Some(data_dir.clone());
            openwrk_state.last_stdout = None;
            openwrk_state.last_stderr = None;
        }

        let openwrk_state_handle = openwrk_manager.inner.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes).to_string();
                        if let Ok(mut state) = openwrk_state_handle.try_lock() {
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
                        if let Ok(mut state) = openwrk_state_handle.try_lock() {
                            let next = state
                                .last_stderr
                                .as_deref()
                                .unwrap_or_default()
                                .to_string()
                                + &line;
                            state.last_stderr = Some(truncate_output(&next, 8000));
                        }
                    }
                    CommandEvent::Terminated(_) => {
                        if let Ok(mut state) = openwrk_state_handle.try_lock() {
                            state.child_exited = true;
                        }
                    }
                    CommandEvent::Error(message) => {
                        if let Ok(mut state) = openwrk_state_handle.try_lock() {
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

        let daemon_base_url = format!("http://{}:{}", daemon_host, daemon_port);
        let health = openwrk::wait_for_openwrk(&daemon_base_url, 10_000)
            .map_err(|e| format!("Failed to start openwrk: {e}"))?;
        let opencode = health
            .opencode
            .ok_or_else(|| "Openwrk did not report OpenCode status".to_string())?;
        let opencode_port = opencode.port;
        let opencode_base_url = format!("http://127.0.0.1:{opencode_port}");
        let opencode_connect_url =
            resolve_connect_url(opencode_port).unwrap_or_else(|| opencode_base_url.clone());

        if let Ok(mut state) = manager.inner.lock() {
            state.runtime = EngineRuntime::Openwrk;
            state.child = None;
            state.child_exited = false;
            state.project_dir = Some(project_dir.clone());
            state.hostname = Some("127.0.0.1".to_string());
            state.port = Some(opencode_port);
            state.base_url = Some(opencode_base_url.clone());
            state.opencode_username = opencode_username.clone();
            state.opencode_password = opencode_password.clone();
            state.last_stdout = None;
            state.last_stderr = None;
        }

        let owpenbot_health_port = match resolve_owpenbot_health_port() {
            Ok(port) => Some(port),
            Err(error) => {
                if let Ok(mut state) = manager.inner.lock() {
                    state.last_stderr = Some(truncate_output(&format!("Owpenbot health port: {error}"), 8000));
                }
                None
            }
        };

        if let Err(error) = start_openwork_server(
            &app,
            &openwork_manager,
            &workspace_paths,
            Some(&opencode_connect_url),
            opencode_username.as_deref(),
            opencode_password.as_deref(),
            owpenbot_health_port,
        ) {
            if let Ok(mut state) = manager.inner.lock() {
                state.last_stderr = Some(truncate_output(&format!("OpenWork server: {error}"), 8000));
            }
        }

        if let Err(error) = owpenbot_start(
            app.clone(),
            owpenbot_manager,
            project_dir.clone(),
            Some(opencode_connect_url),
            opencode_username.clone(),
            opencode_password.clone(),
            owpenbot_health_port,
        ) {
            if let Ok(mut state) = manager.inner.lock() {
                state.last_stderr = Some(truncate_output(&format!("Owpenbot: {error}"), 8000));
            }
        }

        return Ok(EngineInfo {
            running: true,
            runtime: EngineRuntime::Openwrk,
            base_url: Some(opencode_base_url),
            project_dir: Some(project_dir),
            hostname: Some("127.0.0.1".to_string()),
            port: Some(opencode_port),
            opencode_username,
            opencode_password,
            pid: Some(opencode.pid),
            last_stdout: None,
            last_stderr: None,
        });
    }

    let (mut rx, child) = spawn_engine(
        &app,
        &program,
        &bind_host,
        port,
        &project_dir,
        use_sidecar,
        opencode_username.as_deref(),
        opencode_password.as_deref(),
    )?;

    state.last_stdout = None;
    state.last_stderr = None;
    state.child_exited = false;

    let output_state = std::sync::Arc::new(std::sync::Mutex::new(OutputState::default()));
    let output_state_handle = output_state.clone();
    let state_handle = manager.inner.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.stdout.push_str(&line);
                    }
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
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.stderr.push_str(&line);
                    }
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
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.exited = true;
                        output.exit_code = payload.code;
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.exited = true;
                        output.exit_code = Some(-1);
                        output.stderr.push_str(&message);
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                    }
                }
                _ => {}
            }
        }
    });

    let warmup_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Ok(output) = output_state.lock() {
            if output.exited {
                let stdout = output.stdout.trim().to_string();
                let stderr = output.stderr.trim().to_string();

                let stdout = if stdout.is_empty() {
                    None
                } else {
                    Some(truncate_output(&stdout, 8000))
                };
                let stderr = if stderr.is_empty() {
                    None
                } else {
                    Some(truncate_output(&stderr, 8000))
                };

                let mut parts = Vec::new();
                if let Some(stdout) = stdout {
                    parts.push(format!("stdout:\n{stdout}"));
                }
                if let Some(stderr) = stderr {
                    parts.push(format!("stderr:\n{stderr}"));
                }

                let suffix = if parts.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{}", parts.join("\n\n"))
                };

                return Err(format!(
                    "OpenCode exited immediately with status {}.{}",
                    output.exit_code.unwrap_or(-1),
                    suffix
                ));
            }
        }

        if std::time::Instant::now() >= warmup_deadline {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    state.child = Some(child);
    state.project_dir = Some(project_dir.clone());
    state.hostname = Some(client_host.clone());
    state.port = Some(port);
    state.base_url = Some(format!("http://{client_host}:{port}"));
    state.opencode_username = opencode_username.clone();
    state.opencode_password = opencode_password.clone();

    let opencode_connect_url = resolve_connect_url(port).unwrap_or_else(|| format!("http://{client_host}:{port}"));
    let owpenbot_health_port = match resolve_owpenbot_health_port() {
        Ok(port) => Some(port),
        Err(error) => {
            state.last_stderr = Some(truncate_output(&format!("Owpenbot health port: {error}"), 8000));
            None
        }
    };

    if let Err(error) = start_openwork_server(
        &app,
        &openwork_manager,
        &workspace_paths,
        Some(&opencode_connect_url),
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        owpenbot_health_port,
    ) {
        state.last_stderr = Some(truncate_output(&format!("OpenWork server: {error}"), 8000));
    }

    if let Err(error) = owpenbot_start(
        app.clone(),
        owpenbot_manager,
        project_dir.clone(),
        Some(opencode_connect_url),
        opencode_username,
        opencode_password,
        owpenbot_health_port,
    ) {
        state.last_stderr = Some(truncate_output(&format!("Owpenbot: {error}"), 8000));
    }

    Ok(EngineManager::snapshot_locked(&mut state))
}
