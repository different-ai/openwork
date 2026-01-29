use serde::{Deserialize, Serialize};

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
    pub fn new(workspace_path: &str, preset: &str, now_ms: u64) -> Self {
        let root = std::path::PathBuf::from(workspace_path);
        let inferred_name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Workspace")
            .to_string();

        Self {
            version: 1,
            workspace: Some(WorkspaceOpenworkWorkspace {
                name: Some(inferred_name),
                created_at: Some(now_ms),
                preset: Some(preset.to_string()),
            }),
            authorized_roots: vec![workspace_path.to_string()],
        }
    }
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
pub struct OpenworkServerInfo {
    pub running: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub connect_url: Option<String>,
    pub mdns_url: Option<String>,
    pub lan_url: Option<String>,
    pub client_token: Option<String>,
    pub host_token: Option<String>,
    pub pid: Option<u32>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OwpenbotInfo {
    pub running: bool,
    pub workspace_path: Option<String>,
    pub opencode_url: Option<String>,
    pub qr_data: Option<String>,
    pub whatsapp_linked: bool,
    pub telegram_configured: bool,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceType {
    Local,
    Remote,
}

impl Default for WorkspaceType {
    fn default() -> Self {
        WorkspaceType::Local
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteType {
    Opencode,
    Openwork,
}

impl Default for RemoteType {
    fn default() -> Self {
        RemoteType::Opencode
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub preset: String,
    #[serde(default)]
    pub workspace_type: WorkspaceType,
    #[serde(default)]
    pub remote_type: Option<RemoteType>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub openwork_host_url: Option<String>,
    #[serde(default)]
    pub openwork_workspace_id: Option<String>,
    #[serde(default)]
    pub openwork_workspace_name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub active_id: String,
    pub workspaces: Vec<WorkspaceInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub template: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub subtask: Option<bool>,
}

fn default_workspace_state_version() -> u8 {
    1
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[serde(default = "default_workspace_state_version")]
    pub version: u8,
    pub active_id: String,
    pub workspaces: Vec<WorkspaceInfo>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            version: WORKSPACE_STATE_VERSION,
            active_id: "starter".to_string(),
            workspaces: Vec::new(),
        }
    }
}

pub const WORKSPACE_STATE_VERSION: u8 = 3;
