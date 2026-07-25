import { join } from "node:path";
import { resolveWorkspaceOpencodeConfigPath } from "@openwork/paths";

export function opencodeConfigPath(workspaceRoot: string): string {
  return resolveWorkspaceOpencodeConfigPath(workspaceRoot);
}

export function openworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork.json");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "plugins");
}
