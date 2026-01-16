use std::{
  env,
  ffi::OsStr,
  fs,
  net::TcpListener,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::Mutex,
};

use serde::Serialize;
use tauri::State;

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

fn find_free_port() -> Result<u16, String> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  Ok(port)
}

#[cfg(windows)]
const OPENCODE_EXECUTABLE: &str = "opencode.exe";

#[cfg(windows)]
const OPENCODE_CMD: &str = "opencode.cmd";

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

#[cfg(windows)]
fn npm_global_bin_dir() -> Option<PathBuf> {
  // npm global bin on Windows is typically %APPDATA%\npm
  if let Ok(appdata) = env::var("APPDATA") {
    if !appdata.trim().is_empty() {
      return Some(PathBuf::from(appdata).join("npm"));
    }
  }
  None
}

fn candidate_opencode_paths() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  let home = home_dir();

  if let Some(ref h) = home {
    candidates.push(h.join(".opencode").join("bin").join(OPENCODE_EXECUTABLE));
  }

  #[cfg(windows)]
  {
    // npm global bin on Windows (opencode.cmd wrapper script)
    if let Some(npm_bin) = npm_global_bin_dir() {
      candidates.push(npm_bin.join(OPENCODE_CMD));
      candidates.push(npm_bin.join(OPENCODE_EXECUTABLE));
    }

    // Also check in user's home .opencode\bin with .cmd extension
    if let Some(ref h) = home {
      candidates.push(h.join(".opencode").join("bin").join(OPENCODE_CMD));
    }
  }

  #[cfg(not(windows))]
  {
    // Homebrew default paths.
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(OPENCODE_EXECUTABLE));
    candidates.push(PathBuf::from("/usr/local/bin").join(OPENCODE_EXECUTABLE));

    // Common Linux paths.
    candidates.push(PathBuf::from("/usr/bin").join(OPENCODE_EXECUTABLE));
  }

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

  // Try to find opencode executable in PATH first.
  // On Windows, we check for both opencode.exe and opencode.cmd (npm wrapper).
  // On Unix, we check for opencode.
  if let Some(path) = resolve_in_path(OPENCODE_EXECUTABLE) {
    notes.push(format!("Found in PATH: {}", path.display()));
    return (Some(path), true, notes);
  }

  // On Windows, also check for opencode.cmd (npm's wrapper script)
  #[cfg(windows)]
  if let Some(path) = resolve_in_path(OPENCODE_CMD) {
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
      stderr: "Guided install is not supported on Windows yet. Install OpenCode via:\n- npm install -g opencode-ai\n- https://opencode.ai/install\n\nThen restart OpenWork.".to_string(),
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
fn engine_start(manager: State<EngineManager>, project_dir: String) -> Result<EngineInfo, String> {
  let project_dir = project_dir.trim().to_string();
  if project_dir.is_empty() {
    return Err("projectDir is required".to_string());
  }

  let hostname = "127.0.0.1".to_string();
  let port = find_free_port()?;

  let mut state = manager.inner.lock().expect("engine mutex poisoned");

  // Stop any existing engine first.
  EngineManager::stop_locked(&mut state);

  let (program, _in_path, notes) = resolve_opencode_executable();
  let Some(program) = program else {
    let notes_text = notes.join("\n");
    #[cfg(windows)]
    return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- npm install -g opencode-ai\n- https://opencode.ai/install\n\nNotes:\n{notes_text}"
    ));
    #[cfg(not(windows))]
    return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- npm install -g opencode-ai\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
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
    .manage(EngineManager::default())
    .invoke_handler(tauri::generate_handler![
      engine_start,
      engine_stop,
      engine_info,
      engine_doctor,
      engine_install,
      opkg_install,
      import_skill,
      read_opencode_config,
      write_opencode_config
    ])
    .run(tauri::generate_context!())
    .expect("error while running OpenWork");
}
