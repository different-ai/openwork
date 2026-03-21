import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  QuestionRequest,
  ProviderListResponse,
  Session,
} from "@opencode-ai/sdk/v2/client";
import type { createClient } from "./lib/opencode";
import type { OpencodeConfigFile, ScheduledJob as TauriScheduledJob, WorkspaceInfo } from "./lib/tauri";

export type Client = ReturnType<typeof createClient>;

export type ProviderListItem = ProviderListResponse["all"][number];

export type SidebarSessionItem = {
  id: string;
  title: string;
  slug?: string | null;
  parentID?: string | null;
  time?: {
    updated?: number | null;
    created?: number | null;
  };
  directory?: string | null;
};

export type WorkspaceSessionGroup = {
  workspace: WorkspaceInfo;
  sessions: SidebarSessionItem[];
  status: "idle" | "loading" | "ready" | "error";
  error?: string | null;
};

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

export type SessionErrorTurn = {
  id: string;
  text: string;
  afterMessageID: string | null;
  time: number;
};

export const SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX = "session-error:";

export type StepGroupMode = "exploration" | "standalone";

export type MessageGroup =
  | { kind: "text"; part: Part; segment: "intent" | "result" }
  | { kind: "steps"; id: string; parts: Part[]; segment: "execution"; mode: StepGroupMode };

export type PromptMode = "prompt" | "shell";

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "agent"; name: string }
  | { type: "file"; path: string; label?: string }
  | { type: "paste"; id: string; label: string; text: string; lines: number };

export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  file: File;
  previewUrl?: string;
};

export type SlashCommandOption = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};

export type ComposerDraft = {
  mode: PromptMode;
  parts: ComposerPart[];
  attachments: ComposerAttachment[];
  /** Editor-visible text (may include collapsed paste placeholders). */
  text: string;
  /**
   * Resolved text to send to the model.
   * When a paste is collapsed into a placeholder (e.g. "[pasted text 1]"),
   * this includes the full pasted text instead.
   */
  resolvedText?: string;
  /** When set, draft is a slash command invocation */
  command?: { name: string; arguments: string } | undefined;
};

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

export type View = "onboarding" | "dashboard" | "session" | "proto";

export type StartupPreference = "local" | "server";

export type EngineRuntime = "direct" | "openwork-orchestrator";

export type OnboardingStep = "welcome" | "local" | "server" | "connecting";

export type DashboardTab =
  | "scheduled"
  | "skills"
  | "plugins"
  | "mcp"
  | "identities"
  | "config"
  | "settings";

export type SettingsTab =
  | "general"
  | "den"
  | "model"
  | "advanced"
  | "appearance"
  | "updates"
  | "recovery"
  | "debug";

export type WorkspacePreset = "starter" | "automation" | "minimal";

export type WorkspaceConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type WorkspaceConnectionState = {
  status: WorkspaceConnectionStatus;
  message?: string | null;
  checkedAt?: number | null;
};

export type ResetOpenworkMode = "onboarding" | "all";

export type WorkspaceBlueprintStarterKind = "prompt" | "session" | "action";

export type WorkspaceBlueprintStarterAction = "connect-openai";

export type WorkspaceBlueprintStarter = {
  id?: string | null;
  kind?: WorkspaceBlueprintStarterKind | null;
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  action?: WorkspaceBlueprintStarterAction | null;
};

export type WorkspaceBlueprintEmptyState = {
  title?: string | null;
  body?: string | null;
  starters?: WorkspaceBlueprintStarter[] | null;
};

export type WorkspaceBlueprint = {
  emptyState?: WorkspaceBlueprintEmptyState | null;
};

export type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  blueprint?: WorkspaceBlueprint | null;
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

export type SkillCard = {
  name: string;
  path: string;
  description?: string;
  trigger?: string;
};

export type HubSkillRepo = {
  owner: string;
  repo: string;
  ref: string;
};

export type HubSkillCard = {
  name: string;
  description?: string;
  trigger?: string;
  source: HubSkillRepo & {
    path: string;
  };
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

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type OpencodeConnectStatus = {
  at: number;
  baseUrl: string;
  directory?: string | null;
  reason?: string | null;
  status: "connecting" | "connected" | "error";
  error?: string | null;
  metrics?: {
    healthyMs?: number;
    loadSessionsMs?: number;
    pendingPermissionsMs?: number;
    providersMs?: number;
    totalMs?: number;
  };
};

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

export type PendingQuestion = QuestionRequest & {
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

export type ModelBehaviorOption = {
  value: string | null;
  label: string;
  description: string;
};

export type ModelOption = {
  providerID: string;
  modelID: string;
  title: string;
  description?: string;
  footer?: string;
  behaviorTitle: string;
  behaviorLabel: string;
  behaviorDescription: string;
  behaviorValue: string | null;
  behaviorOptions?: ModelBehaviorOption[];
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

export type ScheduledJob = TauriScheduledJob;

export type PluginState = {
  scope: PluginScope;
  config: OpencodeConfigFile | null;
  list: string[];
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
