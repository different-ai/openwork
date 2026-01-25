import { invoke } from "@tauri-apps/api/core";
import { validateMcpServerName } from "../mcp";

export type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
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
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

export async function engineStart(
  projectDir: string,
  options?: { preferSidecar?: boolean },
): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_start", {
    projectDir,
    preferSidecar: options?.preferSidecar ?? false,
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
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create_remote", {
    baseUrl: input.baseUrl,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
  });
}

export async function workspaceUpdateRemote(input: {
  workspaceId: string;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_remote", {
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
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

export async function engineInfo(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_info");
}

export async function engineDoctor(options?: {
  preferSidecar?: boolean;
}): Promise<EngineDoctorResult> {
  return invoke<EngineDoctorResult>("engine_doctor", {
    preferSidecar: options?.preferSidecar ?? false,
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

export type ExecResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
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
};

export async function listLocalSkills(projectDir: string): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills", { projectDir });
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
