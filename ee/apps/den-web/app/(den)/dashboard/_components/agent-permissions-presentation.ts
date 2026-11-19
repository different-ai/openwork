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
  sandboxTools: boolean;
};

function forceRequired(settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null): boolean {
  return (settings.hostExecution?.decision ?? everyone?.hostExecution?.decision) === "deny";
}

function requires(setting: AgentPermissionSettings[keyof AgentPermissionSettings]): boolean {
  return setting?.decision === "deny";
}

/**
 * Stored and inherited requirements stay visible even after the rollout ends
 * (P4). A switch that was turned back off is not a requirement: once the
 * rollout is off it leaves the editor again.
 */
export function sandboxRequirementVisibility(features: AgentPermissionEditorFeatures, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null) {
  return {
    hostExecution: features.sandboxTools || requires(settings.hostExecution) || requires(everyone?.hostExecution),
    sandboxOptOut: features.sandboxTools || requires(settings.sandboxOptOut) || requires(everyone?.sandboxOptOut) || forceRequired(settings, everyone),
  };
}

export function agentPermissionToggleState(definition: AgentPermissionDefinition, decision: AgentPermissionDecision, lockKey?: string) {
  const onDecision: AgentPermissionDecision = definition.toggleMeans === "requires" ? "deny" : "allow";
  const offDecision: AgentPermissionDecision = onDecision === "deny" ? "allow" : "deny";
  const included = lockKey === "force-includes-use";
  const checked = included || decision === onDecision;
  return { checked, disabled: included || (lockKey === "sandbox-off" && !checked), onDecision, offDecision };
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

export function visibleAgentPermissionGroups(area: AgentPermissionsArea, options: Partial<Record<keyof ReturnType<typeof sandboxRequirementVisibility>, boolean>> = {}) {
  const groups = area === "browser" ? [{ label: "Websites", sections: ["web"] }] : EDITOR_GROUPS;
  return groups.map((group) => ({
    label: group.label,
    definitions: agentPermissionDefinitions.filter((definition) =>
      group.sections.includes(definition.section)
      && inArea(area, definition.key)
      && ((definition.key !== "hostExecution" && definition.key !== "sandboxOptOut") || options[definition.key] !== false)),
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

export function agentPermissionChoiceOptions(definition: AgentPermissionDefinition, team: string | null): { value: AgentPermissionDecision | "inherit"; label: string }[] {
  return [
    ...(agentPermissionMemberDecides(definition.key) ? [{ value: "inherit" as const, label: team === null ? "Member decides" : "Use Everyone's" }] : []),
    ...agentPermissionDecisionsFor(definition).map((decision) => ({ value: decision, label: agentPermissionDecisionLabels[decision] })),
  ];
}

export function agentPermissionChoiceValue(definition: AgentPermissionDefinition, decision: AgentPermissionDecision | undefined, effective: AgentPermissionDecision): AgentPermissionDecision | "inherit" {
  return agentPermissionMemberDecides(definition.key) ? decision ?? "inherit" : effective;
}

/** Preserve an explicit Ask/Allow of a member-decided permission: they differ from the member-controlled default. */
export function storedAgentPermissionDecision(definition: AgentPermissionDefinition, team: string | null, decision: AgentPermissionDecision | undefined): AgentPermissionDecision | undefined {
  return team === null && !agentPermissionMemberDecides(definition.key) && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision;
}

/** Keep the dependent control visible, with the same neutral lock as commands (DESIGN.md P4, C5). */
export function agentPermissionBlockedBy(key: string, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null, features?: AgentPermissionEditorFeatures): { key: string; reason: string } | null {
  const sandboxRequired = forceRequired(settings, everyone);
  if (key === "sandboxOptOut" && sandboxRequired) {
    return { key: "force-includes-use", reason: "Included in Force OpenWork Sandbox" };
  }
  if (features && !features.sandboxTools) {
    if (key === "hostExecution") {
      return {
        key: "sandbox-off",
        reason: sandboxRequired
          ? "Agents can't run while the sandbox is unavailable and Force OpenWork Sandbox is on."
          : "The sandbox is turned off for this organization.",
      };
    }
    if (key === "sandboxOptOut") {
      return { key: "sandbox-off", reason: "The sandbox is turned off for this organization." };
    }
  }
  if (BLOCKED_WITH_HOST_EXECUTION.includes(key) && sandboxRequired) {
    return { key: "host-execution", reason: "Blocked while Force OpenWork Sandbox is on." };
  }
  if (key === "commands" && (settings.fileEdits?.decision ?? everyone?.fileEdits?.decision) === "deny") {
    return { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." };
  }
  if (BLOCKED_WITH_COMPUTER_USE.includes(key) && (settings.computerUse?.decision ?? everyone?.computerUse?.decision) === "deny") {
    return { key: "computer-use", reason: "Blocked while Use apps on the computer is blocked." };
  }
  return null;
}
