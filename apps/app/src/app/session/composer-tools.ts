import { currentLocale, t } from "../../i18n";
import type {
  McpServerEntry,
  McpStatus,
  McpStatusMap,
  SettingsTab,
  SkillCard,
  SlashCommandOption,
} from "../types";

export type ToolMenuSection = "commands" | "skills" | "mcps";

export type ComposerToolMenuMcpItem = {
  name: string;
  status: McpStatus | undefined;
  details: string;
};

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  "application/pdf",
];

export function mergeSlashCommandsWithSkills(
  commands: SlashCommandOption[],
  skills: SkillCard[],
) {
  const merged = new Map<string, SlashCommandOption>();
  for (const command of commands) {
    merged.set(command.name, command);
  }
  for (const skill of skills) {
    if (merged.has(skill.name)) continue;
    merged.set(skill.name, {
      id: `skill:${skill.name}`,
      name: skill.name,
      description: skill.description,
      source: "skill",
    });
  }
  return Array.from(merged.values());
}

export function isImageMime(mimeType: string) {
  return ACCEPTED_IMAGE_TYPES.includes(mimeType);
}

export function isSupportedAttachmentType(mimeType: string) {
  return ACCEPTED_FILE_TYPES.includes(mimeType);
}

export function formatMcpStatusLabel(status: McpStatus | undefined) {
  switch (status?.status) {
    case "connected":
      return t("context_panel.mcp_connected", currentLocale());
    case "needs_auth":
      return t("context_panel.mcp_needs_auth", currentLocale());
    case "needs_client_registration":
      return t("context_panel.mcp_register_client", currentLocale());
    case "failed":
      return t("context_panel.mcp_failed", currentLocale());
    case "disabled":
      return t("context_panel.mcp_disabled", currentLocale());
    default:
      return t("mcp.configured", currentLocale());
  }
}

export function mcpStatusBadgeClass(status: McpStatus | undefined) {
  if (status?.status === "connected") {
    return "bg-green-3 text-green-11";
  }
  return "bg-gray-3 text-gray-10";
}

export function buildComposerToolMenuMcpItems(
  entries: McpServerEntry[],
  statuses: McpStatusMap,
) {
  return entries
    .filter((entry) => entry.config.enabled !== false)
    .map((entry): ComposerToolMenuMcpItem => ({
      name: entry.name,
      status: statuses[entry.name],
      details:
        entry.config.type === "remote"
          ? (entry.config.url ?? t("mcp.config_source", currentLocale()))
          : (entry.config.command?.join(" ") ??
            t("mcp.config_source", currentLocale())),
    }));
}

export function toolMenuSectionToSettingsTab(
  section: ToolMenuSection,
): SettingsTab {
  if (section === "skills") return "skills";
  if (section === "mcps") return "extensions";
  return "automations";
}
