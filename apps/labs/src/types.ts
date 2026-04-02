import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

export type WorkspaceConnectionStatus = "connecting" | "connected" | "disconnected";
export type SessionRunStatus = "idle" | "busy";
export type TemplateSource = "builtin" | "shared";
export type StarterKind = "prompt" | "session" | "action";
export type SeedMessageRole = "assistant" | "user";

export type SeedMessage = {
  role: SeedMessageRole;
  text: string;
};

export type LabsStarter = {
  id: string;
  kind: StarterKind;
  title: string;
  description: string;
  prompt?: string;
  action?: string;
};

export type LabsBlueprintSessionTemplate = {
  id: string;
  title: string;
  messages: SeedMessage[];
  openOnFirstLoad: boolean;
};

export type MaterializedSessionBinding = {
  templateId: string;
  sessionId: string;
};

export type LabsBlueprint = {
  emptyState: {
    title: string;
    body: string;
    starters: LabsStarter[];
  };
  sessions: LabsBlueprintSessionTemplate[];
  materialized: MaterializedSessionBinding[];
};

export type LabsTemplateProfile = {
  id: string;
  source: TemplateSource;
  sourceUrl: string | null;
  dataUrl: string | null;
  name: string;
  description: string;
  preset: string;
  recommendedDefaults: string[];
  includedItems: string[];
  starterCount: number;
  starterSessionCount: number;
  blueprint: LabsBlueprint;
};

export type WorkspaceTemplateBinding = {
  id: string;
  source: TemplateSource;
  sourceUrl: string | null;
  dataUrl: string | null;
  name: string;
  description: string;
  preset: string;
  recommendedDefaults: string[];
  importedAt: number;
  blueprint: LabsBlueprint;
};

export type LabsWorkspace = {
  id: string;
  name: string;
  baseUrl: string;
  token?: string | null;
  color: string;
  template?: WorkspaceTemplateBinding | null;
};

export type MessageWithParts = {
  info: Message;
  parts: Part[];
};

export type ConnectionSnapshot = {
  status: WorkspaceConnectionStatus;
  message?: string | null;
};

export type LabsState = {
  workspaces: LabsWorkspace[];
  activeWorkspaceId: string | null;
  sessionsByWorkspaceId: Record<string, Session[]>;
  selectedSessionIdByWorkspaceId: Record<string, string | null>;
  messagesBySessionId: Record<string, MessageWithParts[]>;
  statusBySessionId: Record<string, SessionRunStatus>;
  connectionByWorkspaceId: Record<string, ConnectionSnapshot>;
  seedMessagesBySessionId: Record<string, SeedMessage[]>;
  loadingMessagesBySessionId: Record<string, boolean>;
  unreadByWorkspaceId: Record<string, number>;
  templates: LabsTemplateProfile[];
  error: string | null;
};

export type PersistedLabsState = {
  workspaces: LabsWorkspace[];
  activeWorkspaceId: string | null;
  selectedSessionIdByWorkspaceId: Record<string, string | null>;
  seedMessagesBySessionId: Record<string, SeedMessage[]>;
  templates: LabsTemplateProfile[];
};

export type NormalizedLabsEvent = {
  type: string;
  properties?: unknown;
};

declare global {
  interface Window {
    openworkLabsDesktop?: {
      isDesktop: boolean;
      platform: string | null;
    };
  }
}
