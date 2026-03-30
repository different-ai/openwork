use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
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
    pub owner_token: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<SandboxDoctorDebug>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDoctorDebug {
    pub candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_command: Option<SandboxDoctorCommandDebug>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info_command: Option<SandboxDoctorCommandDebug>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDoctorCommandDebug {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

struct DockerCommandResult {
    status: i32,
    stdout: String,
    stderr: String,
    program: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenworkDockerCleanupResult {
    pub candidates: Vec<String>,
    pub removed: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDebugProbeCleanup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_name: Option<String>,
    pub container_removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_result: Option<SandboxDoctorCommandDebug>,
    pub workspace_removed: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDebugProbeResult {
    pub started_at: u64,
    pub finished_at: u64,
    pub run_id: String,
    pub workspace_path: String,
    pub ready: bool,
    pub doctor: SandboxDoctorResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_host: Option<OrchestratorDetachedHost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker_inspect: Option<SandboxDoctorCommandDebug>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker_logs: Option<SandboxDoctorCommandDebug>,
    pub cleanup: SandboxDebugProbeCleanup,
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

/// Maximum time to wait for pipe reader threads to complete after child termination.
/// This bounds the join operation to prevent indefinite blocking.
const READER_JOIN_TIMEOUT_MS: u64 = 2000;

fn recv_pipe_bytes(label: &str, rx: &mpsc::Receiver<Vec<u8>>, deadline: Instant) -> Vec<u8> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match rx.recv_timeout(remaining) {
        Ok(bytes) => bytes,
        Err(RecvTimeoutError::Timeout) => {
            eprintln!(
                "[timeout-helper] {label} reader timed out after {}ms",
                remaining.as_millis()
            );
            Vec::new()
        }
        Err(RecvTimeoutError::Disconnected) => {
            eprintln!("[timeout-helper] {label} reader disconnected");
            Vec::new()
        }
    }
}

fn run_local_command_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    let mut command = Command::new(program);
    configure_hidden(&mut command);
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {program}: {e}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    // Use channels to collect output with bounded wait on join.
    // This prevents indefinite blocking if pipe readers don't complete.
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut reader) = stdout_pipe.take() {
            let _ = reader.read_to_end(&mut buf);
        }
        let _ = stdout_tx.send(buf);
    });

    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut reader) = stderr_pipe.take() {
            let _ = reader.read_to_end(&mut buf);
        }
        let _ = stderr_tx.send(buf);
    });

    let poll = Duration::from_millis(25);
    let start = Instant::now();
    let mut timed_out = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let join_timeout = Duration::from_millis(READER_JOIN_TIMEOUT_MS);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status);
                break;
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    eprintln!(
                        "[timeout-helper] Killing {program} after {}ms timeout",
                        timeout.as_millis()
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(poll);
            }
            Err(err) => {
                eprintln!("[timeout-helper] Error waiting for {program}: {err}");
                let _ = child.kill();
                let _ = child.wait();
                let join_deadline = Instant::now() + join_timeout;
                let stdout_bytes = recv_pipe_bytes("stdout", &stdout_rx, join_deadline);
                let stderr_bytes = recv_pipe_bytes("stderr", &stderr_rx, join_deadline);
                let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
                let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
                return Err(format!(
                    "Failed to wait for {program}: {err} (stdout: {}, stderr: {})",
                    stdout.trim(),
                    stderr.trim()
                ));
            }
        }
    }

    // Wait for reader threads with bounded timeout.
    // This prevents indefinite blocking in edge cases where pipe readers stall.
    let join_deadline = Instant::now() + join_timeout;
    let stdout_bytes = recv_pipe_bytes("stdout", &stdout_rx, join_deadline);
    let stderr_bytes = recv_pipe_bytes("stderr", &stderr_rx, join_deadline);

    // Detach the thread handles (they will finish or be leaked, but won't block us)
    drop(stdout_handle);
    drop(stderr_handle);

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    if timed_out {
        let arg_list = args.join(" ");
        eprintln!(
            "[timeout-helper] Command timed out: {program} {arg_list} (stdout: {} bytes, stderr: {} bytes)",
            stdout.len(),
            stderr.len()
        );
        return Err(format!(
            "Timed out after {}ms running {program} {arg_list}",
            timeout.as_millis()
        ));
    }

    let status = exit_status.and_then(|s| s.code()).unwrap_or(-1);
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

fn run_docker_command(args: &[&str], timeout: Duration) -> Result<(i32, String, String), String> {
    let result = run_docker_command_detailed(args, timeout)?;
    Ok((result.status, result.stdout, result.stderr))
}

fn run_docker_command_detailed(
    args: &[&str],
    timeout: Duration,
) -> Result<DockerCommandResult, String> {
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
        match run_local_command_with_timeout(&program, args, timeout) {
            Ok((status, stdout, stderr)) => {
                return Ok(DockerCommandResult {
                    status,
                    stdout,
                    stderr,
                    program,
                })
            }
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

fn truncate_for_debug(input: &str) -> String {
    const MAX_LEN: usize = 1200;
    let trimmed = input.trim();
    if trimmed.len() <= MAX_LEN {
        return trimmed.to_string();
    }
    format!("{}...[truncated]", &trimmed[..MAX_LEN])
}

fn truncate_for_report(input: &str) -> String {
    const MAX_LEN: usize = 48_000;
    let trimmed = input.trim();
    if trimmed.len() <= MAX_LEN {
        return trimmed.to_string();
    }
    format!("{}...[truncated]", &trimmed[..MAX_LEN])
}

fn is_sensitive_progress_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "token"
            | "hosttoken"
            | "ownertoken"
            | "collaboratortoken"
            | "password"
            | "opencodepassword"
            | "opencodeusername"
            | "authorization"
    ) || ((key.starts_with("OPENWORK_") || key.starts_with("OPENCODE_") || key.starts_with("DEN_"))
        && (key.contains("TOKEN") || key.contains("PASSWORD") || key.contains("USERNAME")))
}

fn redact_progress_value(value: serde_json::Value, key: Option<&str>) -> serde_json::Value {
    if let Some(key) = key {
        if is_sensitive_progress_key(key) {
            return serde_json::Value::String("[REDACTED]".to_string());
        }
    }

    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(entry_key, entry_value)| {
                    let redacted = redact_progress_value(entry_value, Some(&entry_key));
                    (entry_key, redacted)
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| redact_progress_value(item, key))
                .collect(),
        ),
        serde_json::Value::String(text) => serde_json::Value::String(text),
        other => other,
    }
}

fn to_command_debug(result: DockerCommandResult) -> SandboxDoctorCommandDebug {
    SandboxDoctorCommandDebug {
        status: result.status,
        stdout: truncate_for_report(&result.stdout),
        stderr: truncate_for_report(&result.stderr),
    }
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

fn is_openwork_managed_container(name: &str) -> bool {
    name.starts_with("openwork-orchestrator-")
        || name.starts_with("openwork-dev-")
        || name.starts_with("openwrk-")
}

fn list_openwork_managed_containers() -> Result<Vec<String>, String> {
    let (status, stdout, stderr) = run_docker_command(
        &["ps", "-a", "--format", "{{.Names}}"],
        Duration::from_secs(8),
    )?;
    if status != 0 {
        let combined = format!("{}\n{}", stdout.trim(), stderr.trim())
            .trim()
            .to_string();
        let detail = if combined.is_empty() {
            format!("docker ps -a failed (status {status})")
        } else {
            format!("docker ps -a failed (status {status}): {combined}")
        };
        return Err(detail);
    }

    let mut names: Vec<String> = stdout
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|name| !name.is_empty() && is_openwork_managed_container(name))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
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
    let payload = redact_progress_value(payload, None);
    let at = now_ms();
    let elapsed = payload
        .get("elapsedMs")
        .and_then(|value| value.as_u64())
        .map(|value| format!("{value}ms"))
        .unwrap_or_else(|| "n/a".to_string());
    let payload_brief = truncate_for_debug(&payload.to_string());
    eprintln!(
        "[sandbox-create][at={at}][runId={run_id}][stage={stage}][elapsed={elapsed}] {message} payload={payload_brief}"
    );
    let event_payload = json!({
        "runId": run_id,
        "stage": stage,
        "message": message,
        "at": at,
        "payload": payload,
    });
    let _ = app.emit(SANDBOX_PROGRESS_EVENT, event_payload);
}

fn docker_container_state(container_name: &str) -> Result<Option<String>, String> {
    let result = match run_docker_command_detailed(
        &["inspect", "-f", "{{.State.Status}}", container_name],
        Duration::from_secs(2),
    ) {
        Ok(result) => result,
        Err(err) => {
            return Err(format!("docker inspect failed: {err}"));
        }
    };
    let status = result.status;
    let stdout = result.stdout;
    let stderr = result.stderr;
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
    Err(format!(
        "docker inspect {} returned status {} (stderr: {})",
        result.program,
        status,
        truncate_for_debug(&stderr)
    ))
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

fn format_sandbox_start_timeout_error(
    elapsed_ms: u64,
    openwork_url: &str,
    last_error: Option<&str>,
    container_state: Option<&str>,
    container_probe_error: Option<&str>,
) -> String {
    let mut details = vec![
        format!("stage=openwork.healthcheck"),
        format!("elapsed_ms={elapsed_ms}"),
        format!("url={openwork_url}"),
        format!("last_error={}", last_error.unwrap_or("none")),
        format!("container_state={}", container_state.unwrap_or("unknown")),
    ];

    if let Some(probe_error) = container_probe_error {
        details.push(format!("container_probe_error={probe_error}"));
    }

    format!(
        "Timed out waiting for OpenWork server ({})",
        details.join(", ")
    )
}

fn issue_owner_token(openwork_url: &str, host_token: &str) -> Result<String, String> {
    let response = ureq::post(&format!("{}/tokens", openwork_url.trim_end_matches('/')))
        .set("X-OpenWork-Host-Token", host_token)
        .set("Content-Type", "application/json")
        .send_string(r#"{"scope":"owner","label":"OpenWork detached owner token"}"#)
        .map_err(|err| err.to_string())?;

    let payload: Value = response
        .into_json()
        .map_err(|err| format!("Failed to parse owner token response: {err}"))?;

    payload
        .get("token")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OpenWork server did not return an owner token".to_string())
}

#[tauri::command]
pub fn orchestrator_start_detached(
    app: AppHandle,
    workspace_path: String,
    sandbox_backend: Option<String>,
    run_id: Option<String>,
    openwork_token: Option<String>,
    openwork_host_token: Option<String>,
) -> Result<OrchestratorDetachedHost, String> {
    let start_ts = now_ms();
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
    eprintln!(
        "[sandbox-create][at={start_ts}][runId={}][stage=entry] workspacePath={} sandboxBackend={} container={}",
        sandbox_run_id,
        workspace_path,
        if wants_docker_sandbox { "docker" } else { "none" },
        sandbox_container_name.as_deref().unwrap_or("<none>")
    );

    let port = allocate_free_port()?;
    let token = openwork_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let host_token = openwork_host_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
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

    if wants_docker_sandbox {
        let candidates = resolve_docker_candidates()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let resolved = candidates.first().cloned();
        emit_sandbox_progress(
            &app,
            &sandbox_run_id,
            "docker.config",
            "Inspecting Docker configuration...",
            json!({
                "candidateCount": candidates.len(),
                "resolvedDockerBin": resolved,
                "hasOpenworkDockerBinOverride": env::var("OPENWORK_DOCKER_BIN").ok().is_some(),
                "hasOpenwrkDockerBinOverride": env::var("OPENWRK_DOCKER_BIN").ok().is_some(),
                "hasDockerBinOverride": env::var("DOCKER_BIN").ok().is_some(),
            }),
        );
    }

    let (command, command_label) = match app.shell().sidecar("openwork-orchestrator") {
        Ok(command) => (command, "sidecar:openwork-orchestrator".to_string()),
        Err(_) => (app.shell().command("openwork"), "path:openwork".to_string()),
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
            "--opencode-router".to_string(),
            "true".to_string(),
            "--detach".to_string(),
            "--openwork-port".to_string(),
            port.to_string(),
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

        emit_sandbox_progress(
            &app,
            &sandbox_run_id,
            "spawn.config",
            "Launching sandbox host...",
            json!({
                "command": command_label,
                "workspacePath": workspace_path,
                "openworkUrl": openwork_url,
                "argCount": args.len(),
                "hasDockerOverrides": env::var("OPENWORK_DOCKER_BIN").ok().is_some()
                    || env::var("OPENWRK_DOCKER_BIN").ok().is_some()
                    || env::var("DOCKER_BIN").ok().is_some(),
            }),
        );

        if let Err(err) = command
            .args(str_args)
            .env("OPENWORK_TOKEN", token.clone())
            .env("OPENWORK_HOST_TOKEN", host_token.clone())
            .spawn()
        {
            emit_sandbox_progress(
                &app,
                &sandbox_run_id,
                "spawn.error",
                "Failed to launch sandbox host.",
                json!({
                    "error": err.to_string(),
                    "command": command_label,
                }),
            );
            return Err(format!("Failed to start openwork orchestrator: {err}"));
        }
        eprintln!(
            "[sandbox-create][at={}][runId={}][stage=spawn] launched openwork sidecar for detached sandbox host",
            now_ms(),
            sandbox_run_id
        );
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
    let mut last_container_probe_error: Option<String> = None;
    let mut last_error: Option<String> = None;

    while start.elapsed() < Duration::from_millis(health_timeout_ms) {
        let elapsed_ms = start.elapsed().as_millis() as u64;

        if wants_docker_sandbox {
            if last_container_check.elapsed() > Duration::from_millis(1500) {
                last_container_check = Instant::now();
                if let Some(name) = sandbox_container_name.as_deref() {
                    match docker_container_state(name) {
                        Ok(state) => {
                            if state != last_container_state {
                                last_container_state = state.clone();
                                let label =
                                    state.clone().unwrap_or_else(|| "not-created".to_string());
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
                            if last_container_probe_error.is_some() {
                                last_container_probe_error = None;
                            }
                        }
                        Err(err) => {
                            if last_container_probe_error.as_deref() != Some(err.as_str()) {
                                last_container_probe_error = Some(err.clone());
                                emit_sandbox_progress(
                                    &app,
                                    &sandbox_run_id,
                                    "docker.inspect",
                                    "Docker inspect returned an error while probing sandbox container.",
                                    json!({
                                        "containerName": name,
                                        "error": err,
                                        "elapsedMs": elapsed_ms,
                                    }),
                                );
                            }
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
                    "containerProbeError": last_container_probe_error,
                }),
            );
        }

        std::thread::sleep(Duration::from_millis(200));
    }

    if start.elapsed() >= Duration::from_millis(health_timeout_ms) {
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let message = format_sandbox_start_timeout_error(
            elapsed_ms,
            &openwork_url,
            last_error.as_deref(),
            last_container_state.as_deref(),
            last_container_probe_error.as_deref(),
        );
        emit_sandbox_progress(
            &app,
            &sandbox_run_id,
            "error",
            "Sandbox failed to start.",
            json!({
                "error": message,
                "elapsedMs": elapsed_ms,
                "openworkUrl": openwork_url,
                "containerState": last_container_state,
                "containerProbeError": last_container_probe_error,
            }),
        );
        eprintln!(
            "[sandbox-create][at={}][runId={}][stage=timeout] health wait timed out after {}ms error={}",
            now_ms(),
            sandbox_run_id,
            elapsed_ms,
            message
        );
        return Err(message);
    }

    eprintln!(
        "[sandbox-create][at={}][runId={}][stage=complete] detached sandbox host ready in {}ms url={}",
        now_ms(),
        sandbox_run_id,
        start.elapsed().as_millis(),
        openwork_url
    );

    let owner_token = issue_owner_token(&openwork_url, &host_token).ok();

    Ok(OrchestratorDetachedHost {
        openwork_url,
        token,
        owner_token,
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
    let doctor_start = Instant::now();
    eprintln!("[sandbox-doctor][at={}] start", now_ms());
    let candidates = resolve_docker_candidates()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let mut debug = SandboxDoctorDebug {
        candidates,
        selected_bin: None,
        version_command: None,
        info_command: None,
    };

    let version = match run_docker_command_detailed(&["--version"], Duration::from_secs(2)) {
        Ok(result) => result,
        Err(err) => {
            eprintln!(
                "[sandbox-doctor][at={}][elapsed={}ms] docker --version failed: {}",
                now_ms(),
                doctor_start.elapsed().as_millis(),
                err
            );
            return SandboxDoctorResult {
                installed: false,
                daemon_running: false,
                permission_ok: false,
                ready: false,
                client_version: None,
                server_version: None,
                error: Some(err),
                debug: Some(debug),
            };
        }
    };

    debug.selected_bin = Some(version.program.clone());
    eprintln!(
        "[sandbox-doctor][at={}][elapsed={}ms] docker --version via {} status={}",
        now_ms(),
        doctor_start.elapsed().as_millis(),
        version.program,
        version.status
    );
    debug.version_command = Some(SandboxDoctorCommandDebug {
        status: version.status,
        stdout: truncate_for_debug(&version.stdout),
        stderr: truncate_for_debug(&version.stderr),
    });

    let status = version.status;
    let stdout = version.stdout;
    let stderr = version.stderr;

    if status != 0 {
        eprintln!(
            "[sandbox-doctor][at={}][elapsed={}ms] docker --version non-zero status={} stderr={}",
            now_ms(),
            doctor_start.elapsed().as_millis(),
            status,
            truncate_for_debug(&stderr)
        );
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
            debug: Some(debug),
        };
    }

    let client_version = parse_docker_client_version(&stdout);

    // `docker info` is a good readiness check (installed + daemon reachable + perms).
    let info = match run_docker_command_detailed(&["info"], Duration::from_secs(8)) {
        Ok(result) => result,
        Err(err) => {
            eprintln!(
                "[sandbox-doctor][at={}][elapsed={}ms] docker info failed: {}",
                now_ms(),
                doctor_start.elapsed().as_millis(),
                err
            );
            return SandboxDoctorResult {
                installed: true,
                daemon_running: false,
                permission_ok: false,
                ready: false,
                client_version,
                server_version: None,
                error: Some(err),
                debug: Some(debug),
            };
        }
    };

    debug.info_command = Some(SandboxDoctorCommandDebug {
        status: info.status,
        stdout: truncate_for_debug(&info.stdout),
        stderr: truncate_for_debug(&info.stderr),
    });
    eprintln!(
        "[sandbox-doctor][at={}][elapsed={}ms] docker info status={}",
        now_ms(),
        doctor_start.elapsed().as_millis(),
        info.status
    );

    let info_status = info.status;
    let info_stdout = info.stdout;
    let info_stderr = info.stderr;

    if info_status == 0 {
        let server_version = parse_docker_server_version(&info_stdout);
        eprintln!(
            "[sandbox-doctor][at={}][elapsed={}ms] ready=true serverVersion={}",
            now_ms(),
            doctor_start.elapsed().as_millis(),
            server_version.as_deref().unwrap_or("<unknown>")
        );
        return SandboxDoctorResult {
            installed: true,
            daemon_running: true,
            permission_ok: true,
            ready: true,
            client_version,
            server_version,
            error: None,
            debug: Some(debug),
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
        debug: Some(debug),
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

    let (status, stdout, stderr) = run_docker_command(&["stop", &name], Duration::from_secs(15))?;
    Ok(ExecResult {
        ok: status == 0,
        status,
        stdout,
        stderr,
    })
}

#[tauri::command]
pub fn sandbox_cleanup_openwork_containers() -> Result<OpenworkDockerCleanupResult, String> {
    let candidates = list_openwork_managed_containers()?;
    if candidates.is_empty() {
        return Ok(OpenworkDockerCleanupResult {
            candidates,
            removed: Vec::new(),
            errors: Vec::new(),
        });
    }

    let mut removed = Vec::new();
    let mut errors = Vec::new();

    for name in &candidates {
        match run_docker_command(&["rm", "-f", name.as_str()], Duration::from_secs(20)) {
            Ok((status, stdout, stderr)) => {
                if status == 0 {
                    removed.push(name.clone());
                } else {
                    let combined = format!("{}\n{}", stdout.trim(), stderr.trim())
                        .trim()
                        .to_string();
                    let detail = if combined.is_empty() {
                        format!("exit {status}")
                    } else {
                        format!("exit {status}: {}", truncate_for_debug(&combined))
                    };
                    errors.push(format!("{name}: {detail}"));
                }
            }
            Err(err) => errors.push(format!("{name}: {err}")),
        }
    }

    Ok(OpenworkDockerCleanupResult {
        candidates,
        removed,
        errors,
    })
}

#[tauri::command]
pub fn sandbox_debug_probe(app: AppHandle) -> SandboxDebugProbeResult {
    let started_at = now_ms();
    let run_id = format!("probe-{}", Uuid::new_v4());
    let workspace_dir = env::temp_dir().join(format!("openwork-sandbox-probe-{}", Uuid::new_v4()));
    let workspace_path = workspace_dir.to_string_lossy().to_string();

    let mut cleanup_errors: Vec<String> = Vec::new();
    let mut workspace_removed = false;

    if let Err(err) = std::fs::create_dir_all(&workspace_dir) {
        return SandboxDebugProbeResult {
            started_at,
            finished_at: now_ms(),
            run_id,
            workspace_path,
            ready: false,
            doctor: sandbox_doctor(),
            detached_host: None,
            docker_inspect: None,
            docker_logs: None,
            cleanup: SandboxDebugProbeCleanup {
                container_name: None,
                container_removed: false,
                remove_result: None,
                workspace_removed,
                errors: vec![format!("Failed to create probe workspace: {err}")],
            },
            error: Some(format!("Failed to create sandbox probe workspace: {err}")),
        };
    }

    let doctor = sandbox_doctor();
    let mut detached_host: Option<OrchestratorDetachedHost> = None;
    let mut docker_inspect: Option<SandboxDoctorCommandDebug> = None;
    let mut docker_logs: Option<SandboxDoctorCommandDebug> = None;
    let mut error: Option<String> = None;

    if doctor.ready {
        match orchestrator_start_detached(
            app,
            workspace_path.clone(),
            Some("docker".to_string()),
            Some(run_id.clone()),
            None,
            None,
        ) {
            Ok(host) => {
                let container_name = host
                    .sandbox_container_name
                    .clone()
                    .unwrap_or_else(|| derive_orchestrator_container_name(&run_id));

                match run_docker_command_detailed(
                    &["inspect", container_name.as_str()],
                    Duration::from_secs(6),
                ) {
                    Ok(result) => {
                        docker_inspect = Some(to_command_debug(result));
                    }
                    Err(err) => {
                        cleanup_errors.push(format!("docker inspect failed: {err}"));
                    }
                }

                match run_docker_command_detailed(
                    &[
                        "logs",
                        "--timestamps",
                        "--tail",
                        "400",
                        container_name.as_str(),
                    ],
                    Duration::from_secs(8),
                ) {
                    Ok(result) => {
                        docker_logs = Some(to_command_debug(result));
                    }
                    Err(err) => {
                        cleanup_errors.push(format!("docker logs failed: {err}"));
                    }
                }

                detached_host = Some(host);
            }
            Err(err) => {
                error = Some(format!("Sandbox probe failed to start: {err}"));
            }
        }
    } else {
        error = Some(
            doctor
                .error
                .as_deref()
                .unwrap_or("Docker is not ready for sandbox creation")
                .to_string(),
        );
    }

    let container_name = detached_host
        .as_ref()
        .and_then(|host| host.sandbox_container_name.clone())
        .or_else(|| {
            if doctor.ready {
                Some(derive_orchestrator_container_name(&run_id))
            } else {
                None
            }
        });

    let mut container_removed = false;
    let mut remove_result: Option<SandboxDoctorCommandDebug> = None;

    if let Some(name) = container_name.clone() {
        match run_docker_command_detailed(&["rm", "-f", name.as_str()], Duration::from_secs(20)) {
            Ok(result) => {
                container_removed = result.status == 0;
                remove_result = Some(to_command_debug(result));
            }
            Err(err) => {
                cleanup_errors.push(format!("docker rm -f {name} failed: {err}"));
            }
        }
    }

    if let Err(err) = std::fs::remove_dir_all(&workspace_dir) {
        cleanup_errors.push(format!("Failed to remove probe workspace: {err}"));
    } else {
        workspace_removed = true;
    }

    let ready = doctor.ready && error.is_none();
    SandboxDebugProbeResult {
        started_at,
        finished_at: now_ms(),
        run_id,
        workspace_path,
        ready,
        doctor,
        detached_host,
        docker_inspect,
        docker_logs,
        cleanup: SandboxDebugProbeCleanup {
            container_name,
            container_removed,
            remove_result,
            workspace_removed,
            errors: cleanup_errors,
        },
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: String) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }

        fn unset(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        fs::write(path, contents).expect("write script");
        let mut perms = fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("chmod");
    }

    #[test]
    #[cfg(unix)]
    fn docker_command_falls_back_after_timeout() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let tmp =
            std::env::temp_dir().join(format!("openwork-docker-timeout-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).expect("create tmp dir");

        let slow = tmp.join("slow-docker");
        let fast = tmp.join("docker");

        write_executable(&slow, "#!/bin/sh\nexec /bin/sleep 5\n");
        write_executable(
            &fast,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 0.0.0, build test"
  exit 0
fi
if [ "$1" = "info" ]; then
  echo "Server Version: 0.0.0"
  exit 0
fi
exit 0
"#,
        );

        let _path = EnvGuard::set("PATH", tmp.to_string_lossy().to_string());
        let _docker = EnvGuard::set("OPENWORK_DOCKER_BIN", slow.to_string_lossy().to_string());
        let _docker_alt = EnvGuard::unset("OPENWRK_DOCKER_BIN");
        let _docker_bin = EnvGuard::unset("DOCKER_BIN");

        let (status, stdout, _stderr) =
            run_docker_command(&["--version"], Duration::from_millis(300))
                .expect("docker --version");
        assert_eq!(status, 0);
        assert!(stdout.contains("Docker version 0.0.0"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    #[cfg(unix)]
    fn local_command_timeout_returns_when_descendant_keeps_pipe_open() {
        let tmp =
            std::env::temp_dir().join(format!("openwork-timeout-pipe-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).expect("create tmp dir");

        let pid_file = tmp.join("descendant.pid");
        let sticky = tmp.join("sticky-command");
        write_executable(
            &sticky,
            &format!(
                "#!/bin/sh\nsleep 20 &\necho $! > \"{}\"\nexec /bin/sleep 20\n",
                pid_file.display()
            ),
        );

        let start = Instant::now();
        let result = run_local_command_with_timeout(
            sticky.to_str().expect("sticky-command path"),
            &["--version"],
            Duration::from_millis(300),
        );
        let elapsed = start.elapsed();

        assert!(result.is_err());
        assert!(
            elapsed < Duration::from_millis(3_500),
            "expected bounded timeout, got {elapsed:?}"
        );

        if let Ok(pid) = fs::read_to_string(&pid_file) {
            let _ = std::process::Command::new("kill")
                .args(["-9", pid.trim()])
                .status();
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sandbox_start_timeout_error_includes_stage_diagnostics() {
        let message = format_sandbox_start_timeout_error(
            90_000,
            "http://127.0.0.1:43210",
            Some("Connection refused (os error 61)"),
            Some("created"),
            Some("No such container"),
        );

        assert!(message.contains("stage=openwork.healthcheck"));
        assert!(message.contains("elapsed_ms=90000"));
        assert!(message.contains("url=http://127.0.0.1:43210"));
        assert!(message.contains("last_error=Connection refused (os error 61)"));
        assert!(message.contains("container_state=created"));
        assert!(message.contains("container_probe_error=No such container"));
    }

    #[test]
    #[cfg(unix)]
    fn sandbox_doctor_uses_override_docker_bin() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let tmp =
            std::env::temp_dir().join(format!("openwork-docker-doctor-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).expect("create tmp dir");

        let fast = tmp.join("docker");
        write_executable(
            &fast,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 0.0.0, build test"
  exit 0
fi
if [ "$1" = "info" ]; then
  echo "Server Version: 0.0.0"
  exit 0
fi
exit 0
"#,
        );

        let _path = EnvGuard::set("PATH", tmp.to_string_lossy().to_string());
        let _docker = EnvGuard::set("OPENWORK_DOCKER_BIN", fast.to_string_lossy().to_string());
        let _docker_alt = EnvGuard::unset("OPENWRK_DOCKER_BIN");
        let _docker_bin = EnvGuard::unset("DOCKER_BIN");

        let result = sandbox_doctor();
        assert!(result.installed);
        assert!(result.ready);
        assert_eq!(result.server_version.as_deref(), Some("0.0.0"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
