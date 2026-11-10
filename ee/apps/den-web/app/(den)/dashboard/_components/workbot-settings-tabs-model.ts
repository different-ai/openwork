/** The tabs Workbot's settings are split into, with `workbotSettingsTabs` on and members' agents available. */
export type WorkbotSettingsTab = "general" | "agents" | "context";

export const WORKBOT_SETTINGS_TABS: readonly { value: WorkbotSettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "agents", label: "Agents" },
  { value: "context", label: "Data sources" },
];

/** One sentence under the tabs: what the open tab is for. */
export const WORKBOT_SETTINGS_TAB_PURPOSE: Record<WorkbotSettingsTab, string> = {
  general: "How Workbot works for members: whether it is on, the model it starts on and what it is called.",
  agents: "Each member has an agent that checks their work in the background and messages them when something needs them.",
  context: "What members' agents may read to find what needs attention. Agents never send, edit or delete through these.",
};

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

/** What each of Workbot's own settings does, shown from the "i" beside its label with `workbotSettingsTabs` on. */
export const WORKBOT_SETTING_HELP = {
  enabled: "Turns Workbot on or off for these members. Off removes the Workbot app and their agent; the Slack assistant, Automations and the desktop app are not affected.",
  model: "The model members start on in Workbot, the Slack assistant and cloud Automations that use the default model.",
  modelTest: "Sends a short test prompt to the saved default model to confirm it answers. It may use paid inference; no chats or connected apps are used.",
  name: "What Workbot is called for these members.",
} as const;

/** What the rows under What agents read mean, shown from the "i" beside each heading with `workbotSettingsTabs` on. */
export const AGENT_SOURCE_HELP = {
  policy: "On for everyone: every member's agent reads it. Members choose: each member decides. Not allowed: agents don't read it.",
  apps: "Each member's agent reads one of the allowed apps: the default, unless the member picks another allowed one.",
  other: "Other connections agents may read for context. Each has its own setting.",
  defaultApp: "The app a member's agent reads unless the member picks another app from this list.",
} as const;
