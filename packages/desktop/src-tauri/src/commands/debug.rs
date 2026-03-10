use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use std::fs;
use std::path::{Path, PathBuf};

const DEBUG_ROOT_DIR: &str = "debug-logs";
const DEBUG_SESSIONS_DIR: &str = "sessions";
const DEBUG_ACTIVE_FILE: &str = "active-session.json";

const DEBUG_MANIFEST_FILE: &str = "debug-session.json";
const DEBUG_SUMMARY_FILE: &str = "summary.json";
const DEBUG_TIMELINE_FILE: &str = "timeline.jsonl";
const DEBUG_SYSTEM_FILE: &str = "system.jsonl";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionRetention {
    pub max_timeline_bytes: u64,
    pub max_system_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionFileLayout {
    pub root_dir: String,
    pub manifest_file: String,
    pub summary_file: String,
    pub timeline_file: String,
    pub system_file: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionManifest {
    pub id: String,
    pub started_at: String,
    pub started_ts: i64,
    pub app_version: Option<String>,
    pub environment: Option<String>,
    pub file_layout: DebugSessionFileLayout,
    pub retention: DebugSessionRetention,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionStartInput {
    pub session_id: String,
    pub started_at: String,
    pub started_ts: i64,
    pub app_version: Option<String>,
    pub environment: Option<String>,
    pub retention: DebugSessionRetention,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionStartResult {
    pub manifest: DebugSessionManifest,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionAppendInput {
    pub session_id: String,
    pub target: String,
    pub line: String,
    pub max_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionAppendResult {
    pub ok: bool,
    pub appended: bool,
    pub truncated: bool,
    pub bytes_written: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionActiveMarker {
    pub id: String,
    pub root_dir: String,
    pub started_at: String,
    pub started_ts: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DebugSystemEventInput {
    pub surface: String,
    pub action: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub stdout_excerpt: Option<String>,
    pub stderr_excerpt: Option<String>,
    pub payload: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DebugSystemEvent {
    kind: String,
    id: String,
    at: String,
    ts: i64,
    debug_session_id: String,
    correlation_id: Option<String>,
    surface: String,
    action: String,
    command: String,
    status: String,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    stdout_excerpt: Option<String>,
    stderr_excerpt: Option<String>,
    payload: Option<serde_json::Value>,
}

fn resolve_debug_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(data_dir.join(DEBUG_ROOT_DIR))
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "".to_string())
}

fn now_ms() -> i64 {
    let now = std::time::SystemTime::now();
    match now.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

fn read_active_marker(app: &AppHandle) -> Result<Option<DebugSessionActiveMarker>, String> {
    let root = resolve_debug_root(app)?;
    let active_path = root.join(DEBUG_ACTIVE_FILE);
    if !active_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&active_path)
        .map_err(|e| format!("Failed to read {}: {e}", active_path.display()))?;
    let marker = serde_json::from_str::<DebugSessionActiveMarker>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", active_path.display()))?;
    Ok(Some(marker))
}

fn append_json_line(path: &Path, value: &impl Serialize) -> Result<(), String> {
    ensure_parent(path)?;
    let payload = serde_json::to_string(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    use std::io::Write;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("Failed to append {}: {e}", path.display()))?;
    Ok(())
}

fn truncate_excerpt(value: Option<String>) -> Option<String> {
    value.map(|raw| {
        let max = 2000usize;
        if raw.len() <= max {
            raw
        } else {
            format!("{}...", &raw[..max])
        }
    })
}

pub fn record_system_event(app: &AppHandle, input: DebugSystemEventInput) -> Result<(), String> {
    let marker = match read_active_marker(app)? {
        Some(marker) => marker,
        None => return Ok(()),
    };

    let system_path = PathBuf::from(&marker.root_dir).join(DEBUG_SYSTEM_FILE);
    let event = DebugSystemEvent {
        kind: "system".to_string(),
        id: format!("evt_{}", Uuid::new_v4()),
        at: now_iso(),
        ts: now_ms(),
        debug_session_id: marker.id,
        correlation_id: None,
        surface: input.surface,
        action: input.action,
        command: input.command,
        status: input.status,
        exit_code: input.exit_code,
        duration_ms: input.duration_ms,
        stdout_excerpt: truncate_excerpt(input.stdout_excerpt),
        stderr_excerpt: truncate_excerpt(input.stderr_excerpt),
        payload: input.payload,
    };

    append_json_line(&system_path, &event)
}

fn sanitize_session_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };

        if normalized == '-' {
            if last_dash {
                continue;
            }
            out.push('-');
            last_dash = true;
            continue;
        }

        out.push(normalized);
        last_dash = false;
    }

    out.trim_matches('-').to_string()
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
    }
    Ok(())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    ensure_parent(path)?;
    let payload = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    fs::write(path, payload).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn touch_file(path: &Path) -> Result<(), String> {
    ensure_parent(path)?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    Ok(())
}

fn resolve_session_file(root: &Path, session_id: &str, target: &str) -> Result<PathBuf, String> {
    let sessions_dir = root.join(DEBUG_SESSIONS_DIR);
    let clean_id = sanitize_session_id(session_id);
    if clean_id.is_empty() {
        return Err("session_id is required".to_string());
    }
    let session_dir = sessions_dir.join(clean_id);
    let file_name = match target {
        "timeline" => DEBUG_TIMELINE_FILE,
        "system" => DEBUG_SYSTEM_FILE,
        _ => return Err("target must be 'timeline' or 'system'".to_string()),
    };
    Ok(session_dir.join(file_name))
}

#[tauri::command]
pub fn debug_session_start(
    app: AppHandle,
    input: DebugSessionStartInput,
) -> Result<DebugSessionStartResult, String> {
    let root = resolve_debug_root(&app)?;
    let sessions_dir = root.join(DEBUG_SESSIONS_DIR);
    let clean_id = sanitize_session_id(&input.session_id);
    let session_id = if clean_id.is_empty() {
        format!("dbg-{}", Uuid::new_v4())
    } else {
        clean_id
    };

    let session_dir = sessions_dir.join(&session_id);
    fs::create_dir_all(&session_dir)
        .map_err(|e| format!("Failed to create {}: {e}", session_dir.display()))?;

    let manifest_path = session_dir.join(DEBUG_MANIFEST_FILE);
    let summary_path = session_dir.join(DEBUG_SUMMARY_FILE);
    let timeline_path = session_dir.join(DEBUG_TIMELINE_FILE);
    let system_path = session_dir.join(DEBUG_SYSTEM_FILE);

    let file_layout = DebugSessionFileLayout {
        root_dir: session_dir.to_string_lossy().to_string(),
        manifest_file: manifest_path.to_string_lossy().to_string(),
        summary_file: summary_path.to_string_lossy().to_string(),
        timeline_file: timeline_path.to_string_lossy().to_string(),
        system_file: system_path.to_string_lossy().to_string(),
    };

    let manifest = DebugSessionManifest {
        id: session_id.clone(),
        started_at: input.started_at,
        started_ts: input.started_ts,
        app_version: input.app_version,
        environment: input.environment,
        file_layout: file_layout.clone(),
        retention: input.retention,
    };

    write_json(&manifest_path, &manifest)?;
    write_json(&summary_path, &serde_json::json!({}))?;
    touch_file(&timeline_path)?;
    touch_file(&system_path)?;

    let active_marker = DebugSessionActiveMarker {
        id: session_id,
        root_dir: file_layout.root_dir.clone(),
        started_at: manifest.started_at.clone(),
        started_ts: manifest.started_ts,
    };
    let active_path = root.join(DEBUG_ACTIVE_FILE);
    write_json(&active_path, &active_marker)?;

    Ok(DebugSessionStartResult { manifest })
}

#[tauri::command]
pub fn debug_session_stop(app: AppHandle) -> Result<(), String> {
    debug_session_clear_active(app)
}

#[tauri::command]
pub fn debug_session_clear_active(app: AppHandle) -> Result<(), String> {
    let root = resolve_debug_root(&app)?;
    let active_path = root.join(DEBUG_ACTIVE_FILE);
    if active_path.exists() {
        fs::remove_file(&active_path)
            .map_err(|e| format!("Failed to remove {}: {e}", active_path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn debug_session_append(
    app: AppHandle,
    input: DebugSessionAppendInput,
) -> Result<DebugSessionAppendResult, String> {
    let root = resolve_debug_root(&app)?;
    let target = input.target.trim();
    let line = input.line;
    if line.is_empty() {
        return Ok(DebugSessionAppendResult {
            ok: true,
            appended: false,
            truncated: false,
            bytes_written: 0,
        });
    }

    let file_path = resolve_session_file(&root, &input.session_id, target)?;
    ensure_parent(&file_path)?;

    let current_size = fs::metadata(&file_path).map(|meta| meta.len()).unwrap_or(0);
    let line_bytes = line.as_bytes().len() as u64 + 1;
    if input.max_bytes > 0 && current_size.saturating_add(line_bytes) > input.max_bytes {
        return Ok(DebugSessionAppendResult {
            ok: true,
            appended: false,
            truncated: true,
            bytes_written: 0,
        });
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open {}: {e}", file_path.display()))?;

    use std::io::Write;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("Failed to append {}: {e}", file_path.display()))?;

    Ok(DebugSessionAppendResult {
        ok: true,
        appended: true,
        truncated: false,
        bytes_written: line_bytes,
    })
}
