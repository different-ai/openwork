import {
  AGENT_HARNESS_PERMISSION_KEYS,
  agentPermissionDefinitions,
  agentPermissionDecisionsFor,
  agentPermissionDecisionLabels,
  AGENT_PERMISSION_DEFAULT_DECISION,
  type AgentPermissionDefinition,
  type AgentPermissionDecision,
  type AgentPermissionAction,
  type AgentPermissionSection,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";

/** "all" is the single Agents tab; teamPageTabs moves websites to "browser". */
export type AgentPermissionsArea = "all" | "agents" | "browser";

const BROWSER_KEYS: readonly string[] = ["websites", "browserUploads"];
const HARNESS_KEYS: readonly string[] = AGENT_HARNESS_PERMISSION_KEYS;

function inArea(area: AgentPermissionsArea, key: string): boolean {
  if (area === "all") return true;
  return area === "browser" ? BROWSER_KEYS.includes(key) : !BROWSER_KEYS.includes(key);
}

const EDITOR_GROUPS: readonly { label: string; sections: readonly AgentPermissionSection[] }[] = [
  { label: "Commands and files", sections: ["commands", "files"] },
  { label: "Computer use", sections: ["computer"] },
  { label: "Web", sections: ["web"] },
  { label: "Skills and MCP servers", sections: ["extensions"] },
];

/** Preview only: keep saved and draft settings intact while computer use is unavailable. */
export function effectiveAgentPermissionSettings(settings: AgentPermissionSettings, computerUseEnabled: boolean): AgentPermissionSettings {
  if (computerUseEnabled) return settings;
  const effective = { ...settings };
  delete effective.computerUse;
  return effective;
}

export function visibleAgentPermissionGroups(area: AgentPermissionsArea, harnessEnabled: boolean, computerUseEnabled: boolean, browserUploadsEnabled = false) {
  const groups = area === "browser" ? [{ label: "Websites", sections: ["web"] }] : EDITOR_GROUPS;
  return groups.map((group) => ({
    label: group.label,
    definitions: agentPermissionDefinitions.filter((definition) =>
      group.sections.includes(definition.section)
      && inArea(area, definition.key)
      && (harnessEnabled || !HARNESS_KEYS.includes(definition.key))
      && (computerUseEnabled || definition.key !== "computerUse")
      && (browserUploadsEnabled || definition.key !== "browserUploads")),
  })).filter((group) => group.definitions.length > 0);
}

const TRY_KINDS: readonly { action: AgentPermissionAction; label: string; placeholder: string }[] = [
  { action: "shell", label: "Command", placeholder: "git push origin main" },
  { action: "external_directory", label: "Outside folder", placeholder: "~/Documents/report.pdf" },
  { action: "webfetch", label: "Website", placeholder: "https://docs.example.com/guide" },
  { action: "browser_upload", label: "Website upload", placeholder: "https://docs.example.com/upload" },
  { action: "skill", label: "Local skill", placeholder: "meeting-notes" },
  { action: "mcp", label: "Local MCP server", placeholder: "issue-tracker" },
];

export function visibleAgentPermissionTryKinds(area: AgentPermissionsArea, harnessEnabled: boolean, computerUseEnabled: boolean, browserUploadsEnabled = false) {
  const keys = visibleAgentPermissionGroups(area, harnessEnabled, computerUseEnabled, browserUploadsEnabled).flatMap((group) => group.definitions.map((definition) => definition.key));
  return TRY_KINDS.filter((entry) => agentPermissionDefinitions.some((definition) => definition.action === entry.action && keys.includes(definition.key)));
}

export function agentPermissionChoiceOptions(definition: AgentPermissionDefinition, team: string | null): { value: AgentPermissionDecision | "inherit"; label: string }[] {
  return [
    ...(definition.key === "browserUploads" ? [{ value: "inherit" as const, label: team === null ? "Member decides" : "Use Everyone's" }] : []),
    ...agentPermissionDecisionsFor(definition).map((decision) => ({ value: decision, label: agentPermissionDecisionLabels[decision] })),
  ];
}

export function agentPermissionChoiceValue(definition: AgentPermissionDefinition, decision: AgentPermissionDecision | undefined, effective: AgentPermissionDecision): AgentPermissionDecision | "inherit" {
  return definition.key === "browserUploads" ? decision ?? "inherit" : effective;
}

/** Preserve explicit upload Ask/Allow: they differ from the member-controlled default. */
export function storedAgentPermissionDecision(definition: AgentPermissionDefinition, team: string | null, decision: AgentPermissionDecision | undefined): AgentPermissionDecision | undefined {
  return team === null && definition.key !== "browserUploads" && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision;
}

/** Keep the dependent control visible, with the same neutral lock as commands (DESIGN.md P4, C5). */
export function agentPermissionBlockedBy(key: string, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null): { key: string; reason: string } | null {
  if (key === "commands" && (settings.fileEdits?.decision ?? everyone?.fileEdits?.decision) === "deny") {
    return { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." };
  }
  if (key === "appScripting" && (settings.computerUse?.decision ?? everyone?.computerUse?.decision) === "deny") {
    return { key: "computer-use", reason: "Blocked while Use apps on the computer is blocked." };
  }
  return null;
}
