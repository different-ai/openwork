import { desktopExecutionPolicySchema, desktopPolicyDefaults, desktopPolicyDefinitions, resolveTeamAccessCapabilities, type DesktopExecutionPolicy, type TeamAccess } from "@openwork/types/den/desktop-policies";

export const teamCapabilities = desktopPolicyDefinitions.filter((entry) => entry.restrictedValue !== null);

export type TeamPermissionDraft = { access: TeamAccess; execution: DesktopExecutionPolicy };

export function teamPermissionDraft(policy?: { access?: TeamAccess; execution?: DesktopExecutionPolicy }): TeamPermissionDraft {
  return {
    access: { mode: "custom", capabilities: policy?.access ? resolveTeamAccessCapabilities(policy.access) : { ...desktopPolicyDefaults } },
    execution: policy?.execution ?? desktopExecutionPolicySchema.parse({}),
  };
}

export function teamWebsiteSummary(execution: DesktopExecutionPolicy): string {
  if (execution.browserOrigins === undefined) return "All websites";
  return execution.browserOrigins.length ? `${execution.browserOrigins.length} approved ${execution.browserOrigins.length === 1 ? "site" : "sites"}` : "Browsing blocked";
}

const executionLabels: Record<keyof DesktopExecutionPolicy, string> = {
  commands: "Run computer commands",
  blockedCommands: "Blocked command patterns",
  browserOrigins: "Browse websites",
  blockBrowserUploads: "Upload files & submit forms",
};

function executionChoices(execution: DesktopExecutionPolicy): Record<keyof DesktopExecutionPolicy, string> {
  return {
    commands: execution.commands === "allow" ? "Allowed" : "Blocked",
    blockedCommands: [...new Set(execution.blockedCommands)].sort().join("\n") || "None",
    browserOrigins: execution.browserOrigins?.length ? [...new Set(execution.browserOrigins)].sort().join("\n") : teamWebsiteSummary(execution),
    blockBrowserUploads: execution.blockBrowserUploads ? "Blocked" : "Allowed",
  };
}

export function teamPermissionChanges(before: TeamPermissionDraft, after: TeamPermissionDraft) {
  const previous = executionChoices(before.execution);
  const next = executionChoices(after.execution);
  const execution = desktopExecutionPolicySchema.keyof().options.flatMap((key) => previous[key] === next[key] ? [] : [{ label: executionLabels[key], before: previous[key], after: next[key] }]);
  const capabilities = teamCapabilities.flatMap((entry) => before.access.capabilities[entry.id] === after.access.capabilities[entry.id] ? [] : [{
    label: entry.teamLabel,
    before: before.access.capabilities[entry.id] ? "Allowed" : "Blocked",
    after: after.access.capabilities[entry.id] ? "Allowed" : "Blocked",
  }]);
  return [...execution, ...capabilities];
}
