use tauri::{AppHandle, Manager, State};

use crate::engine::doctor::{
    opencode_serve_help, opencode_version, resolve_engine_path, resolve_sidecar_candidate,
};
use crate::engine::manager::EngineManager;
use crate::engine::spawn::{find_free_port, spawn_engine};
use crate::types::{EngineDoctorResult, EngineInfo, ExecResult};
use crate::utils::truncate_output;
use tauri_plugin_shell::process::CommandEvent;

#[derive(Default)]
struct OutputState {
    stdout: String,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
}

#[tauri::command]
pub fn engine_info(manager: State<EngineManager>) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_stop(manager: State<EngineManager>) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);
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
    project_dir: String,
    prefer_sidecar: Option<bool>,
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

    let hostname = "127.0.0.1".to_string();
    let port = find_free_port()?;

    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);

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

    let (mut rx, child) =
        spawn_engine(&app, &program, &hostname, port, &project_dir, use_sidecar)?;

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
    state.project_dir = Some(project_dir);
    state.hostname = Some(hostname.clone());
    state.port = Some(port);
    state.base_url = Some(format!("http://{hostname}:{port}"));

    Ok(EngineManager::snapshot_locked(&mut state))
}
