import { validateMcpServerName } from "../mcp";
import type {
  AppBuildInfo,
  CacheResetResult,
  EngineDoctorResult,
  EngineInfo,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  ObsidianMirrorFileContent,
  OpenCodeRouterInfo,
  OpenCodeRouterStatus,
  OpenCodeRouterStatusResult,
  OpencodeCommandDraft,
  OpencodeConfigFile,
  OpenworkDockerCleanupResult,
  OpenworkServerInfo,
  OrchestratorDetachedHost,
  OrchestratorStatus,
  OrchestratorWorkspace,
  SandboxDebugProbeResult,
  SandboxDoctorResult,
  ScheduledJob,
  UpdaterEnvironment,
  WorkspaceExportSummary,
  WorkspaceList,
  WorkspaceOpenworkConfig,
} from "./desktop-contract";
import type { OpenWorkDesktopAPI } from "./openwork-desktop";

export type * from "./desktop-contract";

function getDesktopBridge(): OpenWorkDesktopAPI {
  if (typeof window === "undefined" || !window.openworkDesktop) {
    throw new Error("Desktop app required");
  }

  return window.openworkDesktop;
}

export async function engineStart(
  projectDir: string,
  options?: {
    preferSidecar?: boolean;
    runtime?: "direct" | "openwork-orchestrator";
    workspacePaths?: string[];
    opencodeBinPath?: string | null;
  },
): Promise<EngineInfo> {
  return getDesktopBridge().engine.start({
    projectDir,
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
    runtime: options?.runtime,
    workspacePaths: options?.workspacePaths,
  });
}

export async function workspaceBootstrap(): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.bootstrap();
}

export async function workspaceSetActive(workspaceId: string): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.setActive({ workspaceId });
}

export async function workspaceCreate(input: {
  folderPath: string;
  name: string;
  preset: string;
}): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.create(input);
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
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
}): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.createRemote(input);
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
  sandboxBackend?: "docker" | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
}): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.updateRemote(input);
}

export async function workspaceUpdateDisplayName(input: {
  workspaceId: string;
  displayName?: string | null;
}): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.updateDisplayName(input);
}

export async function workspaceForget(workspaceId: string): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.forget({ workspaceId });
}

export async function workspaceAddAuthorizedRoot(input: {
  workspacePath: string;
  folderPath: string;
}): Promise<ExecResult> {
  return getDesktopBridge().workspace.addAuthorizedRoot(input);
}

export async function workspaceExportConfig(input: {
  workspaceId: string;
  outputPath: string;
}): Promise<WorkspaceExportSummary> {
  return getDesktopBridge().workspace.exportConfig(input);
}

export async function workspaceImportConfig(input: {
  archivePath: string;
  targetDir: string;
  name?: string | null;
}): Promise<WorkspaceList> {
  return getDesktopBridge().workspace.importConfig(input);
}

export async function workspaceOpenworkRead(input: {
  workspacePath: string;
}): Promise<WorkspaceOpenworkConfig> {
  return getDesktopBridge().workspace.openworkRead(input);
}

export async function workspaceOpenworkWrite(input: {
  workspacePath: string;
  config: WorkspaceOpenworkConfig;
}): Promise<ExecResult> {
  return getDesktopBridge().workspace.openworkWrite(input);
}

export async function opencodeCommandList(input: {
  scope: "workspace" | "global";
  projectDir: string;
}): Promise<string[]> {
  return getDesktopBridge().commandFiles.list(input);
}

export async function opencodeCommandWrite(input: {
  scope: "workspace" | "global";
  projectDir: string;
  command: OpencodeCommandDraft;
}): Promise<ExecResult> {
  return getDesktopBridge().commandFiles.write(input);
}

export async function opencodeCommandDelete(input: {
  scope: "workspace" | "global";
  projectDir: string;
  name: string;
}): Promise<ExecResult> {
  return getDesktopBridge().commandFiles.delete(input);
}

export async function engineStop(): Promise<EngineInfo> {
  return getDesktopBridge().engine.stop();
}

export async function engineRestart(): Promise<EngineInfo> {
  return getDesktopBridge().engine.restart();
}

export async function orchestratorStatus(): Promise<OrchestratorStatus> {
  return getDesktopBridge().orchestrator.status();
}

export async function orchestratorWorkspaceActivate(input: {
  workspacePath: string;
  name?: string | null;
}): Promise<OrchestratorWorkspace> {
  return getDesktopBridge().orchestrator.activateWorkspace(input);
}

export async function orchestratorInstanceDispose(workspacePath: string): Promise<boolean> {
  return getDesktopBridge().orchestrator.disposeInstance({ workspacePath });
}

export async function appBuildInfo(): Promise<AppBuildInfo> {
  return getDesktopBridge().app.getBuildInfo();
}

export async function nukeOpencodeDevConfigAndExit(): Promise<void> {
  return getDesktopBridge().app.nukeDevConfigAndExit();
}

export async function orchestratorStartDetached(input: {
  workspacePath: string;
  sandboxBackend?: "none" | "docker" | null;
  runId?: string | null;
  openworkToken?: string | null;
  openworkHostToken?: string | null;
}): Promise<OrchestratorDetachedHost> {
  return getDesktopBridge().orchestrator.startDetached(input);
}

export async function sandboxDoctor(): Promise<SandboxDoctorResult> {
  return getDesktopBridge().orchestrator.sandboxDoctor();
}

export async function sandboxStop(containerName: string): Promise<ExecResult> {
  return getDesktopBridge().orchestrator.sandboxStop({ containerName });
}

export async function sandboxCleanupOpenworkContainers(): Promise<OpenworkDockerCleanupResult> {
  return getDesktopBridge().orchestrator.sandboxCleanupOpenworkContainers();
}

export async function sandboxDebugProbe(): Promise<SandboxDebugProbeResult> {
  return getDesktopBridge().orchestrator.sandboxDebugProbe();
}

export async function openworkServerInfo(): Promise<OpenworkServerInfo> {
  return getDesktopBridge().openworkServer.info();
}

export async function openworkServerRestart(): Promise<OpenworkServerInfo> {
  return getDesktopBridge().openworkServer.restart();
}

export async function engineInfo(): Promise<EngineInfo> {
  return getDesktopBridge().engine.info();
}

export async function engineDoctor(options?: {
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<EngineDoctorResult> {
  return getDesktopBridge().engine.doctor({
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
  });
}

export async function pickDirectory(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
}): Promise<string | string[] | null> {
  return getDesktopBridge().dialogs.pickDirectory(options);
}

export async function pickFile(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | string[] | null> {
  return getDesktopBridge().dialogs.pickFile(options);
}

export async function saveFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  return getDesktopBridge().dialogs.saveFile(options);
}

export async function engineInstall(): Promise<ExecResult> {
  return getDesktopBridge().engine.install();
}

export async function opkgInstall(projectDir: string, pkg: string): Promise<ExecResult> {
  return getDesktopBridge().packages.opkgInstall({ projectDir, package: pkg });
}

export async function importSkill(
  projectDir: string,
  sourceDir: string,
  options?: { overwrite?: boolean },
): Promise<ExecResult> {
  return getDesktopBridge().skills.importFromDirectory({
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
  return getDesktopBridge().skills.installTemplate({
    projectDir,
    name,
    content,
    overwrite: options?.overwrite ?? false,
  });
}

export async function listLocalSkills(projectDir: string): Promise<LocalSkillCard[]> {
  return getDesktopBridge().skills.listLocal({ projectDir });
}

export async function readLocalSkill(projectDir: string, name: string): Promise<LocalSkillContent> {
  return getDesktopBridge().skills.readLocal({ projectDir, name });
}

export async function writeLocalSkill(projectDir: string, name: string, content: string): Promise<ExecResult> {
  return getDesktopBridge().skills.writeLocal({ projectDir, name, content });
}

export async function uninstallSkill(projectDir: string, name: string): Promise<ExecResult> {
  return getDesktopBridge().skills.uninstall({ projectDir, name });
}

export async function updaterEnvironment(): Promise<UpdaterEnvironment> {
  return getDesktopBridge().updates.getEnvironment();
}

export async function readOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
): Promise<OpencodeConfigFile> {
  return getDesktopBridge().config.readOpencode({ scope, projectDir });
}

export async function writeOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
  content: string,
): Promise<ExecResult> {
  return getDesktopBridge().config.writeOpencode({ scope, projectDir, content });
}

export async function resetOpenworkState(mode: "onboarding" | "all"): Promise<void> {
  return getDesktopBridge().cache.resetOpenworkState({ mode });
}

export async function resetOpencodeCache(): Promise<CacheResetResult> {
  return getDesktopBridge().cache.resetOpencodeCache();
}

export async function obsidianIsAvailable(): Promise<boolean> {
  return getDesktopBridge().obsidian.isAvailable();
}

export async function openInObsidian(filePath: string): Promise<void> {
  const safePath = filePath.trim();
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return getDesktopBridge().obsidian.open({ filePath: safePath });
}

export async function writeObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<string> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return getDesktopBridge().obsidian.writeMirrorFile({
    workspaceId: safeWorkspaceId,
    filePath: safePath,
    content,
  });
}

export async function readObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
): Promise<ObsidianMirrorFileContent> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return getDesktopBridge().obsidian.readMirrorFile({
    workspaceId: safeWorkspaceId,
    filePath: safePath,
  });
}

export async function schedulerListJobs(scopeRoot?: string): Promise<ScheduledJob[]> {
  return getDesktopBridge().scheduler.listJobs(scopeRoot ? { scopeRoot } : undefined);
}

export async function schedulerDeleteJob(name: string, scopeRoot?: string): Promise<ScheduledJob> {
  return getDesktopBridge().scheduler.deleteJob({ name, ...(scopeRoot ? { scopeRoot } : {}) });
}

export async function getOpenCodeRouterStatus(): Promise<OpenCodeRouterStatus | null> {
  try {
    return await getDesktopBridge().router.status();
  } catch {
    return null;
  }
}

export async function getOpenCodeRouterStatusDetailed(): Promise<OpenCodeRouterStatusResult> {
  try {
    const status = await getDesktopBridge().router.status();
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function opencodeRouterInfo(): Promise<OpenCodeRouterInfo> {
  return getDesktopBridge().router.info();
}

export async function getOpenCodeRouterGroupsEnabled(): Promise<boolean | null> {
  return getDesktopBridge().router.getGroupsEnabled();
}

export async function setOpenCodeRouterGroupsEnabled(enabled: boolean): Promise<ExecResult> {
  return getDesktopBridge().router.setGroupsEnabled({ enabled });
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

  return getDesktopBridge().opencode.dbMigrate({
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
  return getDesktopBridge().opencode.mcpAuth({
    projectDir: safeProjectDir,
    serverName: safeServerName,
  });
}

export async function opencodeRouterStop(): Promise<OpenCodeRouterInfo> {
  return getDesktopBridge().router.stop();
}

export async function opencodeRouterStart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  return getDesktopBridge().router.start(options);
}

export async function opencodeRouterRestart(options: {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
}): Promise<OpenCodeRouterInfo> {
  return getDesktopBridge().router.restart(options);
}

/**
 * Set window decorations (titlebar) visibility.
 * When `decorations` is false, the native titlebar is hidden.
 * Useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
 */
export async function setWindowDecorations(decorations: boolean): Promise<void> {
  return getDesktopBridge().window.setDecorations({ decorations });
}
