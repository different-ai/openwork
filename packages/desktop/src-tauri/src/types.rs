use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenworkConfig {
    pub version: u32,
    pub workspace: Option<WorkspaceOpenworkWorkspace>,
    #[serde(default, alias = "authorizedRoots")]
    pub authorized_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reload: Option<WorkspaceOpenworkReload>,
}

impl Default for WorkspaceOpenworkConfig {
    fn default() -> Self {
        Self {
            version: 1,
            workspace: None,
            authorized_roots: Vec::new(),
            reload: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenworkReload {
    pub auto: Option<bool>,
    pub resume: Option<bool>,
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
            reload: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EngineRuntime {
    Direct,
    #[serde(rename = "openwork-orchestrator")]
    Orchestrator,
}

impl Default for EngineRuntime {
    fn default() -> Self {
        EngineRuntime::Direct
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub running: bool,
    pub runtime: EngineRuntime,
    pub base_url: Option<String>,
    pub project_dir: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDaemonState {
    pub pid: u32,
    pub port: u16,
    pub base_url: String,
    pub started_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorOpencodeState {
    pub pid: u32,
    pub port: u16,
    pub base_url: String,
    pub started_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorBinaryInfo {
    pub path: String,
    pub source: String,
    pub expected_version: Option<String>,
    pub actual_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorBinaryState {
    pub opencode: Option<OrchestratorBinaryInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSidecarInfo {
    pub dir: Option<String>,
    pub base_url: Option<String>,
    pub manifest_url: Option<String>,
    pub target: Option<String>,
    pub source: Option<String>,
    pub opencode_source: Option<String>,
    pub allow_external: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorWorkspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspace_type: String,
    pub base_url: Option<String>,
    pub directory: Option<String>,
    pub created_at: Option<u64>,
    pub last_used_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStatus {
    pub running: bool,
    pub data_dir: String,
    pub daemon: Option<OrchestratorDaemonState>,
    pub opencode: Option<OrchestratorOpencodeState>,
    pub cli_version: Option<String>,
    pub sidecar: Option<OrchestratorSidecarInfo>,
    pub binaries: Option<OrchestratorBinaryState>,
    pub active_id: Option<String>,
    pub workspace_count: usize,
    pub workspaces: Vec<OrchestratorWorkspace>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeRouterInfo {
    pub running: bool,
    pub version: Option<String>,
    pub workspace_path: Option<String>,
    pub opencode_url: Option<String>,
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
pub struct ScheduledJobRun {
    pub prompt: Option<String>,
    pub command: Option<String>,
    pub arguments: Option<String>,
    pub files: Option<Vec<String>>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub title: Option<String>,
    pub share: Option<bool>,
    #[serde(rename = "continue")]
    pub continue_flag: Option<bool>,
    pub session: Option<String>,
    pub run_format: Option<String>,
    pub attach_url: Option<String>,
    pub port: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub scope_id: Option<String>,
    pub timeout_seconds: Option<i32>,
    pub slug: String,
    pub name: String,
    pub schedule: String,
    pub prompt: Option<String>,
    pub attach_url: Option<String>,
    pub run: Option<ScheduledJobRun>,
    pub source: Option<String>,
    pub workdir: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_exit_code: Option<i32>,
    pub last_run_error: Option<String>,
    pub last_run_source: Option<String>,
    pub last_run_status: Option<String>,
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
    pub openwork_token: Option<String>,
    #[serde(default)]
    pub openwork_workspace_id: Option<String>,
    #[serde(default)]
    pub openwork_workspace_name: Option<String>,

    // Sandbox lifecycle metadata (desktop-managed)
    #[serde(default)]
    pub sandbox_backend: Option<String>,
    #[serde(default)]
    pub sandbox_run_id: Option<String>,
    #[serde(default)]
    pub sandbox_container_name: Option<String>,
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

pub const WORKSPACE_STATE_VERSION: u8 = 4;
