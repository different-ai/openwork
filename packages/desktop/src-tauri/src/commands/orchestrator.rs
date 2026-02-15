use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

use crate::orchestrator::manager::OrchestratorManager;
use crate::orchestrator::{resolve_orchestrator_data_dir, resolve_orchestrator_status};
use crate::platform::configure_hidden;
use crate::types::{ExecResult, OrchestratorStatus, OrchestratorWorkspace};

const SANDBOX_PROGRESS_EVENT: &str = "openwork://sandbox-create-progress";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDetachedHost {
    pub openwork_url: String,
    pub token: String,
    pub host_token: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_container_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDoctorResult {
    pub installed: bool,
    pub daemon_running: bool,
    pub permission_ok: bool,
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn run_local_command(program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
    let mut command = Command::new(program);
    configure_hidden(&mut command);
    let output = command
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {program}: {e}"))?;
    let status = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((status, stdout, stderr))
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = meta.permissions().mode();
            return (mode & 0o111) != 0;
        }
    }
    true
}

fn parse_path_export_value(output: &str) -> Option<String> {
    // `path_helper -s` prints shell exports, e.g.:
    //   PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH;
    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("PATH=") {
            continue;
        }
        let after = trimmed.strip_prefix("PATH=")?;
        let after = after.trim();
        // Strip leading quote (single or double)
        let quote = after.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let mut value = after[1..].to_string();
        if let Some(end) = value.find(quote) {
            value.truncate(end);
            return Some(value);
        }
    }
    None
}

fn resolve_docker_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    // 1) Explicit override (most reliable in odd environments)
    for key in ["OPENWORK_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"] {
        if let Some(value) = env::var_os(key) {
            let raw = value.to_string_lossy().trim().to_string();
            if !raw.is_empty() {
                let path = PathBuf::from(raw);
                if seen.insert(path.clone()) {
                    out.push(path);
                }
            }
        }
    }

    // 2) PATH from current process
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join("docker");
            if seen.insert(candidate.clone()) {
                out.push(candidate);
            }
        }
    }

    // 3) macOS default login PATH via path_helper
    if cfg!(target_os = "macos") {
        if let Ok((status, stdout, _stderr)) =
            run_local_command("/usr/libexec/path_helper", &["-s"])
        {
            if status == 0 {
                if let Some(path_value) = parse_path_export_value(&stdout) {
                    for dir in env::split_paths(&path_value) {
                        let candidate = dir.join("docker");
                        if seen.insert(candidate.clone()) {
                            out.push(candidate);
                        }
                    }
                }
            }
        }
    }

    // 4) Well-known locations (Homebrew + Docker Desktop)
    for raw in [
        "/opt/homebrew/bin/docker",
        "/usr/local/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ] {
        let path = PathBuf::from(raw);
        if seen.insert(path.clone()) {
            out.push(path);
        }
    }

    // Keep only plausible executable files.
    out.into_iter()
        .filter(|path| is_executable_file(path))
        .collect()
}

fn run_docker_command(args: &[&str]) -> Result<(i32, String, String), String> {
    // On macOS, GUI apps may not inherit the user's shell PATH (e.g. missing /opt/homebrew/bin).
    // We resolve candidates conservatively and prefer an explicit override when provided.
    let candidates = resolve_docker_candidates();

    // As a final fallback, try invoking `docker` by name (in case the OS resolves it differently).
    // This keeps behavior consistent with CLI environments.
    let mut tried: Vec<String> = candidates
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    tried.push("docker".to_string());

    let mut errors: Vec<String> = Vec::new();
    for program in tried {
        match run_local_command(&program, args) {
            Ok(result) => return Ok(result),
            Err(err) => errors.push(err),
        }
    }

    let hint = "Set OPENWORK_DOCKER_BIN (or OPENWRK_DOCKER_BIN) to your docker binary, e.g. /opt/homebrew/bin/docker";
    Err(format!(
        "Failed to run docker: {} ({})",
        errors.join("; "),
        hint
    ))
}

fn parse_docker_client_version(stdout: &str) -> Option<String> {
    // Example: "Docker version 26.1.1, build 4cf5afa"
    let line = stdout.lines().next().unwrap_or("").trim();
    if !line.to_lowercase().starts_with("docker version") {
        return None;
    }
    Some(line.to_string())
}

fn parse_docker_server_version(stdout: &str) -> Option<String> {
    // Example line in `docker info` output: " Server Version: 26.1.1"
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Server Version:") {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn derive_orchestrator_container_name(run_id: &str) -> String {
    // Must match openwork-orchestrator's docker naming scheme:
    // `openwork-orchestrator-${runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 24)}`
    let mut sanitized = String::new();
    for ch in run_id.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-';
        sanitized.push(if ok { ch } else { '-' });
    }
    if sanitized.len() > 24 {
        sanitized.truncate(24);
    }
    format!("openwork-orchestrator-{sanitized}")
}

fn allocate_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to allocate free port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read allocated port: {e}"))?
        .port();
    Ok(port)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_sandbox_progress(
    app: &AppHandle,
    run_id: &str,
    stage: &str,
    message: &str,
    payload: serde_json::Value,
) {
    let event_payload = json!({
        "runId": run_id,
        "stage": stage,
        "message": message,
        "at": now_ms(),
        "payload": payload,
    });
    let _ = app.emit(SANDBOX_PROGRESS_EVENT, event_payload);
}

fn docker_container_state(container_name: &str) -> Result<Option<String>, String> {
    let (status, stdout, stderr) = run_local_command(
        "docker",
        &["inspect", "-f", "{{.State.Status}}", container_name],
    )?;
    if status == 0 {
        let trimmed = stdout.trim().to_string();
        return Ok(if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        });
    }

    let combined = format!("{}\n{}", stdout.trim(), stderr.trim()).to_lowercase();
    if combined.contains("no such object")
        || combined.contains("not found")
        || combined.contains("does not exist")
    {
        return Ok(None);
    }

    // If docker returned something unexpected, don't block progress reporting.
    Ok(None)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorWorkspaceResponse {
    pub workspace: OrchestratorWorkspace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorDisposeResponse {
    pub disposed: bool,
}

fn resolve_data_dir(manager: &OrchestratorManager) -> String {
    manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.data_dir.clone())
        .unwrap_or_else(resolve_orchestrator_data_dir)
}

fn resolve_base_url(manager: &OrchestratorManager) -> Result<String, String> {
    let data_dir = resolve_data_dir(manager);
    let status = resolve_orchestrator_status(&data_dir, None);
    status
        .daemon
        .map(|daemon| daemon.base_url)
        .ok_or_else(|| "orchestrator daemon is not running".to_string())
}

#[tauri::command]
pub fn orchestrator_status(manager: State<OrchestratorManager>) -> OrchestratorStatus {
    let data_dir = resolve_data_dir(&manager);
    let last_error = manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.last_stderr.clone());
    resolve_orchestrator_status(&data_dir, last_error)
}

#[tauri::command]
pub fn orchestrator_workspace_activate(
    manager: State<OrchestratorManager>,
    workspace_path: String,
    name: Option<String>,
) -> Result<OrchestratorWorkspace, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
        "name": name,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to add workspace: {e}"))?;
    let added: OrchestratorWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    let id = added.workspace.id.clone();
    let activate_url = format!(
        "{}/workspaces/{}/activate",
        base_url.trim_end_matches('/'),
        id
    );
    ureq::post(&activate_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to activate workspace: {e}"))?;

    let path_url = format!("{}/workspaces/{}/path", base_url.trim_end_matches('/'), id);
    let _ = ureq::get(&path_url).call();

    Ok(added.workspace)
}

#[tauri::command]
pub fn orchestrator_instance_dispose(
    manager: State<OrchestratorManager>,
    workspace_path: String,
) -> Result<bool, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to ensure workspace: {e}"))?;
    let added: OrchestratorWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    let id = added.workspace.id;
    let dispose_url = format!(
        "{}/instances/{}/dispose",
        base_url.trim_end_matches('/'),
        id
    );
    let response = ureq::post(&dispose_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to dispose instance: {e}"))?;
    let result: OrchestratorDisposeResponse = response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    Ok(result.disposed)
}

#[tauri::command]
pub fn orchestrator_start_detached(
    app: AppHandle,
    workspace_path: String,
    sandbox_backend: Option<String>,
    run_id: Option<String>,
) -> Result<OrchestratorDetachedHost, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let sandbox_backend = sandbox_backend
        .unwrap_or_else(|| "none".to_string())
        .trim()
        .to_lowercase();
    let wants_docker_sandbox = sandbox_backend == "docker";
    let sandbox_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let sandbox_container_name = if wants_docker_sandbox {
        Some(derive_orchestrator_container_name(&sandbox_run_id))
    } else {
        None
    };

    let port = allocate_free_port()?;
    let token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let openwork_url = format!("http://127.0.0.1:{port}");

    emit_sandbox_progress(
        &app,
        &sandbox_run_id,
        "init",
        "Starting sandbox...",
        json!({
            "workspacePath": workspace_path,
            "openworkUrl": openwork_url,
            "port": port,
            "sandboxBackend": if wants_docker_sandbox { "docker" } else { "none" },
            "containerName": sandbox_container_name,
        }),
    );

    let command = match app.shell().sidecar("openwork-orchestrator") {
        Ok(command) => command,
        Err(_) => app.shell().command("openwork"),
    };

    // Start a dedicated host stack for this workspace.
    // We pass explicit tokens and a free port so the UI can connect deterministically.
    {
        let mut args: Vec<String> = vec![
            "start".to_string(),
            "--workspace".to_string(),
            workspace_path.clone(),
            "--approval".to_string(),
            "auto".to_string(),
            "--no-opencode-auth".to_string(),
            "--opencode-router".to_string(),
            "true".to_string(),
            "--detach".to_string(),
            "--openwork-host".to_string(),
            "0.0.0.0".to_string(),
            "--openwork-port".to_string(),
            port.to_string(),
            "--openwork-token".to_string(),
            token.clone(),
            "--openwork-host-token".to_string(),
            host_token.clone(),
            "--run-id".to_string(),
            sandbox_run_id.clone(),
        ];

        if wants_docker_sandbox {
            args.push("--sandbox".to_string());
            args.push("docker".to_string());
        }

        // Convert to &str for the shell command builder.
        let mut str_args: Vec<&str> = Vec::with_capacity(args.len());
        for arg in &args {
            str_args.push(arg.as_str());
        }

        command
            .args(str_args)
            .spawn()
            .map_err(|e| format!("Failed to start openwork orchestrator: {e}"))?;
    }

    emit_sandbox_progress(
        &app,
        &sandbox_run_id,
        "spawned",
        "Sandbox process launched. Waiting for OpenWork server...",
        json!({
            "openworkUrl": openwork_url,
        }),
    );

    let health_timeout_ms = if wants_docker_sandbox { 90_000 } else { 12_000 };
    let start = Instant::now();
    let mut last_tick = Instant::now() - Duration::from_secs(5);
    let mut last_container_check = Instant::now() - Duration::from_secs(10);
    let mut last_container_state: Option<String> = None;
    let mut last_error: Option<String> = None;

    while start.elapsed() < Duration::from_millis(health_timeout_ms) {
        let elapsed_ms = start.elapsed().as_millis() as u64;

        if wants_docker_sandbox {
            if last_container_check.elapsed() > Duration::from_millis(1500) {
                last_container_check = Instant::now();
                if let Some(name) = sandbox_container_name.as_deref() {
                    if let Ok(state) = docker_container_state(name) {
                        if state != last_container_state {
                            last_container_state = state.clone();
                            let label = state.clone().unwrap_or_else(|| "not-created".to_string());
                            emit_sandbox_progress(
                                &app,
                                &sandbox_run_id,
                                "docker.container",
                                &format!("Sandbox container: {label}"),
                                json!({
                                    "containerName": name,
                                    "containerState": state,
                                    "elapsedMs": elapsed_ms,
                                }),
                            );
                        }
                    }
                }
            }
        }

        match ureq::get(&format!("{}/health", openwork_url.trim_end_matches('/'))).call() {
            Ok(response) if response.status() >= 200 && response.status() < 300 => {
                emit_sandbox_progress(
                    &app,
                    &sandbox_run_id,
                    "openwork.healthy",
                    "OpenWork server is ready.",
                    json!({
                        "openworkUrl": openwork_url,
                        "elapsedMs": elapsed_ms,
                        "containerState": last_container_state,
                    }),
                );
                last_error = None;
                break;
            }
            Ok(response) => {
                last_error = Some(format!("HTTP {}", response.status()));
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }

        if last_tick.elapsed() > Duration::from_millis(850) {
            last_tick = Instant::now();
            emit_sandbox_progress(
                &app,
                &sandbox_run_id,
                "openwork.waiting",
                "Waiting for OpenWork server...",
                json!({
                    "openworkUrl": openwork_url,
                    "elapsedMs": elapsed_ms,
                    "lastError": last_error,
                    "containerState": last_container_state,
                }),
            );
        }

        std::thread::sleep(Duration::from_millis(200));
    }

    if start.elapsed() >= Duration::from_millis(health_timeout_ms) {
        let message =
            last_error.unwrap_or_else(|| "Timed out waiting for OpenWork server".to_string());
        emit_sandbox_progress(
            &app,
            &sandbox_run_id,
            "error",
            "Sandbox failed to start.",
            json!({
                "error": message,
                "elapsedMs": start.elapsed().as_millis() as u64,
                "openworkUrl": openwork_url,
                "containerState": last_container_state,
            }),
        );
        return Err(message);
    }

    Ok(OrchestratorDetachedHost {
        openwork_url,
        token,
        host_token,
        port,
        sandbox_backend: if wants_docker_sandbox {
            Some("docker".to_string())
        } else {
            None
        },
        sandbox_run_id: if wants_docker_sandbox {
            Some(sandbox_run_id)
        } else {
            None
        },
        sandbox_container_name,
    })
}

#[tauri::command]
pub fn sandbox_doctor() -> SandboxDoctorResult {
    let (status, stdout, stderr) = match run_docker_command(&["--version"]) {
        Ok(result) => result,
        Err(err) => {
            return SandboxDoctorResult {
                installed: false,
                daemon_running: false,
                permission_ok: false,
                ready: false,
                client_version: None,
                server_version: None,
                error: Some(err),
            };
        }
    };

    if status != 0 {
        return SandboxDoctorResult {
            installed: false,
            daemon_running: false,
            permission_ok: false,
            ready: false,
            client_version: None,
            server_version: None,
            error: Some(format!(
                "docker --version failed (status {status}): {}",
                stderr.trim()
            )),
        };
    }

    let client_version = parse_docker_client_version(&stdout);

    // `docker info` is a good readiness check (installed + daemon reachable + perms).
    let (info_status, info_stdout, info_stderr) = match run_docker_command(&["info"]) {
        Ok(result) => result,
        Err(err) => {
            return SandboxDoctorResult {
                installed: true,
                daemon_running: false,
                permission_ok: false,
                ready: false,
                client_version,
                server_version: None,
                error: Some(err),
            };
        }
    };

    if info_status == 0 {
        let server_version = parse_docker_server_version(&info_stdout);
        return SandboxDoctorResult {
            installed: true,
            daemon_running: true,
            permission_ok: true,
            ready: true,
            client_version,
            server_version,
            error: None,
        };
    }

    let combined = format!("{}\n{}", info_stdout.trim(), info_stderr.trim())
        .trim()
        .to_string();
    let lower = combined.to_lowercase();
    let permission_ok = !lower.contains("permission denied")
        && !lower.contains("got permission denied")
        && !lower.contains("access is denied");
    let daemon_running = !lower.contains("cannot connect to the docker daemon")
        && !lower.contains("is the docker daemon running")
        && !lower.contains("error during connect")
        && !lower.contains("connection refused")
        && !lower.contains("failed to connect to the docker api")
        && !lower.contains("dial unix")
        && !lower.contains("connect: no such file or directory")
        && !lower.contains("no such file or directory");

    SandboxDoctorResult {
        installed: true,
        daemon_running,
        permission_ok,
        ready: false,
        client_version,
        server_version: None,
        error: Some(if combined.is_empty() {
            format!("docker info failed (status {info_status})")
        } else {
            combined
        }),
    }
}

#[tauri::command]
pub fn sandbox_stop(container_name: String) -> Result<ExecResult, String> {
    let name = container_name.trim().to_string();
    if name.is_empty() {
        return Err("containerName is required".to_string());
    }
    if !name.starts_with("openwork-orchestrator-") {
        return Err(
            "Refusing to stop container: expected name starting with 'openwork-orchestrator-'"
                .to_string(),
        );
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
    {
        return Err("containerName contains invalid characters".to_string());
    }

    let (status, stdout, stderr) = run_docker_command(&["stop", &name])?;
    Ok(ExecResult {
        ok: status == 0,
        status,
        stdout,
        stderr,
    })
}
