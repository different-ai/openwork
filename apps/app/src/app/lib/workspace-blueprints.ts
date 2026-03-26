import type {
  WorkspaceBlueprint,
  WorkspaceBlueprintMaterializedSession,
  WorkspaceBlueprintSessionMessage,
  WorkspaceBlueprintSessionTemplate,
  WorkspaceBlueprintStarter,
  WorkspaceOpenworkConfig,
} from "../types";
import { parseTemplateFrontmatter } from "../utils";

import browserSetupTemplate from "../data/commands/browser-setup.md?raw";

const BROWSER_AUTOMATION_QUICKSTART_PROMPT = (() => {
  const parsed = parseTemplateFrontmatter(browserSetupTemplate);
  return (parsed?.body ?? browserSetupTemplate).trim();
})();

export const DEFAULT_EMPTY_STATE_COPY = {
  title: "What do you want to do?",
  body: "Pick a starting point or just type below.",
};

const DEFAULT_WELCOME_BLUEPRINT_MESSAGES: WorkspaceBlueprintSessionMessage[] = [
  {
    role: "assistant",
    text:
      "Hi welcome to OpenWork!\n\nPeople use us to write .csv files on their computer, connect to Chrome and automate repetitive tasks, and sync contacts to Notion.\n\nBut the only limit is your imagination.\n\nWhat would you want to do?",
  },
];

export function defaultBlueprintSessionsForPreset(_preset: string): WorkspaceBlueprintSessionTemplate[] {
  return [
    {
      id: "welcome-to-openwork",
      title: "Welcome to OpenWork",
      messages: DEFAULT_WELCOME_BLUEPRINT_MESSAGES,
      openOnFirstLoad: true,
    },
    {
      id: "csv-playbook",
      title: "CSV workflow ideas",
      messages: [
        {
          role: "assistant",
          text: "I can help you generate, clean, merge, and summarize CSV files. What kind of CSV work do you want to automate?",
        },
        {
          role: "user",
          text: "I want to combine exports from multiple tools into one clean CSV.",
        },
      ],
      openOnFirstLoad: false,
    },
  ];
}

function normalizeSessionMessage(value: unknown): WorkspaceBlueprintSessionMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return null;
  const role = String(record.role ?? "assistant").trim().toLowerCase() === "user" ? "user" : "assistant";
  return { role, text };
}

function normalizeSessionTemplate(value: unknown, index: number): WorkspaceBlueprintSessionTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `template-session-${index + 1}`;
  const messages = Array.isArray(record.messages)
    ? record.messages.map(normalizeSessionMessage).filter((item): item is WorkspaceBlueprintSessionMessage => Boolean(item))
    : [];
  if (!title && messages.length === 0) return null;
  return {
    id,
    title: title || null,
    messages,
    openOnFirstLoad: record.openOnFirstLoad === true,
  };
}

function normalizeMaterializedSession(value: unknown): WorkspaceBlueprintMaterializedSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const templateId = typeof record.templateId === "string" ? record.templateId.trim() : "";
  if (!sessionId || !templateId) return null;
  return { sessionId, templateId };
}

function normalizeBlueprint(value: unknown): WorkspaceBlueprint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as WorkspaceBlueprint & Record<string, unknown>;
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
        .map((session, index) => normalizeSessionTemplate(session, index))
        .filter((item): item is WorkspaceBlueprintSessionTemplate => Boolean(item))
    : null;
  const materializedSessions = Array.isArray(candidate.materialized?.sessions?.items)
    ? candidate.materialized?.sessions?.items
        .map(normalizeMaterializedSession)
        .filter((item): item is WorkspaceBlueprintMaterializedSession => Boolean(item))
    : null;

  return {
    emptyState: candidate.emptyState ?? null,
    sessions,
    materialized: candidate.materialized
      ? {
          sessions: candidate.materialized.sessions
            ? {
                hydratedAt:
                  typeof candidate.materialized.sessions.hydratedAt === "number"
                    ? candidate.materialized.sessions.hydratedAt
                    : null,
                items: materializedSessions,
              }
            : null,
        }
      : null,
  };
}

export function defaultBlueprintStartersForPreset(preset: string): WorkspaceBlueprintStarter[] {
  switch (preset.trim().toLowerCase()) {
    case "automation":
      return [
        {
          id: "automation-command",
          kind: "prompt",
          title: "Create a reusable command",
          description: "Turn a repeated workflow into a slash command for this workspace.",
          prompt:
            "Help me create a reusable /command for this workspace. Ask what workflow I want to automate, then draft the command.",
        },
        {
          id: "automation-blueprint",
          kind: "session",
          title: "Plan an automation blueprint",
          description: "Design a repeatable workflow with skills, commands, and handoff steps.",
          prompt:
            "Help me design a reusable automation blueprint for this workspace. Ask what should be standardized, then propose the workflow.",
        },
      ];
    case "minimal":
      return [
        {
          id: "minimal-explore",
          kind: "prompt",
          title: "Explore this workspace",
          description: "Summarize the files and suggest the best first task to tackle.",
          prompt: "Summarize this workspace, point out the most important files, and suggest the best first task.",
        },
      ];
    default:
      return [
        {
          id: "csv-help",
          kind: "prompt",
          title: "Work on a CSV",
          description: "Clean up or generate spreadsheet data.",
          prompt: "Help me create or edit CSV files on this computer.",
        },
        {
          id: "starter-connect-openai",
          kind: "action",
          title: "Connect ChatGPT",
          description: "Add your OpenAi provider so ChatGPT models are ready in new sessions.",
          action: "connect-openai",
        },
        {
          id: "browser-automation",
          kind: "session",
          title: "Automate Chrome",
          description: "Start a browser automation conversation right away.",
          prompt: "Help me connect to Chrome and automate a repetitive task.",
        },
      ];
  }
}

export function defaultBlueprintCopyForPreset(preset: string) {
  switch (preset.trim().toLowerCase()) {
    case "automation":
      return {
        title: "What do you want to automate?",
        body: "Start from a reusable workflow or type your own task below.",
      };
    case "minimal":
      return {
        title: "Start with a task",
        body: "Ask a question about this workspace or use a starter prompt.",
      };
    default:
      return DEFAULT_EMPTY_STATE_COPY;
  }
}

export function buildDefaultWorkspaceBlueprint(preset: string): WorkspaceBlueprint {
  const copy = defaultBlueprintCopyForPreset(preset);
  return {
    emptyState: {
      title: copy.title,
      body: copy.body,
      starters: defaultBlueprintStartersForPreset(preset),
    },
    sessions: defaultBlueprintSessionsForPreset(preset),
  };
}

export function blueprintSessions(config: WorkspaceOpenworkConfig | null | undefined): WorkspaceBlueprintSessionTemplate[] {
  return Array.isArray(config?.blueprint?.sessions)
    ? config!.blueprint!.sessions!.filter((item): item is WorkspaceBlueprintSessionTemplate => Boolean(item))
    : [];
}

export function blueprintMaterializedSessions(config: WorkspaceOpenworkConfig | null | undefined): WorkspaceBlueprintMaterializedSession[] {
  return Array.isArray(config?.blueprint?.materialized?.sessions?.items)
    ? config!.blueprint!.materialized!.sessions!.items!.filter((item): item is WorkspaceBlueprintMaterializedSession => Boolean(item))
    : [];
}

export function normalizeWorkspaceOpenworkConfig(
  value: unknown,
  preset?: string | null,
): WorkspaceOpenworkConfig {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<WorkspaceOpenworkConfig>)
      : {};

  const normalizedPreset =
    candidate.workspace?.preset?.trim() || preset?.trim() || null;

  return {
    version: typeof candidate.version === "number" ? candidate.version : 1,
    workspace:
      candidate.workspace || normalizedPreset
        ? {
            ...(candidate.workspace ?? {}),
            preset: normalizedPreset,
          }
        : null,
    authorizedRoots: Array.isArray(candidate.authorizedRoots)
      ? candidate.authorizedRoots.filter((item): item is string => typeof item === "string")
      : [],
    blueprint: normalizeBlueprint(candidate.blueprint),
    reload: candidate.reload ?? null,
  };
}
