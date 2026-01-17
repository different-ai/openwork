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

#[cfg(target_os = "macos")]
const MACOS_APP_SUPPORT_DIR: &str = "Library/Application Support";

fn candidate_xdg_data_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(home) = home_dir() else {
        return candidates;
    };

    candidates.push(home.join(".local").join("share"));
    candidates.push(home.join(".config"));

    #[cfg(target_os = "macos")]
    {
        candidates.push(home.join(MACOS_APP_SUPPORT_DIR));
    }

    candidates
}

fn candidate_xdg_config_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(home) = home_dir() else {
        return candidates;
    };

    candidates.push(home.join(".config"));

    #[cfg(target_os = "macos")]
    {
        candidates.push(home.join(MACOS_APP_SUPPORT_DIR));
    }

    candidates
}

fn maybe_infer_xdg_home(
    var_name: &str,
    candidates: Vec<PathBuf>,
    relative_marker: &Path,
) -> Option<String> {
    if env::var_os(var_name).is_some() {
        return None;
    }

    for base in candidates {
        if base.join(relative_marker).is_file() {
            return Some(base.to_string_lossy().to_string());
        }
    }

    None
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenworkConfig {
    pub version: u32,
    pub workspace: Option<WorkspaceOpenworkWorkspace>,
    #[serde(default, alias = "authorizedRoots")]
    pub authorized_roots: Vec<String>,
}

impl Default for WorkspaceOpenworkConfig {
    fn default() -> Self {
        Self {
            version: 1,
            workspace: None,
            authorized_roots: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenworkWorkspace {
    pub name: Option<String>,
    #[serde(default, alias = "createdAt")]
    pub created_at: Option<u64>,
    #[serde(default, alias = "preset")]
    pub preset: Option<String>,
}

impl WorkspaceOpenworkConfig {
    fn new(workspace_path: &str, preset: &str) -> Self {
        let root = PathBuf::from(workspace_path);
        let inferred_name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Workspace")
            .to_string();

        Self {
            version: 1,
            workspace: Some(WorkspaceOpenworkWorkspace {
                name: Some(inferred_name),
                created_at: Some(now_ms()),
                preset: Some(preset.to_string()),
            }),
            authorized_roots: vec![workspace_path.to_string()],
        }
    }
}

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
    last_stdout: Option<String>,
    last_stderr: Option<String>,
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
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
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
    pub serve_help_status: Option<i32>,
    pub serve_help_stdout: Option<String>,
    pub serve_help_stderr: Option<String>,
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

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
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

fn merge_plugins(existing: Vec<String>, required: &[&str]) -> Vec<String> {
    let mut next = existing;
    for plugin in required {
        if !next.iter().any(|p| p == plugin) {
            next.push(plugin.to_string());
        }
    }
    next
}

fn sanitize_template_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut out = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        }
    }

    if out.is_empty() {
        return None;
    }

    Some(out)
}

fn ensure_workspace_files(workspace_path: &str, preset: &str) -> Result<(), String> {
    let root = PathBuf::from(workspace_path);

    let skill_root = root.join(".opencode").join("skill");
    fs::create_dir_all(&skill_root)
        .map_err(|e| format!("Failed to create .opencode/skill: {e}"))?;

    // Seed workspace onboarding skill (required by onboarding PRD).
    let guide_dir = skill_root.join("workspace_guide");
    if !guide_dir.exists() {
        fs::create_dir_all(&guide_dir)
            .map_err(|e| format!("Failed to create {}: {e}", guide_dir.display()))?;

        let doc = r#"# Workspace Guide

This workspace is a real folder with local configuration.

## What lives where

- Workspace plugins: `opencode.json`
- Workspace skills: `.opencode/skill/*`
- Workspace templates: `.openwork/templates/*.json`
- OpenWork workspace metadata: `.opencode/openwork.json`

## What to try

- Run the template **Understand this workspace**
- Install a skill from the Skills tab
- Add a plugin in the Plugins tab

Be concise and practical."#;

        fs::write(guide_dir.join("SKILL.md"), doc)
            .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;
    }

    let templates_dir = root.join(".openwork").join("templates");
    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create .openwork/templates: {e}"))?;

    // Seed starter templates if the workspace is empty.
    if fs::read_dir(&templates_dir)
        .map_err(|e| format!("Failed to read {}: {e}", templates_dir.display()))?
        .next()
        .is_none()
    {
        let defaults = vec![
      WorkspaceTemplate {
        id: "tmpl_understand_workspace".to_string(),
        title: "Understand this workspace".to_string(),
        description: "Explains local vs global tools".to_string(),
        prompt: "Explain how this workspace is configured and what tools are available locally. Be concise and actionable.".to_string(),
        created_at: now_ms(),
      },
      WorkspaceTemplate {
        id: "tmpl_create_skill".to_string(),
        title: "Create a new skill".to_string(),
        description: "Guide to adding capabilities".to_string(),
        prompt: "I want to create a new skill for this workspace. Guide me through it.".to_string(),
        created_at: now_ms(),
      },
      WorkspaceTemplate {
        id: "tmpl_run_scheduled_task".to_string(),
        title: "Run a scheduled task".to_string(),
        description: "Demo of the scheduler plugin".to_string(),
        prompt: "Show me how to schedule a task to run every morning.".to_string(),
        created_at: now_ms(),
      },
      WorkspaceTemplate {
        id: "tmpl_task_to_template".to_string(),
        title: "Turn task into template".to_string(),
        description: "Save workflow for later".to_string(),
        prompt: "Help me turn the last task into a reusable template.".to_string(),
        created_at: now_ms(),
      },
    ];

        for template in defaults {
            let file_path = templates_dir.join(format!("{}.json", template.id));
            fs::write(
                &file_path,
                serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;
        }
    }

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
                serde_json::Value::Array(
                    merged.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
        }
    }

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;

    let openwork_path = root.join(".opencode").join("openwork.json");
    if !openwork_path.exists() {
        let openwork = WorkspaceOpenworkConfig::new(workspace_path, preset);

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
fn workspace_set_active(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<WorkspaceList, String> {
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
    let preset = if preset.is_empty() {
        "starter".to_string()
    } else {
        preset
    };

    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create workspace folder: {e}"))?;

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

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let mut config: WorkspaceOpenworkConfig = if openwork_path.exists() {
        let raw = fs::read_to_string(&openwork_path)
            .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        let mut cfg = WorkspaceOpenworkConfig::default();
        if !cfg.authorized_roots.iter().any(|p| p == &workspace_path) {
            cfg.authorized_roots.push(workspace_path.clone());
        }
        cfg
    };

    if !config.authorized_roots.iter().any(|p| p == &folder_path) {
        config.authorized_roots.push(folder_path);
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: "Updated authorizedRoots".to_string(),
        stderr: String::new(),
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTemplate {
    pub id: String,
    pub title: String,
    pub description: String,
    pub prompt: String,
    #[serde(default)]
    pub created_at: u64,
}

#[tauri::command]
fn workspace_template_write(
    _app: tauri::AppHandle,
    workspace_path: String,
    template: WorkspaceTemplate,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let Some(template_id) = sanitize_template_id(&template.id) else {
        return Err("template.id is required".to_string());
    };

    let templates_dir = PathBuf::from(&workspace_path)
        .join(".openwork")
        .join("templates");

    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create {}: {e}", templates_dir.display()))?;

    let payload = WorkspaceTemplate {
        id: template_id.clone(),
        title: template.title,
        description: template.description,
        prompt: template.prompt,
        created_at: if template.created_at > 0 {
            template.created_at
        } else {
            now_ms()
        },
    };

    let file_path = templates_dir.join(format!("{}.json", template_id));
    fs::write(
        &file_path,
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", file_path.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
fn workspace_openwork_read(
    _app: tauri::AppHandle,
    workspace_path: String,
) -> Result<WorkspaceOpenworkConfig, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("openwork.json");

    if !openwork_path.exists() {
        let mut cfg = WorkspaceOpenworkConfig::default();
        cfg.authorized_roots.push(workspace_path);
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&openwork_path)
        .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

    serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

#[tauri::command]
fn workspace_openwork_write(
    _app: tauri::AppHandle,
    workspace_path: String,
    config: WorkspaceOpenworkConfig,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("openwork.json");

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", openwork_path.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
fn workspace_template_delete(
    _app: tauri::AppHandle,
    workspace_path: String,
    template_id: String,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let Some(template_id) = sanitize_template_id(&template_id) else {
        return Err("templateId is required".to_string());
    };

    let file_path = PathBuf::from(&workspace_path)
        .join(".openwork")
        .join("templates")
        .join(format!("{}.json", template_id));

    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete {}: {e}", file_path.display()))?;
    }

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Deleted {}", file_path.display()),
        stderr: String::new(),
    })
}

fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

#[cfg(windows)]
const OPENCODE_EXECUTABLES: &[&str] = &["opencode.exe", "opencode.cmd", "opencode.bat"];

#[cfg(not(windows))]
const OPENCODE_EXECUTABLES: &[&str] = &["opencode"];

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

fn resolve_in_path(names: &[&str]) -> Option<PathBuf> {
    for dir in path_entries() {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidate_opencode_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(home) = home_dir() {
        for exe in OPENCODE_EXECUTABLES {
            candidates.push(home.join(".opencode").join("bin").join(exe));
        }
    }

    // Windows npm global install location
    #[cfg(windows)]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            for exe in OPENCODE_EXECUTABLES {
                candidates.push(PathBuf::from(&appdata).join("npm").join(exe));
            }
        }
    }

    // Homebrew default paths (macOS/Linux).
    for exe in OPENCODE_EXECUTABLES {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(exe));
        candidates.push(PathBuf::from("/usr/bin").join(exe));
    }

    candidates
}

/// Creates a Command for running opencode.
/// On Windows, .cmd and .bat files must be invoked via cmd.exe /C.
fn create_opencode_command(program: &OsStr) -> Command {
    #[cfg(windows)]
    {
        let program_str = program.to_string_lossy();
        if program_str.ends_with(".cmd") || program_str.ends_with(".bat") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(program);
            return cmd;
        }
    }

    Command::new(program)
}

fn opencode_version(program: &OsStr) -> Option<String> {
    let mut command = create_opencode_command(program);
    command.arg("--version");

    let output = command.output().ok()?;
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

fn truncate_output(input: &str, max_chars: usize) -> String {
    if input.len() <= max_chars {
        return input.to_string();
    }

    // Keep tail to preserve error context.
    input
        .chars()
        .skip(input.chars().count() - max_chars)
        .collect()
}

fn opencode_serve_help(program: &OsStr) -> (bool, Option<i32>, Option<String>, Option<String>) {
    let mut command = create_opencode_command(program);
    command.arg("serve").arg("--help");

    match command.output() {
        Ok(output) => {
            let status = output.status.code();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let ok = output.status.success();

            let stdout = if stdout.is_empty() {
                None
            } else {
                Some(truncate_output(&stdout, 4000))
            };
            let stderr = if stderr.is_empty() {
                None
            } else {
                Some(truncate_output(&stderr, 4000))
            };

            (ok, status, stdout, stderr)
        }
        Err(_) => (false, None, None, None),
    }
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
            notes.push(format!(
                "OPENCODE_BIN_PATH set but missing: {}",
                candidate.display()
            ));
        }
    }

    if let Some(path) = resolve_in_path(OPENCODE_EXECUTABLES) {
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

    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {}: {e}", dest.display()))?;

    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        let from = entry.path();
        let to = dest.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
            continue;
        }

        if file_type.is_file() {
            fs::copy(&from, &to).map_err(|e| {
                format!("Failed to copy {} -> {}: {e}", from.display(), to.display())
            })?;
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

#[tauri::command]
fn reset_openwork_state(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let mode = mode.trim();
    if mode != "onboarding" && mode != "all" {
        return Err("mode must be 'onboarding' or 'all'".to_string());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?;

    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to remove cache dir {}: {e}", cache_dir.display()))?;
    }

    if mode == "all" {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

        if data_dir.exists() {
            fs::remove_dir_all(&data_dir)
                .map_err(|e| format!("Failed to remove data dir {}: {e}", data_dir.display()))?;
        }
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
            } else if let Ok(appdata) = env::var("APPDATA") {
                // Windows: use %APPDATA%
                PathBuf::from(appdata)
            } else if let Ok(home) = env::var("HOME") {
                PathBuf::from(home).join(".config")
            } else if let Ok(userprofile) = env::var("USERPROFILE") {
                // Windows fallback: use %USERPROFILE%\.config
                PathBuf::from(userprofile).join(".config")
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
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
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
        state.last_stdout = None;
        state.last_stderr = None;
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

fn resolve_sidecar_candidate(prefer_sidecar: bool) -> (Option<PathBuf>, Vec<String>) {
    if !prefer_sidecar {
        return (None, Vec::new());
    }

    let mut notes = Vec::new();

    #[cfg(not(windows))]
    {
        // Best-effort: if we eventually bundle a binary, it will likely live here (dev) or be
        // injected during bundling.
        let candidate = PathBuf::from("src-tauri/sidecars").join(OPENCODE_EXECUTABLES[0]);
        if candidate.is_file() {
            notes.push(format!("Using bundled sidecar: {}", candidate.display()));
            return (Some(candidate), notes);
        }

        notes.push(format!(
            "Sidecar requested but missing: {}",
            candidate.display()
        ));
        return (None, notes);
    }

    #[cfg(windows)]
    {
        notes.push("Sidecar requested but unsupported on Windows".to_string());
        (None, notes)
    }
}

#[tauri::command]
fn engine_doctor(prefer_sidecar: Option<bool>) -> EngineDoctorResult {
    let prefer_sidecar = prefer_sidecar.unwrap_or(false);

    let (sidecar, mut notes) = resolve_sidecar_candidate(prefer_sidecar);
    let (resolved, in_path, more_notes) = match sidecar {
        Some(path) => (Some(path), false, Vec::new()),
        None => resolve_opencode_executable(),
    };

    notes.extend(more_notes);

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

    let (resolved_sidecar, mut sidecar_notes) =
        resolve_sidecar_candidate(prefer_sidecar.unwrap_or(false));

    notes.append(&mut sidecar_notes);

    let (program, _in_path, more_notes) = match resolved_sidecar {
        Some(path) => (Some(path), false, Vec::new()),
        None => resolve_opencode_executable(),
    };

    notes.extend(more_notes);
    let Some(program) = program else {
        let notes_text = notes.join("\n");
        #[cfg(windows)]
        let install_msg = "OpenCode CLI not found.\n\nInstall with:\n- npm install -g opencode-ai\n- Or download from https://opencode.ai/install\n\nAfter installing, restart OpenWork.";
        #[cfg(not(windows))]
        let install_msg = "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash";
        return Err(format!("{install_msg}\n\nNotes:\n{notes_text}"));
    };

    let mut command = create_opencode_command(program.as_os_str());
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Best-effort: restore env parity with terminal installs.
    // If the GUI process doesn't have XDG_* vars but the user's OpenCode auth/config lives under
    // a common XDG location, infer and set them for the engine process.
    if let Some(xdg_data_home) = maybe_infer_xdg_home(
        "XDG_DATA_HOME",
        candidate_xdg_data_dirs(),
        Path::new("opencode/auth.json"),
    ) {
        command.env("XDG_DATA_HOME", xdg_data_home);
    }

    // Help OpenCode find global config/plugins in GUI contexts.
    if let Some(xdg_config_home) = maybe_infer_xdg_home(
        "XDG_CONFIG_HOME",
        candidate_xdg_config_dirs(),
        Path::new("opencode/opencode.json"),
    ) {
        command.env("XDG_CONFIG_HOME", xdg_config_home);
    }

    // Tag requests and logs to make debugging easier.
    command.env("OPENCODE_CLIENT", "openwork");

    // Inherit the current environment (Command already does) but also pass through an explicit
    // marker for UI-driven launches so we can key off it in engine logs.
    command.env("OPENWORK", "1");

    let child = command
        .spawn()
        .map_err(|e| format!("Failed to start opencode: {e}"))?;

    state.last_stdout = None;
    state.last_stderr = None;

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
    opkg.arg("install")
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
    pnpm.arg("dlx")
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
    npx.arg("opkg")
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
fn import_skill(
    project_dir: String,
    source_dir: String,
    overwrite: bool,
) -> Result<ExecResult, String> {
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
            fs::remove_dir_all(&dest).map_err(|e| {
                format!(
                    "Failed to remove existing skill dir {}: {e}",
                    dest.display()
                )
            })?;
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
        Some(
            fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?,
        )
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

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", path.display()),
        stderr: String::new(),
    })
}

pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
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
            workspace_template_write,
            workspace_template_delete,
            workspace_openwork_read,
            workspace_openwork_write,
            opkg_install,
            import_skill,
            read_opencode_config,
            write_opencode_config,
            updater_environment,
            reset_openwork_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenWork");
}
