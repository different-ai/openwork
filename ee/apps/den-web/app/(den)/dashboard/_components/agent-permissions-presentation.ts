import {
  agentPermissionDefinitions,
  agentPermissionDecisionsFor,
  agentPermissionDecisionLabels,
  AGENT_PERMISSION_DEFAULT_DECISION,
  agentPermissionMemberDecides,
  type AgentPermissionDefinition,
  type AgentPermissionDecision,
  type AgentPermissionAction,
  type AgentPermissionSection,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";

/** "all" is the single Agents tab; teamPageTabs moves websites to "browser". */
export type AgentPermissionsArea = "all" | "agents" | "browser";

const BROWSER_KEYS: readonly string[] = ["websites", "browserUploads"];
/** Rows that blocking computer use blocks too, shown with its lock. */
const BLOCKED_WITH_COMPUTER_USE: readonly string[] = ["computerFiles", "computerClipboard", "appScripting"];

/** Rows the host refuses while tools may not run on the computer (sandbox-only). */
const BLOCKED_WITH_HOST_EXECUTION: readonly string[] = ["computerUse", "computerFiles", "computerClipboard", "appScripting", "localMcpServers"];

/** What the editor shows beyond the definitions: rollouts it reads from the organization. */
export type AgentPermissionEditorFeatures = {
  /** The sandboxTools rollout. Off hides execution location unless it is already set. */
  sandboxOnly: boolean;
};

/**
 * Sandbox-only is offered with its rollout on. A requirement saved earlier
 * stays on screen with the rollout off, so it can be seen and removed
 * (DESIGN.md P4): it keeps blocking host tools until then.
 */
export function hostExecutionRowVisible(features: AgentPermissionEditorFeatures | undefined, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null): boolean {
  if (!features || features.sandboxOnly) return true;
  return settings.hostExecution !== undefined || everyone?.hostExecution !== undefined;
}

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

export function visibleAgentPermissionGroups(area: AgentPermissionsArea, options: { hostExecution?: boolean } = {}) {
  const groups = area === "browser" ? [{ label: "Websites", sections: ["web"] }] : EDITOR_GROUPS;
  return groups.map((group) => ({
    label: group.label,
    definitions: agentPermissionDefinitions.filter((definition) =>
      group.sections.includes(definition.section)
      && inArea(area, definition.key)
      && (definition.key !== "hostExecution" || options.hostExecution !== false)),
  })).filter((group) => group.definitions.length > 0);
}

const TRY_KINDS: readonly { action: AgentPermissionAction; label: string; placeholder: string }[] = [
  { action: "shell", label: "Command", placeholder: "git push origin main" },
  { action: "external_directory", label: "Outside folder", placeholder: "~/Documents/report.pdf" },
  { action: "webfetch", label: "Website", placeholder: "https://docs.example.com/guide" },
  { action: "browser_upload", label: "Website upload", placeholder: "https://docs.example.com/upload" },
  { action: "file_send", label: "File to a connected account", placeholder: "report.pdf" },
  { action: "skill", label: "Local skill", placeholder: "meeting-notes" },
  { action: "mcp", label: "Local MCP server", placeholder: "issue-tracker" },
];

export function visibleAgentPermissionTryKinds(area: AgentPermissionsArea) {
  const keys = visibleAgentPermissionGroups(area).flatMap((group) => group.definitions.map((definition) => definition.key));
  return TRY_KINDS.filter((entry) => agentPermissionDefinitions.some((definition) => definition.action === entry.action && keys.includes(definition.key)));
}

export function agentPermissionChoiceOptions(definition: AgentPermissionDefinition, team: string | null, inheritedDecision?: AgentPermissionDecision): { value: AgentPermissionDecision | "inherit"; label: string }[] {
  if (definition.control === "execution-location") {
    return [
      ...(team === null || inheritedDecision === undefined ? [{ value: "inherit" as const, label: "Member chooses" }] : []),
      { value: "allow", label: "On this computer" },
      { value: "deny", label: "In a sandbox (isolated)" },
    ];
  }
  return [
    ...(agentPermissionMemberDecides(definition.key) ? [{ value: "inherit" as const, label: team === null ? "Member decides" : "Use Everyone's" }] : []),
    ...agentPermissionDecisionsFor(definition).map((decision) => ({ value: decision, label: agentPermissionDecisionLabels[decision] })),
  ];
}

export function agentPermissionChoiceValue(definition: AgentPermissionDefinition, decision: AgentPermissionDecision | undefined, effective: AgentPermissionDecision, inheritedDecision?: AgentPermissionDecision): AgentPermissionDecision | "inherit" {
  if (definition.control === "execution-location") return decision ?? inheritedDecision ?? "inherit";
  return agentPermissionMemberDecides(definition.key) ? decision ?? "inherit" : effective;
}

/** Preserve an explicit Ask/Allow of a member-decided permission: they differ from the member-controlled default. */
export function storedAgentPermissionDecision(definition: AgentPermissionDefinition, team: string | null, decision: AgentPermissionDecision | undefined): AgentPermissionDecision | undefined {
  return team === null && definition.control !== "execution-location" && !agentPermissionMemberDecides(definition.key) && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision;
}

/** Keep the dependent control visible, with the same neutral lock as commands (DESIGN.md P4, C5). */
export function agentPermissionBlockedBy(key: string, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null, features?: AgentPermissionEditorFeatures): { key: string; reason: string } | null {
  const sandboxRequired = (settings.hostExecution?.decision ?? everyone?.hostExecution?.decision) === "deny";
  if (key === "hostExecution" && sandboxRequired && features && !features.sandboxOnly) {
    return { key: "sandbox-off", reason: "The sandbox is turned off, so agents can't run for these members. Remove the sandbox requirement to let them choose again." };
  }
  if (BLOCKED_WITH_HOST_EXECUTION.includes(key) && sandboxRequired) {
    return { key: "host-execution", reason: "Blocked while commands run in a sandbox (isolated)." };
  }
  if (key === "commands" && (settings.fileEdits?.decision ?? everyone?.fileEdits?.decision) === "deny") {
    return { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." };
  }
  if (BLOCKED_WITH_COMPUTER_USE.includes(key) && (settings.computerUse?.decision ?? everyone?.computerUse?.decision) === "deny") {
    return { key: "computer-use", reason: "Blocked while Use apps on the computer is blocked." };
  }
  return null;
}
