import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";
import { validateMcpServerName } from "../mcp";

export type EngineInfo = {
  running: boolean;
  runtime: "direct" | "openwork-orchestrator";
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export type OpenworkServerInfo = {
  running: boolean;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  connectUrl: string | null;
  mdnsUrl: string | null;
  lanUrl: string | null;
  clientToken: string | null;
  hostToken: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

export type OrchestratorDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

export type OrchestratorOpencodeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

export type OrchestratorBinaryInfo = {
  path: string;
  source: string;
  expectedVersion?: string | null;
  actualVersion?: string | null;
};

export type OrchestratorBinaryState = {
  opencode?: OrchestratorBinaryInfo | null;
};

export type OrchestratorSidecarInfo = {
  dir?: string | null;
  baseUrl?: string | null;
  manifestUrl?: string | null;
  target?: string | null;
  source?: string | null;
  opencodeSource?: string | null;
  allowExternal?: boolean | null;
};

export type OrchestratorWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: string;
  baseUrl?: string | null;
  directory?: string | null;
  createdAt?: number | null;
  lastUsedAt?: number | null;
};

export type OrchestratorStatus = {
  running: boolean;
  dataDir: string;
  daemon: OrchestratorDaemonState | null;
  opencode: OrchestratorOpencodeState | null;
  cliVersion?: string | null;
  sidecar?: OrchestratorSidecarInfo | null;
  binaries?: OrchestratorBinaryState | null;
  activeId: string | null;
  workspaceCount: number;
  workspaces: OrchestratorWorkspace[];
  lastError: string | null;
};

export type EngineDoctorResult = {
  found: boolean;
  inPath: boolean;
  resolvedPath: string | null;
  version: string | null;
  supportsServe: boolean;
  notes: string[];
  serveHelpStatus: number | null;
  serveHelpStdout: string | null;
  serveHelpStderr: string | null;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: "local" | "remote";
  remoteType?: "openwork" | "opencode" | null;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
};

export type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

export type WorkspaceExportSummary = {
  outputPath: string;
  included: number;
  excluded: string[];
};

export async function engineStart(
  projectDir: string,
  options?: {
    preferSidecar?: boolean;
    runtime?: "direct" | "openwork-orchestrator";
    workspacePaths?: string[];
    opencodeBinPath?: string | null;
  },
): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_start", {
    projectDir,
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
    runtime: options?.runtime ?? null,
    workspacePaths: options?.workspacePaths ?? null,
  });
}

export async function workspaceBootstrap(): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_bootstrap");
}

export async function workspaceSetActive(workspaceId: string): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_set_active", { workspaceId });
}

export async function workspaceCreate(input: {
  folderPath: string;
  name: string;
  preset: string;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create", {
    folderPath: input.folderPath,
    name: input.name,
    preset: input.preset,
  });
}

export async function workspaceCreateRemote(input: {
  baseUrl: string;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create_remote", {
    baseUrl: input.baseUrl,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkToken: input.openworkToken ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
    sandboxRunId: input.sandboxRunId ?? null,
    sandboxContainerName: input.sandboxContainerName ?? null,
  });
}

export async function workspaceUpdateRemote(input: {
  workspaceId: string;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;

  // Sandbox lifecycle metadata (desktop-managed)
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_remote", {
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkToken: input.openworkToken ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
    sandboxRunId: input.sandboxRunId ?? null,
    sandboxContainerName: input.sandboxContainerName ?? null,
  });
}

export async function workspaceUpdateDisplayName(input: {
  workspaceId: string;
  displayName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_display_name", {
    workspaceId: input.workspaceId,
    displayName: input.displayName ?? null,
  });
}

export async function workspaceForget(workspaceId: string): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_forget", { workspaceId });
}

export async function workspaceAddAuthorizedRoot(input: {
  workspacePath: string;
  folderPath: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_add_authorized_root", {
    workspacePath: input.workspacePath,
    folderPath: input.folderPath,
  });
}

export async function workspaceExportConfig(input: {
  workspaceId: string;
  outputPath: string;
}): Promise<WorkspaceExportSummary> {
  return invoke<WorkspaceExportSummary>("workspace_export_config", {
    workspaceId: input.workspaceId,
    outputPath: input.outputPath,
  });
}

export async function workspaceImportConfig(input: {
  archivePath: string;
  targetDir: string;
  name?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_import_config", {
    archivePath: input.archivePath,
    targetDir: input.targetDir,
    name: input.name ?? null,
  });
}

export type OpencodeCommandDraft = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

export async function workspaceOpenworkRead(input: {
  workspacePath: string;
}): Promise<WorkspaceOpenworkConfig> {
  return invoke<WorkspaceOpenworkConfig>("workspace_openwork_read", {
    workspacePath: input.workspacePath,
  });
}

export async function workspaceOpenworkWrite(input: {
  workspacePath: string;
  config: WorkspaceOpenworkConfig;
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_openwork_write", {
    workspacePath: input.workspacePath,
    config: input.config,
  });
}

export async function opencodeCommandList(input: {
  scope: "workspace" | "global";
  projectDir: string;
}): Promise<string[]> {
  return invoke<string[]>("opencode_command_list", {
    scope: input.scope,
    projectDir: input.projectDir,
  });
}

export async function opencodeCommandWrite(input: {
  scope: "workspace" | "global";
  projectDir: string;
  command: OpencodeCommandDraft;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_write", {
    scope: input.scope,
    projectDir: input.projectDir,
    command: input.command,
  });
}

export async function opencodeCommandDelete(input: {
  scope: "workspace" | "global";
  projectDir: string;
  name: string;
}): Promise<ExecResult> {
  return invoke<ExecResult>("opencode_command_delete", {
    scope: input.scope,
    projectDir: input.projectDir,
    name: input.name,
  });
}

export async function engineStop(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_stop");
}

export async function orchestratorStatus(): Promise<OrchestratorStatus> {
  return invoke<OrchestratorStatus>("orchestrator_status");
}

export async function orchestratorWorkspaceActivate(input: {
  workspacePath: string;
  name?: string | null;
}): Promise<OrchestratorWorkspace> {
  return invoke<OrchestratorWorkspace>("orchestrator_workspace_activate", {
    workspacePath: input.workspacePath,
    name: input.name ?? null,
  });
}

export async function orchestratorInstanceDispose(workspacePath: string): Promise<boolean> {
  return invoke<boolean>("orchestrator_instance_dispose", { workspacePath });
}

export type AppBuildInfo = {
  version: string;
  gitSha?: string | null;
  buildEpoch?: string | null;
};

export async function appBuildInfo(): Promise<AppBuildInfo> {
  return invoke<AppBuildInfo>("app_build_info");
}

export type OrchestratorDetachedHost = {
  openworkUrl: string;
  token: string;
  hostToken: string;
  port: number;
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
};

export async function orchestratorStartDetached(input: {
  workspacePath: string;
  sandboxBackend?: "none" | "docker" | null;
  runId?: string | null;
}): Promise<OrchestratorDetachedHost> {
  return invoke<OrchestratorDetachedHost>("orchestrator_start_detached", {
    workspacePath: input.workspacePath,
    sandboxBackend: input.sandboxBackend ?? null,
    runId: input.runId ?? null,
  });
}

export type SandboxDoctorResult = {
  installed: boolean;
  daemonRunning: boolean;
  permissionOk: boolean;
  ready: boolean;
  clientVersion?: string | null;
  serverVersion?: string | null;
  error?: string | null;
  debug?: {
    candidates: string[];
    selectedBin?: string | null;
    versionCommand?: {
      status: number;
      stdout: string;
      stderr: string;
    } | null;
    infoCommand?: {
      status: number;
      stdout: string;
      stderr: string;
    } | null;
  } | null;
};

export async function sandboxDoctor(): Promise<SandboxDoctorResult> {
  return invoke<SandboxDoctorResult>("sandbox_doctor");
}

export async function sandboxStop(containerName: string): Promise<ExecResult> {
  return invoke<ExecResult>("sandbox_stop", { containerName });
}

export type OpenworkDockerCleanupResult = {
  candidates: string[];
  removed: string[];
  errors: string[];
};

export async function sandboxCleanupOpenworkContainers(): Promise<OpenworkDockerCleanupResult> {
  return invoke<OpenworkDockerCleanupResult>("sandbox_cleanup_openwork_containers");
}

export async function openworkServerInfo(): Promise<OpenworkServerInfo> {
  return invoke<OpenworkServerInfo>("openwork_server_info");
}

export async function engineInfo(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_info");
}

export async function engineDoctor(options?: {
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<EngineDoctorResult> {
  return invoke<EngineDoctorResult>("engine_doctor", {
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
  });
}

export async function pickDirectory(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: true,
    multiple: options?.multiple,
  });
}

export async function pickFile(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: false,
    multiple: options?.multiple,
    filters: options?.filters,
  });
}

export async function saveFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title: options?.title,
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
}

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type ScheduledJobRun = {
  prompt?: string;
  command?: string;
  arguments?: string;
  files?: string[];
  agent?: string;
  model?: string;
  variant?: string;
  title?: string;
  share?: boolean;
  continue?: boolean;
  session?: string;
  runFormat?: string;
  attachUrl?: string;
  port?: number;
};

export type ScheduledJob = {
  scopeId?: string;
  timeoutSeconds?: number;
  invocation?: { command: string; args: string[] };
  slug: string;
  name: string;
  schedule: string;
  prompt?: string;
  attachUrl?: string;
  run?: ScheduledJobRun;
  source?: string;
  workdir?: string;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastRunExitCode?: number;
  lastRunError?: string;
  lastRunSource?: string;
  lastRunStatus?: string;
};

export async function engineInstall(): Promise<ExecResult> {
  return invoke<ExecResult>("engine_install");
}

export async function opkgInstall(projectDir: string, pkg: string): Promise<ExecResult> {
  return invoke<ExecResult>("opkg_install", { projectDir, package: pkg });
}

export async function importSkill(
  projectDir: string,
  sourceDir: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("import_skill", {
    projectDir,
    sourceDir,
    overwrite: options?.overwrite ?? false,
  });
}

export async function installSkillTemplate(
  projectDir: string,
  name: string,
  content: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return invoke<ExecResult>("install_skill_template", {
    projectDir,
    name,
    content,
    overwrite: options?.overwrite ?? false,
  });
}

export type LocalSkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type LocalSkillContent = {
  path: string;
  content: string;
};

export async function listLocalSkills(projectDir: string): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills", { projectDir });
}

export async function readLocalSkill(projectDir: string, name: string): Promise<LocalSkillContent> {
  return invoke<LocalSkillContent>("read_local_skill", { projectDir, name });
}

export async function writeLocalSkill(projectDir: string, name: string, content: string): Promise<ExecResult> {
  return invoke<ExecResult>("write_local_skill", { projectDir, name, content });
}

export async function uninstallSkill(projectDir: string, name: string): Promise<ExecResult> {
  return invoke<ExecResult>("uninstall_skill", { projectDir, name });
}

export type OpencodeConfigFile = {
  path: string;
  exists: boolean;
  content: string | null;
};

export type UpdaterEnvironment = {
  supported: boolean;
  reason: string | null;
  executablePath: string | null;
  appBundlePath: string | null;
};

export async function updaterEnvironment(): Promise<UpdaterEnvironment> {
  return invoke<UpdaterEnvironment>("updater_environment");
}

export async function readOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
): Promise<OpencodeConfigFile> {
  return invoke<OpencodeConfigFile>("read_opencode_config", { scope, projectDir });
}

export async function writeOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
  content: string,
): Promise<ExecResult> {
  return invoke<ExecResult>("write_opencode_config", { scope, projectDir, content });
}

export async function resetOpenworkState(mode: "onboarding" | "all"): Promise<void> {
  return invoke<void>("reset_openwork_state", { mode });
}

export type CacheResetResult = {
  removed: string[];
  missing: string[];
  errors: string[];
};

export async function resetOpencodeCache(): Promise<CacheResetResult> {
  return invoke<CacheResetResult>("reset_opencode_cache");
}

export async function schedulerListJobs(scopeRoot?: string): Promise<ScheduledJob[]> {
  return invoke<ScheduledJob[]>("scheduler_list_jobs", { scopeRoot });
}

export async function schedulerDeleteJob(name: string, scopeRoot?: string): Promise<ScheduledJob> {
  return invoke<ScheduledJob>("scheduler_delete_job", { name, scopeRoot });
}

// OpenCodeRouter types
export type OpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running?: boolean;
};

export type OpenCodeRouterChannelStatus = {
  items: OpenCodeRouterIdentityItem[];
};

export type OpenCodeRouterStatus = {
  running: boolean;
  config: string;
  healthPort?: number | null;
  telegram: OpenCodeRouterChannelStatus;
  slack: OpenCodeRouterChannelStatus;
  opencode: { url: string; directory?: string };
};

export type OpenCodeRouterStatusResult =
  | { ok: true; status: OpenCodeRouterStatus }
  | { ok: false; error: string };

export type OpenCodeRouterInfo = {
  running: boolean;
  version: string | null;
  workspacePath: string | null;
  opencodeUrl: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
};

// OpenCodeRouter functions - call Tauri commands that wrap opencodeRouter CLI
export async function getOpenCodeRouterStatus(): Promise<OpenCodeRouterStatus | null> {
  try {
    return await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
  } catch {
    return null;
  }
}

export async function getOpenCodeRouterStatusDetailed(): Promise<OpenCodeRouterStatusResult> {
  try {
    const status = await invoke<OpenCodeRouterStatus>("opencodeRouter_status");
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function opencodeRouterInfo(): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_info");
}

export async function getOpenCodeRouterGroupsEnabled(): Promise<boolean | null> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? tauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.groupsEnabled ?? null;
  } catch {
    return null;
  }
}

export async function setOpenCodeRouterGroupsEnabled(enabled: boolean): Promise<ExecResult> {
  try {
    const status = await getOpenCodeRouterStatus();
    const healthPort = status?.healthPort ?? 3005;
    const response = await (isTauriRuntime() ? tauriFetch : fetch)(`http://127.0.0.1:${healthPort}/config/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      const message = await response.text();
      return { ok: false, status: response.status, stdout: "", stderr: message };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function opencodeDbMigrate(input: {
  projectDir: string;
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<ExecResult> {
  const safeProjectDir = input.projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  return invoke<ExecResult>("opencode_db_migrate", {
    projectDir: safeProjectDir,
    preferSidecar: input.preferSidecar ?? false,
    opencodeBinPath: input.opencodeBinPath ?? null,
  });
}

export async function opencodeMcpAuth(
  projectDir: string,
  serverName: string,
): Promise<ExecResult> {
  const safeProjectDir = projectDir.trim();
  if (!safeProjectDir) {
    throw new Error("project_dir is required");
  }

  const safeServerName = validateMcpServerName(serverName);

  return invoke<ExecResult>("opencode_mcp_auth", {
    projectDir: safeProjectDir,
    serverName: safeServerName,
  });
}

export async function opencodeRouterStop(): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_stop");
}

export async function opencodeRouterStart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  return invoke<OpenCodeRouterInfo>("opencodeRouter_start", {
    workspacePath: options.workspacePath,
    opencodeUrl: options.opencodeUrl ?? null,
    opencodeUsername: options.opencodeUsername ?? null,
    opencodePassword: options.opencodePassword ?? null,
    healthPort: options.healthPort ?? null,
  });
}

export async function opencodeRouterRestart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  await opencodeRouterStop();
  return opencodeRouterStart(options);
}

/**
 * Set window decorations (titlebar) visibility.
 * When `decorations` is false, the native titlebar is hidden.
 * Useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
 */
export async function setWindowDecorations(decorations: boolean): Promise<void> {
  return invoke<void>("set_window_decorations", { decorations });
}
