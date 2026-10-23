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
  nativeDictation: {
    label: "Native dictation",
    description: "Dictate editable prompts in OpenWork and Workbot using native desktop dictation or live browser speech recognition.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  organizationGrants: {
    label: "Organization control panel and grants",
    description: "Platform admins control complimentary access and grant organizations extra or unlimited Free Auto usage, with optional expiration.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  connectionMcpServers: {
    label: "Connect: an MCP server for each connection",
    description: "Members can add one connected service, such as Gmail or Linear, to an agent like Claude Code as its own MCP server that lists only that service's tools.",
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
  agentConnectionRemoval: {
    label: "Agents remove connections",
    description: "People allowed to remove a connection can ask their agent to prepare removing it, then confirm the removal in OpenWork.",
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
  enterprisePlan: {
    label: "Enterprise plan billing",
    description: "Platform admins start a Stripe-billed Enterprise plan for an organization, with a custom price and a minimum number of users. Enterprise organizations invite people without the Free plan user limit and see their Enterprise plan on the Billing page.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  workbotDocuments: {
    label: "Workbot Documents",
    description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, and save supported text and spreadsheet edits to Drive.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotDocumentEditing: {
    label: "Workbot Documents: editing",
    description: "Members choose Edit from a document preview. Full Office editing starts their Cloud workspace only when requested. Requires Workbot Documents.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotWorkspaceAssistant: {
    label: "Workbot: workspace assistant",
    description: "Members ask Workbot about the document or calendar view they have open, chat without leaving their work, and navigate from a compact sidebar. Workbot offers to open the documents it mentions, and the conversation stays open beside the document.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotIncludedModels: {
    label: "Workbot: included OpenWork models by default",
    description: "Signed-in members chat in Workbot on their included OpenWork models without an AI Gateway provider. When the free allowance runs out, Workbot says when it resets and links admins to OpenWork Models or the workspace's model settings.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotUsageRecovery: {
    label: "Workbot: usage limits and upgrades",
    description: "Signed-in Workbot uses free Auto or the member’s paid Models Luna entitlement, with allowance recovery and permission-aware upgrades in the conversation.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  usageLimitUpgrade: {
    label: "Usage limits: one limit card with an upgrade",
    description: "When free Auto, OpenWork Models or an AI Gateway budget runs out in the desktop app, one card says what ran out, when it resets and that the message is saved, with the upgrade or request that fits the person’s role and a way to keep working with another model.",
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
  removeOpencodeZen: {
    label: "Remove OpenCode Zen models",
    description: "Desktop and OpenWork Web stop offering free OpenCode Zen models such as Big Pickle: they leave the model list, are disabled in the engine, and new chats and Automations start on the organization's models or Auto instead.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  computerUse: {
    label: "Computer use",
    description: "Let agents use Mac apps or a managed cloud desktop with a live view and Take over and Stop controls. While enabled, requested apps and windows open directly without additional OpenWork approval prompts. GUI access is experimental and is not sandboxed by structured-tool permission rules.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },

  browserDemonstrations: {
    label: "Workbot: teach browser tasks",
    description: "Demonstrate a browser task with explanations, save it as a private reusable skill, and run it with new inputs.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },

  browserLiveView: {
    label: "Workbot: browser live view",
    description: "Workbot's Browser view streams the browser page itself, sending a frame only when the page changes, instead of video of the whole browser window. Taking control still uses the full window.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },

  browserFloatingView: {
    label: "Desktop: floating and full-screen browser",
    description: "The built-in browser can float as a small live card over the chat, sit beside it, or fill the window, with a Browser button in the chat header that shows when it needs the person.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },

  remoteComputers: {
    label: "Desktop: computer use on remote computers",
    description: "Use a Linux cloud computer with its browser and desktop in OpenWork Web, or connect a VM from Desktop. Configured and conversation-owned desktops open directly when enabled, including follow-ups and internal session renewal. Take over and Stop stay available.",
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
  desktopSignInReturn: {
    label: "Desktop: sign-in returns you to the same task",
    description: "Signing in from a conversation keeps it and its draft on screen while the browser finishes, then returns to that same conversation with the draft and model intact.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  activationChecklist: {
    label: "Get set up checklist",
    description: "After their first answer, people see a Get set up checklist in Desktop and Workbot: invite a teammate, use a skill, add a model provider, share one on AI Gateway and connect an app, each checked off once it works.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  connectStandardTools: {
    label: "Connect: standard tools",
    description: "Supported clients, including OpenWork Desktop, OpenCode and Claude Code, discover connected actions, Workflows and Apps as individual tools. Capability search uses MCP tool schemas with older fields kept for compatibility. Turning this off restores the previous search view and schemas.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  teamPlan: {
    label: "Team plan checkout",
    description: "Going past 5 people moves the workspace to the Team plan at $10 per person per month, and paying sets the plan.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  selfServeEnterprise: {
    label: "Self-serve Enterprise",
    description: "Owners can buy Enterprise by card at the planned per-person price.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  environmentVariables: {
    label: "Environment variables",
    description: "Admins deploy environment variables to people's desktop agents: a value for everyone, a team or one person, or a value each person sets for themselves.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  orgPrompts: {
    label: "Prompts",
    description: "Admins write a system prompt for everyone and for each team on the team's Prompts tab. Desktops add the prompts that apply to a member to every agent's instructions: Everyone's first, then each team's by team name. Turning this off stops desktops adding them at their next sync; saved prompts are kept.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
