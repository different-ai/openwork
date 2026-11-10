/** The tabs Workbot's settings are split into, with `workbotSettingsTabs` on and members' agents available. */
export type WorkbotSettingsTab = "general" | "agents" | "context";

export const WORKBOT_SETTINGS_TABS: readonly { value: WorkbotSettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "agents", label: "Members' agents" },
  { value: "context", label: "What agents read" },
];

/** Which part of the members' agents section shows: all of it, how agents work, or what they read. */
export type WorkbotAgentsPart = "all" | "policy" | "sources";

export type WorkbotSettingsParts = {
  /** Workbot's own settings: on or off, default model, step limit, name. */
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
