import type { ServerConfig, WorkspaceInfo } from "./types.js";

type OpencodeConnection = {
  baseUrl?: string;
  authHeader?: string;
};

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function resolveWorkspaceOpencodeConnection(
  config: Pick<ServerConfig, "opencodeBaseUrl" | "opencodeUsername" | "opencodePassword">,
  workspace: WorkspaceInfo,
): OpencodeConnection {
  const baseUrl = trim(workspace.baseUrl) || trim(config.opencodeBaseUrl) || undefined;
  const username = trim(workspace.opencodeUsername) || trim(config.opencodeUsername);
  const password = trim(workspace.opencodePassword) || trim(config.opencodePassword);

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(username && password
      ? {
          authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      : {}),
  };
}

export function inheritWorkspaceOpencodeConnection(
  config: Pick<ServerConfig, "opencodeBaseUrl" | "opencodeUsername" | "opencodePassword">,
): Pick<WorkspaceInfo, "baseUrl" | "opencodeUsername" | "opencodePassword"> {
  const baseUrl = trim(config.opencodeBaseUrl);
  const username = trim(config.opencodeUsername);
  const password = trim(config.opencodePassword);

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(username ? { opencodeUsername: username } : {}),
    ...(password ? { opencodePassword: password } : {}),
  };
}
