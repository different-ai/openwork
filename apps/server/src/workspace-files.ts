import { existsSync } from "node:fs";
import { join } from "node:path";

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "opencode.jsonc");
  const jsonPath = join(workspaceRoot, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

const NEW_CONFIG_DIR = ".openwork";
const LEGACY_CONFIG_DIR = ".opencode";
const CONFIG_FILENAME = "openwork.json";

export function openworkConfigPath(workspaceRoot: string): string {
  const newPath = join(workspaceRoot, NEW_CONFIG_DIR, CONFIG_FILENAME);
  if (existsSync(newPath)) return newPath;
  const legacyPath = join(workspaceRoot, LEGACY_CONFIG_DIR, CONFIG_FILENAME);
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

export function legacyOpenworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, LEGACY_CONFIG_DIR, CONFIG_FILENAME);
}

export function newOpenworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, NEW_CONFIG_DIR, CONFIG_FILENAME);
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
