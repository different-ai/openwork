import type { Message, Part, PermissionRequest as ApiPermissionRequest, Provider, Session } from "@opencode-ai/sdk/v2/client";
import type { createClient } from "./lib/opencode";
import type { OpencodeConfigFile, WorkspaceInfo } from "./lib/tauri";

export type Client = ReturnType<typeof createClient>;

export type PlaceholderAssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type MessageInfo = Message | PlaceholderAssistantMessage;

export type MessageWithParts = {
  info: MessageInfo;
  parts: Part[];
};

export type MessageGroup =
  | { kind: "text"; part: Part }
  | { kind: "steps"; id: string; parts: Part[] };

export type ArtifactItem = {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "text";
  size?: string;
  messageId?: string;
};

export type OpencodeEvent = {
  type: string;
  properties?: unknown;
};

export type View = "onboarding" | "dashboard" | "session";

export type Mode = "host" | "client";

export type OnboardingStep = "mode" | "host" | "client" | "connecting";

export type DashboardTab = "home" | "sessions" | "commands" | "skills" | "plugins" | "mcp" | "settings";

export type DemoSequence = "cold-open" | "scheduler" | "summaries" | "groceries";

export type WorkspacePreset = "starter" | "automation" | "minimal";

export type ResetOpenworkMode = "onboarding" | "all";

export type CommandScope = "workspace" | "global" | "unknown";

export type CommandRegistryScope = "global" | "session";

export type CommandTriggerContext = {
  source?: "palette" | "slash" | "keybind";
};

export type CommandRegistryItem = {
  id: string;
  title: string;
  category?: string;
  description?: string;
  keybind?: string;
  slash?: string;
  scope?: CommandRegistryScope;
  showInPalette?: boolean;
  onSelect: (context?: CommandTriggerContext) => void;
  onHighlight?: (context?: CommandTriggerContext) => void;
};

export type CommandDefinition = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type WorkspaceCommand = CommandDefinition & {
  scope: CommandScope;
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

export type SkillCard = {
  name: string;
  path: string;
  description?: string;
};

export type PluginInstallStep = {
  title: string;
  description: string;
  command?: string;
  url?: string;
  path?: string;
  note?: string;
};

export type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: PluginInstallStep[];
};

export type PluginScope = "project" | "global";

export type McpServerConfig = {
  type: "remote" | "local";
  url?: string;
  command?: string[];
  enabled?: boolean;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  oauth?: Record<string, string> | false;
  timeout?: number;
};

export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
};

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export type McpStatusMap = Record<string, McpStatus>;

export type ReloadReason = "plugins" | "skills" | "mcp" | "config";

export type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

export type TodoItem = {
  id: string;
  content: string;
  status: string;
  priority: string;
};

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type ModelOption = {
  providerID: string;
  modelID: string;
  title: string;
  description?: string;
  footer?: string;
  disabled?: boolean;
  isFree: boolean;
  isConnected: boolean;
};

export type SelectedSessionSnapshot = {
  session: Session | null;
  status: string;
  modelLabel: string;
};

export type WorkspaceState = {
  active: WorkspaceInfo | null;
  path: string;
  root: string;
};

export type PluginState = {
  scope: PluginScope;
  config: OpencodeConfigFile | null;
  list: string[];
};

export type CommandState = {
  items: WorkspaceCommand[];
  loaded: boolean;
};

export type WorkspaceDisplay = WorkspaceInfo & {
  name: string;
};

export type UpdateHandle = {
  available: boolean;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
  close: () => Promise<void>;
  download: (onEvent?: (event: any) => void) => Promise<void>;
  install: () => Promise<void>;
  downloadAndInstall: (onEvent?: (event: any) => void) => Promise<void>;
};
