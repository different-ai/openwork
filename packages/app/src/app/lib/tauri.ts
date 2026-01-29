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
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;
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
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_create_remote", {
    baseUrl: input.baseUrl,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
  });
}

export async function workspaceUpdateRemote(input: {
  workspaceId: string;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  remoteType?: "openwork" | "opencode" | null;
  openworkHostUrl?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;
}): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_update_remote", {
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    remoteType: input.remoteType ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
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

export async function openworkServerInfo(): Promise<OpenworkServerInfo> {
  return invoke<OpenworkServerInfo>("openwork_server_info");
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

// Owpenbot types
export type OwpenbotWhatsAppStatus = {
  linked: boolean;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: string[];
};

export type OwpenbotTelegramStatus = {
  configured: boolean;
  enabled: boolean;
};

export type OwpenbotOpencodeStatus = {
  url: string;
};

export type OwpenbotStatus = {
  running: boolean;
  config: string;
  whatsapp: OwpenbotWhatsAppStatus;
  telegram: OwpenbotTelegramStatus;
  opencode: OwpenbotOpencodeStatus;
};

export type OwpenbotQr = {
  qr: string; // base64 encoded
  format: "png" | "ascii";
};

export type OwpenbotPairingRequest = {
  code: string;
  peerId: string;
  platform: "whatsapp" | "telegram";
  timestamp: number;
};

// Owpenbot functions - call Tauri commands that wrap owpenbot CLI
export async function getOwpenbotStatus(): Promise<OwpenbotStatus | null> {
  try {
    const result = await invoke<Record<string, unknown>>("owpenbot_status");
    // Transform CLI JSON output to OwpenbotStatus type
    return {
      running: (result.running as boolean) ?? false,
      config: (result.config as string) ?? "",
      whatsapp: {
        linked: (result.whatsapp as Record<string, unknown>)?.linked as boolean ?? false,
        dmPolicy: ((result.whatsapp as Record<string, unknown>)?.dmPolicy as OwpenbotWhatsAppStatus["dmPolicy"]) ?? "pairing",
        allowFrom: ((result.whatsapp as Record<string, unknown>)?.allowFrom as string[]) ?? [],
      },
      telegram: {
        configured: (result.telegram as Record<string, unknown>)?.configured as boolean ?? false,
        enabled: (result.telegram as Record<string, unknown>)?.enabled as boolean ?? false,
      },
      opencode: {
        url: (result.opencode as Record<string, unknown>)?.url as string ?? "",
      },
    };
  } catch {
    return null;
  }
}

export async function getOwpenbotQr(): Promise<OwpenbotQr | null> {
  try {
    const qrBase64 = await invoke<string>("owpenbot_qr");
    return {
      qr: qrBase64,
      format: "png",
    };
  } catch {
    return null;
  }
}

export async function setOwpenbotDmPolicy(
  policy: OwpenbotWhatsAppStatus["dmPolicy"],
): Promise<ExecResult> {
  try {
    await invoke("owpenbot_config_set", { key: "whatsapp.dmPolicy", value: policy });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function setOwpenbotAllowlist(allowlist: string[]): Promise<ExecResult> {
  try {
    // Join allowlist into comma-separated string for CLI
    await invoke("owpenbot_config_set", { key: "whatsapp.allowFrom", value: allowlist.join(",") });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function setOwpenbotTelegramToken(token: string): Promise<ExecResult> {
  try {
    await invoke("owpenbot_config_set", { key: "telegram.token", value: token });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function getOwpenbotPairingRequests(): Promise<OwpenbotPairingRequest[]> {
  try {
    const result = await invoke<Record<string, unknown>>("owpenbot_pairing_list");
    const requests = (result.requests as Array<Record<string, unknown>>) ?? [];
    return requests.map((r) => ({
      code: r.code as string,
      peerId: r.peerId as string,
      platform: r.platform as "whatsapp" | "telegram",
      timestamp: r.timestamp as number,
    }));
  } catch {
    return [];
  }
}

export async function approveOwpenbotPairing(code: string): Promise<ExecResult> {
  try {
    await invoke("owpenbot_pairing_approve", { code });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
}

export async function denyOwpenbotPairing(code: string): Promise<ExecResult> {
  try {
    await invoke("owpenbot_pairing_deny", { code });
    return { ok: true, status: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: String(e) };
  }
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
