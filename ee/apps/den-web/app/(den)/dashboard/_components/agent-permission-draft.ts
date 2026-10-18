import { agentPermissionDefinitions, normalizeAgentPermissionSetting, type AgentPermissionSettings } from "@openwork/types/den/agent-permissions";

/** Reapply only the person's edits, never an old snapshot of another tab's settings. */
export function rebaseAgentPermissionDraft(before: AgentPermissionSettings, draft: AgentPermissionSettings, latest: AgentPermissionSettings): AgentPermissionSettings {
  const merged = { ...latest };
  for (const definition of agentPermissionDefinitions) {
    const oldValue = normalizeAgentPermissionSetting(definition, before[definition.key]);
    const newValue = normalizeAgentPermissionSetting(definition, draft[definition.key]);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    const value = draft[definition.key];
    if (value) merged[definition.key] = value;
    else delete merged[definition.key];
  }
  return merged;
}
