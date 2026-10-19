/**
 * OpenWork feature registry: the one place a feature is declared.
 *
 * This is the file you edit to add a feature. Read
 * .opencode/skills/add-a-feature/SKILL.md first. Every new user-visible
 * feature, or a change existing users would notice, starts here, off, before
 * any feature code is written.
 *
 * A feature is rolled out, and reverted, along several dimensions:
 *
 *   deployments   which products it exists on (OpenWork Cloud, self-hosted)
 *   everyone      on or off for everyone on the deployment, changed in /admin
 *                 without a deploy
 *   organization  platform admins turn it on or off for one organization in /admin
 *   operator      a self-hosted operator locks it on or off for the whole install (Helm)
 *   kill switch   turns it off everywhere at once, outranking everything above
 *
 * The entry only declares what is fixed in code. The on/off state, kill
 * switches and per-organization overrides live in the database of each
 * deployment, and start from `default`. Run `pnpm features:sync` after
 * editing this file.
 *
 * Keys are permanent: the same name is the Helm values key, the
 * DEN_FEATURE_<KEY> environment variable, the API field, and the stored rows.
 * Use lowerCamelCase with no consecutive capitals.
 */

export type FeatureDeployment = "cloud" | "self_hosted"

export type FeatureDefinition = {
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** Year and month the entry was added or last changed, e.g. "2026-10". */
  since: `${number}-${number}`
  /** Products it exists on. Leave one out on purpose, e.g. ["cloud"] for cloud-only. */
  deployments: readonly FeatureDeployment[]
  /** On or off for everyone on a fresh deployment: false for new work, true once everyone has it. */
  default: boolean
  /**
   * The switch is part of the product (e.g. platform admins turn Connect off for
   * one organization), not a temporary rollout. Rollouts are deleted once done;
   * `pnpm features:check` asks for a decision six months after `since`.
   */
  permanent?: boolean
}

function defineFeatures<const T extends Record<string, FeatureDefinition>>(features: T): T {
  return features
}

const everywhere = ["cloud", "self_hosted"] as const

export const FEATURES = defineFeatures({
  cloudAgentGateway: {
    label: "Cloud agents use the organization AI Gateway",
    description: "Choose and run cloud-agent models through the organization's AI Gateway access instead of the runner's shared model credentials.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  liveProviderSync: {
    label: "Live provider sync",
    description: "Keep desktop OpenCode v2 models up to date with the organization's AI Gateway in real time.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  offlineRecovery: {
    label: "Connection failure presentation",
    description: "Show compact App connection failures and a discreet offline indicator in OpenCode v2 conversations.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  secureSecretFields: {
    label: "Secure keys in chat",
    description: "When an agent sets up a connection, plugin or AI Gateway provider that needs keys, people enter them in private fields in the chat and the agent continues once they are saved. Key fields across OpenWork and OpenWork Cloud can be shown while typing and show saved keys as Replace rows.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  modelsAnalyticsUi: {
    label: "Models analytics",
    description: "Organization admins can view Models & usage analytics and shared model usage limits. Deprecated 2026-10-14: UI hidden behind modelsAnalyticsUi (default off). Most likely delete within 4 weeks (by 2026-11-11) unless an org depends on it.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  taskAnalyticsUi: {
    label: "Task analytics",
    description: "Members with analytics access can view task activity and consumption, and admins can configure analytics integrations. Deprecated 2026-10-14: UI hidden behind taskAnalyticsUi (default off). Most likely delete within 4 weeks (by 2026-11-11) unless an org depends on it.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  managedDeployments: {
    label: "Managed deployments",
    description: "Organization admins install OpenWork in their own AWS account or Google Cloud project and see its health and updates in OpenWork, and agents connected to OpenWork can create and follow those deployments.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  slackAssistant: {
    label: "Slack Assistant",
    description: "Answers Slack mentions and DMs for the organization after the Slack connector is set up.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotTeamLinks: {
    label: "Workbot: team settings links",
    description: "Members with team management access can open their organization's Workbot settings and app connections from Workbot.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotFirstRun: {
    label: "Workbot: first sign-in",
    description: "People signing in to Workbot choose or create their workspace without leaving sign-in, with a clear next action when Workbot is unavailable.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotInlineConnect: {
    label: "Workbot: connect accounts",
    description: "Members connect their assigned apps directly from Workbot and return to the same view after consent.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotDocuments: {
    label: "Workbot Documents",
    description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, and save supported text and spreadsheet edits to Drive.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotWorkspaceAssistant: {
    label: "Workbot: workspace assistant",
    description: "Members ask Workbot about the document or calendar view they have open, chat without leaving their work, and navigate from a compact sidebar.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotGuidedNavigation: {
    label: "Workbot: show me in the workspace",
    description: "Workbot offers to open the documents it mentions, and the conversation stays open beside the document. Needs the workspace assistant.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  automationCalendar: {
    label: "Calendar: desktop app",
    description: "Members see a Calendar in the desktop app with their Automations next to meetings from their connected Google or Outlook calendar.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  engineV2ForceUpgrade: {
    label: "Upgrade everyone to OpenCode v2",
    description: "Desktop and web instances copy chats with a backup and switch to OpenCode v2 automatically when idle, without asking for consent.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  remoteSessionEvents: {
    label: "Remote session events",
    description: "MCP clients can subscribe to changes in their remote session receipts and read the current state after reconnecting.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  remoteSessionSubagents: {
    label: "Desktop: tasks on other computers as sub-agents",
    description: "A task the agent starts on the cloud or another computer shows in the chat like a sub-agent: whether it is working, needs an answer or finished, and its conversation, which people can open, follow up on and stop.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  headlessDurableTurns: {
    label: "Workbot: tasks keep going on their own",
    description: "Workbot, Slack and Automations answers keep going after a restart, deploy or server failure, without waiting for someone to reopen the chat.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
