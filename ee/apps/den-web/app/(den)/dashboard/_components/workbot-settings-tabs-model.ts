/** The tabs Workbot's settings are split into, when members' agents are available. */
export type WorkbotSettingsTab = "general" | "agents" | "context";

export const WORKBOT_SETTINGS_TABS: readonly { value: WorkbotSettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "agents", label: "Proactive Mode" },
  { value: "context", label: "Connectors" },
];

/** One sentence under the tabs: what the open tab is for. */
export const WORKBOT_SETTINGS_TAB_PURPOSE: Record<WorkbotSettingsTab, string> = {
  general: "How Workbot works for members: whether it is on, the model it starts on and what it is called.",
  agents: "Each member has an agent that checks their work in the background and messages them when something needs them.",
  context: "The connectors members' agents may read to find what needs attention. Agents never send, edit or delete through these.",
};

/** Which part of the members' agents section shows: all of it, how agents work, or what they read. */
export type WorkbotAgentsPart = "all" | "policy" | "sources";

export type WorkbotSettingsParts = {
  /** Workbot's own settings: on or off, default model, name, and whether agents read the calendar. */
  general: boolean;
  /** The members' agents section, or null while another tab is open. */
  agents: WorkbotAgentsPart | null;
};

/** What the page shows. Without tabs everything is on one page, as before. */
export function workbotSettingsParts(tabs: boolean, active: WorkbotSettingsTab): WorkbotSettingsParts {
  if (!tabs) return { general: true, agents: "all" };
  if (active === "agents") return { general: false, agents: "policy" };
  if (active === "context") return { general: false, agents: "sources" };
  return { general: true, agents: null };
}

/** The tab a link to a part of the page opens (`#agent-health` is under Members' agents). */
export function workbotSettingsTabForHash(hash: string, agentHealthAnchor: string): WorkbotSettingsTab | null {
  return hash === `#${agentHealthAnchor}` ? "agents" : null;
}

/**
 * What a setting does, shown from the "i" beside its label in the standard tabbed settings. Only for settings whose
 * effect the label can't say: most rows explain themselves and have no "i".
 */
export const WORKBOT_SETTING_HELP = {
  enabled: "Turns Workbot on or off for these members. Off removes the Workbot app and their agent; the Slack assistant, Automations and the desktop app are not affected.",
} as const;
