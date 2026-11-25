export type WorkbotSettingsTab = "general" | "agents" | "context";

export const WORKBOT_SETTINGS_TABS: readonly { value: WorkbotSettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "agents", label: "Proactive Mode" },
  { value: "context", label: "Connectors" },
];

export const WORKBOT_SETTINGS_TAB_PURPOSE: Record<WorkbotSettingsTab, string> = {
  general: "How Workbot works for members: whether it is on, the model it starts on and what it is called.",
  agents: "Each member has an agent that checks their work in the background and messages them when something needs them.",
  context: "The connectors members' agents may read to find what needs attention. Agents never send, edit or delete through these.",
};

export type WorkbotAgentsPart = "all" | "policy" | "sources";

export type WorkbotSettingsParts = {
  general: boolean;
  agents: WorkbotAgentsPart | null;
};

export function workbotSettingsParts(tabs: boolean, active: WorkbotSettingsTab): WorkbotSettingsParts {
  if (!tabs) return { general: true, agents: "all" };
  if (active === "agents") return { general: false, agents: "policy" };
  if (active === "context") return { general: false, agents: "sources" };
  return { general: true, agents: null };
}

export function workbotSettingsTabForHash(hash: string, agentHealthAnchor: string): WorkbotSettingsTab | null {
  return hash === `#${agentHealthAnchor}` ? "agents" : null;
}

export const WORKBOT_SETTING_HELP = {
  enabled: "Turns Workbot on or off for these members. Off removes the Workbot app and their agent; the Slack assistant, Automations and the desktop app are not affected.",
} as const;
