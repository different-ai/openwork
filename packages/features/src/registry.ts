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
  managedDeployments: {
    label: "Managed deployments",
    description: "Organization admins install OpenWork in their own cloud account (AWS first) and see its health and updates in OpenWork.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  installLinks: {
    label: "Install links",
    description: "Workspace admins can create desktop install links for their organization.",
    since: "2026-10",
    deployments: everywhere,
    default: true,
  },
  mcpConnections: {
    label: "OpenWork Connect",
    description: "Members see the organization's connections, marketplace capabilities on the agent rail, and the desktop Connect tab.",
    since: "2026-10",
    deployments: everywhere,
    default: true,
  },
  driveResumableUploads: {
    label: "Resumable Google Drive uploads",
    description: "Members upload larger workspace files to Google Drive and prepare upload sessions for external clients.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  implicitCloudSkills: {
    label: "Implicit Cloud skills",
    description: "Agents discover organization skills automatically without waiting for Cloud before starting a task.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  denFlatPageHeaders: {
    label: "Den: flat page headers",
    description: "Members see compact, readable page headings in Den instead of decorative gradient banners.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  analyticsIntegrated: {
    label: "Den: integrated analytics",
    description: "Admins see analytics in the same style as Library and Connectors, with links to manage the items they use.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  dashboardActivity: {
    label: "Dashboard activity",
    description: "Organization admins see recent additions and skill updates on their dashboard instead of Quick add.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  libraryUsage: {
    label: "Library usage",
    description: "Organization admins see in Analytics how often each skill, plugin and connector is used, by how many people, which calls fail, and what nobody uses, so they can decide what to keep.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  modelsAnalytics: {
    label: "OpenWork Models task analytics",
    description: "Organization admins can opt in to task analytics for OpenWork Models.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  auditLogs: {
    label: "Audit logs",
    description: "Organization admins can read and configure audit logs. Capture still needs an audit entitlement.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  auditLogsCompact: {
    label: "Audit logs: compact Den rows",
    description: "Organization admins read audit operations and capture settings in compact Den rows, with changes and technical details expanded on demand.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  orgManagedDashboards: {
    label: "Dashboards",
    description: "Organization admins publish dashboards to members in Den and the desktop app.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  slackAssistant: {
    label: "Slack Assistant",
    description: "Answers Slack mentions and DMs for the organization after the Slack connector is set up.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  slackWorkbotReplies: {
    label: "Slack: replies like Workbot",
    description: "OpenWork in Slack writes its reply as it works, reacts to messages with an emoji, and takes bigger jobs into the background, posting the result in the thread when done.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  headlessAutomations: {
    label: "Cloud Automations: headless runtime",
    description: "Runs the organization's cloud Automations on the shared headless runner. Needs the deployment's headless runner and a plan that includes it.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbot: {
    label: "Workbot",
    description: "Members can use Workbot. Needs the deployment's Workbot app.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  calendarPolish: {
    label: "Calendar and Workbot polish",
    description: "Members recognize their organization's default model and meeting providers, and can run stopped Workbot tasks again.",
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
  workbotCalendar: {
    label: "Calendar: Workbot",
    description: "Workbot members see a Calendar tab with Workbot's scheduled work next to meetings from their connected Google or Outlook calendar. Needs Workbot.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotSideChats: {
    label: "Workbot: side chats",
    description: "Members can start side chats in Workbot next to their main chat, for one topic at a time. Needs Workbot.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbotDefaultModel: {
    label: "Workbot: default model",
    description: "Organization admins choose, in Manage › Workbot, the model Workbot, the Slack assistant and cloud Automations set to the cloud default answer with. Needs Workbot.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  litellm: {
    label: "AI Gateway: LiteLLM",
    description: "Organization admins can connect their own LiteLLM proxy to AI Gateway, with one shared key, each person's own key, or keys OpenWork creates for each person.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  permissions: {
    label: "Permissions",
    description: "Organization admins choose what members, admins and each team can do, instead of the fixed Member and Admin defaults.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  gatewayCloudSignIn: {
    label: "AI Gateway: AWS and Microsoft sign-in",
    description: "Organization admins can add Microsoft Foundry, and let each person sign in to Amazon Bedrock with AWS IAM Identity Center or to Microsoft Foundry with Microsoft Entra ID instead of sharing one key.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  engineV2Upgrade: {
    label: "Desktop: upgrade prompt to OpenCode v2",
    description: "Desktop members still on OpenCode v1 see a short notice offering to upgrade: their chats are copied to v2 with a backup, then OpenWork switches engines.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  opencodePlugin: {
    label: "OpenCode plugin sign-in",
    description: "People can sign in to OpenWork from the OpenCode plugin, approve it as \"OpenWork - OpenCode Plugin\", and land back on OpenCode afterwards. Applies to the whole deployment; organization overrides have no effect.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  platformAuditReads: {
    label: "Platform audit: read-only requests",
    description: "Platform administrators also get evidence of successful read-only platform requests (session reads, discovery documents). Applies to the whole deployment; organization overrides have no effect.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
