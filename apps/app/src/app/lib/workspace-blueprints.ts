import type {
  WorkspaceBlueprint,
  WorkspaceBlueprintMaterializedSession,
  WorkspaceBlueprintSessionMessage,
  WorkspaceBlueprintSessionTemplate,
  WorkspaceBlueprintStarter,
  WorkspaceOpenworkConfig,
} from "../types";
import { parseTemplateFrontmatter } from "../utils";
import { t } from "../../i18n";

import browserSetupTemplate from "../data/commands/browser-setup.md?raw";

const BROWSER_AUTOMATION_QUICKSTART_PROMPT = (() => {
  const parsed = parseTemplateFrontmatter(browserSetupTemplate);
  return (parsed?.body ?? browserSetupTemplate).trim();
})();


const defaultWelcomeBlueprintMessages = (): WorkspaceBlueprintSessionMessage[] => [
  {
    role: "assistant",
    text: t("blueprint.welcome_message"),
  },
];

export function defaultBlueprintSessionsForPreset(_preset: string): WorkspaceBlueprintSessionTemplate[] {
  return [
    {
      id: "welcome-to-openwork",
      title: t("blueprint.welcome_title"),
      messages: defaultWelcomeBlueprintMessages(),
      openOnFirstLoad: true,
    },
    {
      id: "csv-playbook",
      title: t("blueprint.csv_session_title"),
      messages: [
        {
          role: "assistant",
          text: t("blueprint.csv_session_assistant"),
        },
        {
          role: "user",
          text: t("blueprint.csv_session_user"),
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
          title: t("blueprint.starter_command_title"),
          description: t("blueprint.starter_command_desc"),
          prompt: t("blueprint.starter_command_prompt"),
        },
        {
          id: "automation-blueprint",
          kind: "session",
          title: t("blueprint.starter_blueprint_title"),
          description: t("blueprint.starter_blueprint_desc"),
          prompt: t("blueprint.starter_blueprint_prompt"),
        },
      ];
    case "minimal":
      return [
        {
          id: "minimal-explore",
          kind: "prompt",
          title: t("blueprint.starter_explore_title"),
          description: t("blueprint.starter_explore_desc"),
          prompt: t("blueprint.starter_explore_prompt"),
        },
      ];
    default:
      return [
        {
          id: "csv-help",
          kind: "prompt",
          title: t("blueprint.starter_csv_title"),
          description: t("blueprint.starter_csv_desc"),
          prompt: t("blueprint.starter_csv_prompt"),
        },
        {
          id: "starter-connect-openai",
          kind: "action",
          title: t("blueprint.starter_connect_openai_title"),
          description: t("blueprint.starter_connect_openai_desc"),
          action: "connect-openai",
        },
        {
          id: "browser-automation",
          kind: "session",
          title: t("blueprint.starter_chrome_title"),
          description: t("blueprint.starter_chrome_desc"),
          prompt: t("blueprint.starter_chrome_prompt"),
        },
      ];
  }
}

export function defaultBlueprintCopyForPreset(preset: string) {
  switch (preset.trim().toLowerCase()) {
    case "automation":
      return {
        title: t("blueprint.automation_title"),
        body: t("blueprint.automation_body"),
      };
    case "minimal":
      return {
        title: t("blueprint.minimal_title"),
        body: t("blueprint.minimal_body"),
      };
    default:
      return {
        title: t("blueprint.empty_title"),
        body: t("blueprint.empty_body"),
      };
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
