export type WorkspaceType = "local" | "remote";

export type ApprovalMode = "manual" | "auto";

export interface WorkspaceConfig {
  path: string;
  name?: string;
  workspaceType?: WorkspaceType;
  baseUrl?: string;
  directory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  workspaceType: WorkspaceType;
  baseUrl?: string;
  directory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  timeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  hostToken: string;
  configPath?: string;
  approval: ApprovalConfig;
  corsOrigins: string[];
  workspaces: WorkspaceInfo[];
  authorizedRoots: string[];
  readOnly: boolean;
  startedAt: number;
  tokenSource: "cli" | "env" | "file" | "generated";
  hostTokenSource: "cli" | "env" | "file" | "generated";
}

export interface Capabilities {
  skills: { read: boolean; write: boolean; source: "openwork" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
}

export type ReloadReason = "plugins" | "skills" | "mcp" | "config";

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export interface ReloadEvent {
  id: string;
  seq: number;
  workspaceId: string;
  reason: ReloadReason;
  trigger?: ReloadTrigger;
  timestamp: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface PluginItem {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
}

export interface McpItem {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
}

export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
}

export interface CommandItem {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
}

export interface Actor {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  action: string;
  summary: string;
  paths: string[];
  createdAt: number;
  actor: Actor;
}

export interface AuditEntry {
  id: string;
  workspaceId: string;
  actor: Actor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
}
