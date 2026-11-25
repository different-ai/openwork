import {
  agentPermissionDefinitions,
  agentPermissionDecisionsFor,
  agentPermissionDecisionLabels,
  agentPermissionDefaultDecision,
  agentPermissionMemberDecides,
  type AgentPermissionDefinition,
  type AgentPermissionDecision,
  type AgentPermissionAction,
  type AgentPermissionSection,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";

export type AgentPermissionsArea = "all" | "agents" | "browser";

const PRIVATE_VALUE_KEYS: readonly string[] = ["privateValueFills", "privateValueCommands", "privateValuePaste", "privateValueTerminal", "privateValueRuns"];
const BROWSER_KEYS: readonly string[] = ["websites", "browserUploads", ...PRIVATE_VALUE_KEYS];
const BLOCKED_WITH_COMPUTER_USE: readonly string[] = ["computerFiles", "computerClipboard", "appScripting"];

const BLOCKED_WITH_HOST_EXECUTION: readonly string[] = ["computerUse", "computerFiles", "computerClipboard", "appScripting", "localMcpServers"];

function forceRequired(settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null): boolean {
  return (settings.hostExecution?.decision ?? everyone?.hostExecution?.decision) === "deny";
}

export function agentPermissionToggleState(definition: AgentPermissionDefinition, decision: AgentPermissionDecision, lockKey?: string) {
  const onDecision: AgentPermissionDecision = definition.toggleMeans === "requires" ? "deny" : "allow";
  const offDecision: AgentPermissionDecision = onDecision === "deny" ? "allow" : "deny";
  const included = lockKey === "force-includes-use";
  const checked = included || decision === onDecision;
  return { checked, disabled: included, onDecision, offDecision };
}

function inArea(area: AgentPermissionsArea, key: string): boolean {
  if (area === "all") return true;
  return area === "browser" ? BROWSER_KEYS.includes(key) : !BROWSER_KEYS.includes(key);
}

const EDITOR_GROUPS: readonly { label: string; sections: readonly AgentPermissionSection[] }[] = [
  { label: "Commands and files", sections: ["commands", "files"] },
  { label: "Computer use", sections: ["computer"] },
  { label: "Web", sections: ["web"] },
  { label: "Private values", sections: ["privateValues"] },
  { label: "Skills and MCP servers", sections: ["extensions"] },
];

export function visibleAgentPermissionGroups(area: AgentPermissionsArea, options: { privateValues?: boolean } = {}) {
  const groups = area === "browser" ? [{ label: "Websites", sections: ["web"] }, { label: "Private values", sections: ["privateValues"] }] : EDITOR_GROUPS;
  return groups.map((group) => ({
    label: group.label,
    definitions: agentPermissionDefinitions.filter((definition) =>
      group.sections.includes(definition.section)
      && inArea(area, definition.key)
      && (!PRIVATE_VALUE_KEYS.includes(definition.key) || options.privateValues === true)),
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

export function storedAgentPermissionDecision(definition: AgentPermissionDefinition, team: string | null, decision: AgentPermissionDecision | undefined): AgentPermissionDecision | undefined {
  return team === null && !agentPermissionMemberDecides(definition.key) && decision === agentPermissionDefaultDecision(definition.key) ? undefined : decision;
}

export function agentPermissionBlockedBy(key: string, settings: AgentPermissionSettings, everyone: AgentPermissionSettings | null): { key: string; reason: string } | null {
  const sandboxRequired = forceRequired(settings, everyone);
  if (key === "sandboxOptOut" && sandboxRequired) {
    return { key: "force-includes-use", reason: "Included in Force OpenWork Sandbox" };
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
