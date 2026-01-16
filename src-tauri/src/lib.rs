use std::{
  collections::hash_map::DefaultHasher,
  env,
  ffi::OsStr,
  fs,
  hash::{Hash, Hasher},
  net::TcpListener,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::Mutex,
  time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Default)]
struct EngineManager {
  inner: Mutex<EngineState>,
}

#[derive(Default)]
struct EngineState {
  child: Option<Child>,
  project_dir: Option<String>,
  hostname: Option<String>,
  port: Option<u16>,
  base_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
  pub running: bool,
  pub base_url: Option<String>,
  pub project_dir: Option<String>,
  pub hostname: Option<String>,
  pub port: Option<u16>,
  pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineDoctorResult {
  pub found: bool,
  pub in_path: bool,
  pub resolved_path: Option<String>,
  pub version: Option<String>,
  pub supports_serve: bool,
  pub notes: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
  pub ok: bool,
  pub status: i32,
  pub stdout: String,
  pub stderr: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeConfigFile {
  pub path: String,
  pub exists: bool,
  pub content: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterEnvironment {
  pub supported: bool,
  pub reason: Option<String>,
  pub executable_path: Option<String>,
  pub app_bundle_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
  pub id: String,
  pub name: String,
  pub path: String,
  pub preset: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
  pub active_id: String,
  pub workspaces: Vec<WorkspaceInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStateV1 {
  active_id: String,
  workspaces: Vec<WorkspaceInfo>,
}

impl Default for WorkspaceStateV1 {
  fn default() -> Self {
    Self {
      active_id: "starter".to_string(),
      workspaces: Vec::new(),
    }
  }
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn stable_workspace_id(path: &str) -> String {
  let mut hasher = DefaultHasher::new();
  path.hash(&mut hasher);
  format!("ws_{:x}", hasher.finish())
}

fn openwork_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
  let app_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

  let state_dir = app_dir.join("state");
  let file_path = state_dir.join("workspaces.json");

  Ok((state_dir, file_path))
}

fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceStateV1, String> {
  let (_dir, path) = openwork_state_paths(app)?;

  if !path.exists() {
    return Ok(WorkspaceStateV1::default());
  }

  let raw = fs::read_to_string(&path)
    .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
  serde_json::from_str::<WorkspaceStateV1>(&raw)
    .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn save_workspace_state(app: &tauri::AppHandle, state: &WorkspaceStateV1) -> Result<(), String> {
  let (dir, path) = openwork_state_paths(app)?;
  fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

  let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
  fs::write(&path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
  Ok(())
}

fn ensure_starter_workspace(app: &tauri::AppHandle) -> Result<WorkspaceInfo, String> {
  let app_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

  let starter_path = app_dir.join("workspaces").join("starter");

  fs::create_dir_all(&starter_path)
    .map_err(|e| format!("Failed to create starter workspace: {e}"))?;

  let id = "starter".to_string();

  Ok(WorkspaceInfo {
    id,
    name: "Starter Workspace".to_string(),
    path: starter_path.to_string_lossy().to_string(),
    preset: "starter".to_string(),
  })
}


#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
  pub active_id: String,
  pub workspaces: Vec<WorkspaceInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStateV1 {
  active_id: String,
  workspaces: Vec<WorkspaceInfo>,
}

impl Default for WorkspaceStateV1 {
  fn default() -> Self {
    Self {
      active_id: "starter".to_string(),
      workspaces: Vec::new(),
    }
  }
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn stable_workspace_id(path: &str) -> String {
  let mut hasher = DefaultHasher::new();
  path.hash(&mut hasher);
  format!("ws_{:x}", hasher.finish())
}

fn openwork_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
  let app_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

  let state_dir = app_dir.join("state");
  let file_path = state_dir.join("workspaces.json");

  Ok((state_dir, file_path))
}

fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceStateV1, String> {
  let (_dir, path) = openwork_state_paths(app)?;

  if !path.exists() {
    return Ok(WorkspaceStateV1::default());
  }

  let raw = fs::read_to_string(&path)
    .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
  serde_json::from_str::<WorkspaceStateV1>(&raw)
    .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn save_workspace_state(app: &tauri::AppHandle, state: &WorkspaceStateV1) -> Result<(), String> {
  let (dir, path) = openwork_state_paths(app)?;
  fs::create_dir_all(&dir)
    .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

  let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
  fs::write(&path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
  Ok(())
}

fn ensure_starter_workspace(app: &tauri::AppHandle) -> Result<WorkspaceInfo, String> {
  let app_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

  let starter_path = app_dir
    .join("workspaces")
    .join("starter");

  fs::create_dir_all(&starter_path)
    .map_err(|e| format!("Failed to create starter workspace: {e}"))?;

  let id = "starter".to_string();

  Ok(WorkspaceInfo {
    id,
    name: "Starter Workspace".to_string(),
    path: starter_path.to_string_lossy().to_string(),
    preset: "starter".to_string(),
  })
}

fn merge_plugins(existing: Vec<String>, required: &[&str]) -> Vec<String> {
  let mut next = existing;
  for plugin in required {
    if !next.iter().any(|p| p == plugin) {
      next.push(plugin.to_string());
    }
  }
  next
}

fn ensure_workspace_files(workspace_path: &str, preset: &str) -> Result<(), String> {
  let root = PathBuf::from(workspace_path);

  fs::create_dir_all(root.join(".opencode").join("skill"))
    .map_err(|e| format!("Failed to create .opencode/skill: {e}"))?;

  let config_path = root.join("opencode.json");
  let mut config: serde_json::Value = if config_path.exists() {
    let raw = fs::read_to_string(&config_path)
      .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
    serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
  } else {
    serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    })
  };

  if !config.is_object() {
    config = serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    });
  }

  let required_plugins: Vec<&str> = match preset {
    "starter" => vec!["opencode-scheduler"],
    "automation" => vec!["opencode-scheduler"],
    _ => vec![],
  };

  if !required_plugins.is_empty() {
    let plugins_value = config
      .get("plugin")
      .cloned()
      .unwrap_or_else(|| serde_json::json!([]));

    let existing_plugins: Vec<String> = match plugins_value {
      serde_json::Value::Array(arr) => arr
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect(),
      serde_json::Value::String(s) => vec![s],
      _ => vec![],
    };

    let merged = merge_plugins(existing_plugins, &required_plugins);
    if let Some(obj) = config.as_object_mut() {
      obj.insert(
        "plugin".to_string(),
        serde_json::Value::Array(merged.into_iter().map(serde_json::Value::String).collect()),
      );
    }
  }

  fs::write(&config_path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
    .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;

  let openwork_path = root.join(".opencode").join("openwork.json");
  if !openwork_path.exists() {
    let openwork = serde_json::json!({
      "version": 1,
      "workspace": {
        "name": root
          .file_name()
          .and_then(|s| s.to_str())
          .unwrap_or("Workspace"),
        "createdAt": now_ms(),
        "preset": preset
      },
      "authorizedRoots": [workspace_path],
      "templates": {
        "workspace": []
      }
    });

    fs::create_dir_all(openwork_path.parent().unwrap())
      .map_err(|e| format!("Failed to create {}: {e}", openwork_path.display()))?;

    fs::write(
      &openwork_path,
      serde_json::to_string_pretty(&openwork).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;
  }

  Ok(())
}

#[tauri::command]
fn workspace_bootstrap(app: tauri::AppHandle) -> Result<WorkspaceList, String> {
  let mut state = load_workspace_state(&app)?;

  // Ensure starter workspace always exists.
  let starter = ensure_starter_workspace(&app)?;
  ensure_workspace_files(&starter.path, &starter.preset)?;

  if !state.workspaces.iter().any(|w| w.id == starter.id) {
    state.workspaces.push(starter.clone());
  }

  if state.active_id.trim().is_empty() {
    state.active_id = starter.id.clone();
  }

  if !state.workspaces.iter().any(|w| w.id == state.active_id) {
    state.active_id = starter.id.clone();
  }

  save_workspace_state(&app, &state)?;

  Ok(WorkspaceList {
    active_id: state.active_id,
    workspaces: state.workspaces,
  })
}

#[tauri::command]
fn workspace_set_active(app: tauri::AppHandle, workspace_id: String) -> Result<WorkspaceList, String> {
  let mut state = load_workspace_state(&app)?;
  let id = workspace_id.trim();

  if id.is_empty() {
    return Err("workspaceId is required".to_string());
  }

  if !state.workspaces.iter().any(|w| w.id == id) {
    return Err("Unknown workspaceId".to_string());
  }

  state.active_id = id.to_string();
  save_workspace_state(&app, &state)?;

  Ok(WorkspaceList {
    active_id: state.active_id,
    workspaces: state.workspaces,
  })
}

#[tauri::command]
fn workspace_create(
  app: tauri::AppHandle,
  folder_path: String,
  name: String,
  preset: String,
) -> Result<WorkspaceList, String> {
  let folder = folder_path.trim().to_string();
  if folder.is_empty() {
    return Err("folderPath is required".to_string());
  }

  let workspace_name = name.trim().to_string();
  if workspace_name.is_empty() {
    return Err("name is required".to_string());
  }

  let preset = preset.trim().to_string();
  let preset = if preset.is_empty() { "starter".to_string() } else { preset };

  fs::create_dir_all(&folder)
    .map_err(|e| format!("Failed to create workspace folder: {e}"))?;

  let id = stable_workspace_id(&folder);

  ensure_workspace_files(&folder, &preset)?;

  let mut state = load_workspace_state(&app)?;

  // Replace existing entry with same id.
  state.workspaces.retain(|w| w.id != id);
  state.workspaces.push(WorkspaceInfo {
    id: id.clone(),
    name: workspace_name,
    path: folder,
    preset,
  });

  state.active_id = id;
  save_workspace_state(&app, &state)?;

  Ok(WorkspaceList {
    active_id: state.active_id,
    workspaces: state.workspaces,
  })
}

#[tauri::command]
fn workspace_add_authorized_root(
  _app: tauri::AppHandle,
  workspace_path: String,
  folder_path: String,
) -> Result<ExecResult, String> {
  let workspace_path = workspace_path.trim().to_string();
  let folder_path = folder_path.trim().to_string();

  if workspace_path.is_empty() {
    return Err("workspacePath is required".to_string());
  }
  if folder_path.is_empty() {
    return Err("folderPath is required".to_string());
  }

  let openwork_path = PathBuf::from(&workspace_path)
    .join(".opencode")
    .join("openwork.json");

  let raw = fs::read_to_string(&openwork_path)
    .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

  let mut doc: serde_json::Value = serde_json::from_str(&raw)
    .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))?;

  if !doc.is_object() {
    doc = serde_json::json!({});
  }

  let roots = doc
    .get("authorizedRoots")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default();

  let mut next: Vec<String> = roots
    .into_iter()
    .filter_map(|v| v.as_str().map(|s| s.to_string()))
    .collect();

  if !next.iter().any(|p| p == &folder_path) {
    next.push(folder_path);
  }

  if let Some(obj) = doc.as_object_mut() {
    obj.insert(
      "authorizedRoots".to_string(),
      serde_json::Value::Array(next.into_iter().map(serde_json::Value::String).collect()),
    );
  }

  fs::write(&openwork_path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?)
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: "Updated authorizedRoots".to_string(),
    stderr: String::new(),
  })
}

fn find_free_port() -> Result<u16, String> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  Ok(port)
}

#[cfg(windows)]
const OPENCODE_EXECUTABLE: &str = "opencode.exe";

#[cfg(not(windows))]
const OPENCODE_EXECUTABLE: &str = "opencode";

fn home_dir() -> Option<PathBuf> {
  if let Ok(home) = env::var("HOME") {
    if !home.trim().is_empty() {
      return Some(PathBuf::from(home));
    }
  }

  if let Ok(profile) = env::var("USERPROFILE") {
    if !profile.trim().is_empty() {
      return Some(PathBuf::from(profile));
    }
  }

  None
}

fn path_entries() -> Vec<PathBuf> {
  let mut entries = Vec::new();
  let Some(path) = env::var_os("PATH") else {
    return entries;
  };

  entries.extend(env::split_paths(&path));
  entries
}

fn resolve_in_path(name: &str) -> Option<PathBuf> {
  for dir in path_entries() {
    let candidate = dir.join(name);
    if candidate.is_file() {
      return Some(candidate);
    }
  }
  None
}

fn candidate_opencode_paths() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  if let Some(home) = home_dir() {
    candidates.push(home.join(".opencode").join("bin").join(OPENCODE_EXECUTABLE));
  }

  // Homebrew default paths.
  candidates.push(PathBuf::from("/opt/homebrew/bin").join(OPENCODE_EXECUTABLE));
  candidates.push(PathBuf::from("/usr/local/bin").join(OPENCODE_EXECUTABLE));

  // Common Linux paths.
  candidates.push(PathBuf::from("/usr/bin").join(OPENCODE_EXECUTABLE));
  candidates.push(PathBuf::from("/usr/local/bin").join(OPENCODE_EXECUTABLE));

  candidates
}

fn opencode_version(program: &OsStr) -> Option<String> {
  let output = Command::new(program).arg("--version").output().ok()?;
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

  if !stdout.is_empty() {
    return Some(stdout);
  }
  if !stderr.is_empty() {
    return Some(stderr);
  }

  None
}

fn opencode_supports_serve(program: &OsStr) -> bool {
  Command::new(program)
    .arg("serve")
    .arg("--help")
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn resolve_opencode_executable() -> (Option<PathBuf>, bool, Vec<String>) {
  let mut notes = Vec::new();

  // Prefer explicit override.
  if let Ok(custom) = env::var("OPENCODE_BIN_PATH") {
    let custom = custom.trim();
    if !custom.is_empty() {
      let candidate = PathBuf::from(custom);
      if candidate.is_file() {
        notes.push(format!("Using OPENCODE_BIN_PATH: {}", candidate.display()));
        return (Some(candidate), false, notes);
      }
      notes.push(format!("OPENCODE_BIN_PATH set but missing: {}", candidate.display()));
    }
  }

  if let Some(path) = resolve_in_path(OPENCODE_EXECUTABLE) {
    notes.push(format!("Found in PATH: {}", path.display()));
    return (Some(path), true, notes);
  }

  notes.push("Not found on PATH".to_string());

  for candidate in candidate_opencode_paths() {
    if candidate.is_file() {
      notes.push(format!("Found at {}", candidate.display()));
      return (Some(candidate), false, notes);
    }

    notes.push(format!("Missing: {}", candidate.display()));
  }

  (None, false, notes)
}

fn run_capture_optional(command: &mut Command) -> Result<Option<ExecResult>, String> {
  match command.output() {
    Ok(output) => {
      let status = output.status.code().unwrap_or(-1);
      Ok(Some(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
      }))
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!(
      "Failed to run {}: {e}",
      command.get_program().to_string_lossy()
    )),
  }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
  if !src.is_dir() {
    return Err(format!("Source is not a directory: {}", src.display()));
  }

  fs::create_dir_all(dest).map_err(|e| format!("Failed to create dir {}: {e}", dest.display()))?;

  for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))? {
    let entry = entry.map_err(|e| e.to_string())?;
    let file_type = entry.file_type().map_err(|e| e.to_string())?;

    let from = entry.path();
    let to = dest.join(entry.file_name());

    if file_type.is_dir() {
      copy_dir_recursive(&from, &to)?;
      continue;
    }

    if file_type.is_file() {
      fs::copy(&from, &to)
        .map_err(|e| format!("Failed to copy {} -> {}: {e}", from.display(), to.display()))?;
      continue;
    }

    // Skip symlinks and other non-regular entries.
  }

  Ok(())
}

fn is_mac_dmg_or_translocated(path: &Path) -> bool {
  let path_str = path.to_string_lossy();
  path_str.contains("/Volumes/") || path_str.contains("AppTranslocation")
}

#[tauri::command]
fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
  let executable_path = std::env::current_exe().ok();

  let app_bundle_path = executable_path
    .as_ref()
    .and_then(|exe| exe.parent())
    .and_then(|p| p.parent())
    .and_then(|p| p.parent())
    .map(|p| p.to_path_buf());

  let mut supported = true;
  let mut reason: Option<String> = None;

  if let Some(exe) = executable_path.as_ref() {
    if is_mac_dmg_or_translocated(exe) {
      supported = false;
      reason = Some(
        "OpenWork is running from a mounted disk image. Install it to Applications to enable updates."
          .to_string(),
      );
    }
  }

  if supported {
    if let Some(bundle) = app_bundle_path.as_ref() {
      if is_mac_dmg_or_translocated(bundle) {
        supported = false;
        reason = Some(
          "OpenWork is running from a mounted disk image. Install it to Applications to enable updates."
            .to_string(),
        );
      }
    }
  }

  UpdaterEnvironment {
    supported,
    reason,
    executable_path: executable_path.map(|p| p.to_string_lossy().to_string()),
    app_bundle_path: app_bundle_path.map(|p| p.to_string_lossy().to_string()),
  }
}

fn resolve_opencode_config_path(scope: &str, project_dir: &str) -> Result<PathBuf, String> {
  match scope {
    "project" => {
      if project_dir.trim().is_empty() {
        return Err("projectDir is required".to_string());
      }
      Ok(PathBuf::from(project_dir).join("opencode.json"))
    }
    "global" => {
      let base = if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
        PathBuf::from(dir)
      } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home).join(".config")
      } else {
        return Err("Unable to resolve config directory".to_string());
      };

      Ok(base.join("opencode").join("opencode.json"))
    }
    _ => Err("scope must be 'project' or 'global'".to_string()),
  }
}

impl EngineManager {
  fn snapshot_locked(state: &mut EngineState) -> EngineInfo {
    let (running, pid) = match state.child.as_mut() {
      None => (false, None),
      Some(child) => match child.try_wait() {
        Ok(Some(_status)) => {
          // Process exited.
          state.child = None;
          (false, None)
        }
        Ok(None) => (true, Some(child.id())),
        Err(_) => (true, Some(child.id())),
      },
    };

    EngineInfo {
      running,
      base_url: state.base_url.clone(),
      project_dir: state.project_dir.clone(),
      hostname: state.hostname.clone(),
      port: state.port,
      pid,
    }
  }

  fn stop_locked(state: &mut EngineState) {
    if let Some(mut child) = state.child.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
    state.base_url = None;
    state.project_dir = None;
    state.hostname = None;
    state.port = None;
  }
}

#[tauri::command]
fn engine_info(manager: State<EngineManager>) -> EngineInfo {
  let mut state = manager.inner.lock().expect("engine mutex poisoned");
  EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
fn engine_stop(manager: State<EngineManager>) -> EngineInfo {
  let mut state = manager.inner.lock().expect("engine mutex poisoned");
  EngineManager::stop_locked(&mut state);
  EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
fn engine_doctor() -> EngineDoctorResult {
  let (resolved, in_path, notes) = resolve_opencode_executable();

  let (version, supports_serve) = match resolved.as_ref() {
    Some(path) => (
      opencode_version(path.as_os_str()),
      opencode_supports_serve(path.as_os_str()),
    ),
    None => (None, false),
  };

  EngineDoctorResult {
    found: resolved.is_some(),
    in_path,
    resolved_path: resolved.map(|path| path.to_string_lossy().to_string()),
    version,
    supports_serve,
    notes,
  }
}

#[tauri::command]
fn engine_install() -> Result<ExecResult, String> {
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
    let install_dir = home_dir()
      .unwrap_or_else(|| PathBuf::from("."))
      .join(".opencode")
      .join("bin");

    let output = Command::new("bash")
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
fn engine_start(
  manager: State<EngineManager>,
  project_dir: String,
  prefer_sidecar: Option<bool>,
) -> Result<EngineInfo, String> {
  let project_dir = project_dir.trim().to_string();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let hostname = "127.0.0.1".to_string();
  let port = find_free_port()?;

  let mut state = manager.inner.lock().expect("engine mutex poisoned");

  // Stop any existing engine first.
  EngineManager::stop_locked(&mut state);

  let mut notes = Vec::new();

  let resolved_sidecar = if prefer_sidecar.unwrap_or(false) {
    #[cfg(not(windows))]
    {
      // Best-effort: if we eventually bundle a binary, it will likely live here.
      let candidate = PathBuf::from("src-tauri/sidecars").join(OPENCODE_EXECUTABLE);
      if candidate.is_file() {
        notes.push(format!("Using bundled sidecar: {}", candidate.display()));
        Some(candidate)
      } else {
        notes.push(format!(
          "Sidecar requested but missing: {}",
          candidate.display()
        ));
        None
      }
    }
    #[cfg(windows)]
    {
      notes.push("Sidecar requested but unsupported on Windows".to_string());
      None
    }
  } else {
    None
  };

  let (program, _in_path, more_notes) = match resolved_sidecar {
    Some(path) => (Some(path), false, Vec::new()),
    None => resolve_opencode_executable(),
  };

  notes.extend(more_notes);
  let Some(program) = program else {
    let notes_text = notes.join("\n");
    return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
    ));
  };

  let mut command = Command::new(&program);
  command
    .arg("serve")
    .arg("--hostname")
    .arg(&hostname)
    .arg("--port")
    .arg(port.to_string())
    // Allow the Vite dev server origin, plus common Tauri origins.
    .arg("--cors")
    .arg("http://localhost:5173")
    .arg("--cors")
    .arg("tauri://localhost")
    .arg("--cors")
    .arg("http://tauri.localhost")
    .current_dir(&project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  let child = command
    .spawn()
    .map_err(|e| format!("Failed to start opencode: {e}"))?;

  state.child = Some(child);
  state.project_dir = Some(project_dir);
  state.hostname = Some(hostname.clone());
  state.port = Some(port);
  state.base_url = Some(format!("http://{hostname}:{port}"));

  Ok(EngineManager::snapshot_locked(&mut state))
}

#[tauri::command]
fn opkg_install(project_dir: String, package: String) -> Result<ExecResult, String> {
  let project_dir = project_dir.trim().to_string();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let package = package.trim().to_string();
  if package.is_empty() {
    return Err("package is required".to_string());
  }

  let mut opkg = Command::new("opkg");
  opkg
    .arg("install")
    .arg(&package)
    .current_dir(&project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(result) = run_capture_optional(&mut opkg)? {
    return Ok(result);
  }

  let mut openpackage = Command::new("openpackage");
  openpackage
    .arg("install")
    .arg(&package)
    .current_dir(&project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(result) = run_capture_optional(&mut openpackage)? {
    return Ok(result);
  }

  let mut pnpm = Command::new("pnpm");
  pnpm
    .arg("dlx")
    .arg("opkg")
    .arg("install")
    .arg(&package)
    .current_dir(&project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(result) = run_capture_optional(&mut pnpm)? {
    return Ok(result);
  }

  let mut npx = Command::new("npx");
  npx
    .arg("opkg")
    .arg("install")
    .arg(&package)
    .current_dir(&project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(result) = run_capture_optional(&mut npx)? {
    return Ok(result);
  }

  Ok(ExecResult {
    ok: false,
    status: -1,
    stdout: String::new(),
    stderr: "OpenPackage CLI not found. Install with `npm install -g opkg` (or `openpackage`), or ensure pnpm/npx is available.".to_string(),
  })
}

#[tauri::command]
fn import_skill(project_dir: String, source_dir: String, overwrite: bool) -> Result<ExecResult, String> {
  let project_dir = project_dir.trim().to_string();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let source_dir = source_dir.trim().to_string();
  if source_dir.is_empty() {
    return Err("sourceDir is required".to_string());
  }

  let src = PathBuf::from(&source_dir);
  let name = src
    .file_name()
    .and_then(|s| s.to_str())
    .ok_or_else(|| "Failed to infer skill name from directory".to_string())?;

  let dest = PathBuf::from(&project_dir)
    .join(".opencode")
    .join("skill")
    .join(name);

  if dest.exists() {
    if overwrite {
      fs::remove_dir_all(&dest)
        .map_err(|e| format!("Failed to remove existing skill dir {}: {e}", dest.display()))?;
    } else {
      return Err(format!("Skill already exists at {}", dest.display()));
    }
  }

  copy_dir_recursive(&src, &dest)?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Imported skill to {}", dest.display()),
    stderr: String::new(),
  })
}

#[tauri::command]
fn read_opencode_config(scope: String, project_dir: String) -> Result<OpencodeConfigFile, String> {
  let path = resolve_opencode_config_path(scope.trim(), &project_dir)?;
  let exists = path.exists();

  let content = if exists {
    Some(fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?)
  } else {
    None
  };

  Ok(OpencodeConfigFile {
    path: path.to_string_lossy().to_string(),
    exists,
    content,
  })
}

#[tauri::command]
fn write_opencode_config(
  scope: String,
  project_dir: String,
  content: String,
) -> Result<ExecResult, String> {
  let path = resolve_opencode_config_path(scope.trim(), &project_dir)?;

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Failed to create config dir {}: {e}", parent.display()))?;
  }

  fs::write(&path, content)
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

  Ok(ExecResult {
    ok: true,
    status: 0,
    stdout: format!("Wrote {}", path.display()),
    stderr: String::new(),
  })
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    #[cfg(desktop)]
    .plugin(tauri_plugin_process::init())
    #[cfg(desktop)]
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(EngineManager::default())
    .invoke_handler(tauri::generate_handler![
      engine_start,
      engine_stop,
      engine_info,
      engine_doctor,
      engine_install,
      workspace_bootstrap,
      workspace_set_active,
      workspace_create,
      workspace_add_authorized_root,
      opkg_install,
      import_skill,
      read_opencode_config,
      write_opencode_config,
      updater_environment
    ])
    .run(tauri::generate_context!())
    .expect("error while running OpenWork");
}
