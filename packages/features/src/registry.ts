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
  liveProviderSync: {
    label: "Live provider sync",
    description: "Keep desktop OpenCode v2 models up to date with the organization's AI Gateway in real time.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  googleDocumentTools: {
    label: "Google Docs: focused reading and edits",
    description: "Connected assistants inspect document tabs and headings, read or search bounded passages, and replace text against the revision they read.",
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
  rememberLastOrganization: {
    label: "Remember last organization",
    description: "Return to the last organization used by the same account on this server after signing in again. Invite and installation links keep their selected organization.",
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
  memberListToolbars: {
    label: "Members: consistent list toolbars",
    description: "Filter members, teams and roles beside their add action, with compact member rows and secondary actions in the list menu.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  appBuildProgress: {
    label: "App build progress",
    description: "While an agent creates or changes an MCP App, the chat shows each stage it goes through (finding and checking tools, writing the App, building and verifying it) as a checklist with a progress bar.",
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
  desktopPolicyScreenRemoval: {
    label: "Desktop suggestions in teams",
    description: "Manage prompt suggestions in Everyone and team Desktop tabs instead of Advanced Desktop policies. Requires team page tabs; turning off restores the policy screens without changing stored policies.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  teamMembershipCache: {
    label: "Team membership cache",
    description: "Reduce repeated team lookups while keeping access changes immediate. Enable only after every API instance runs revision-aware team writes.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  managedDeploymentsGcp: {
    label: "GCP managed deployments",
    description: "Organization admins approve OpenWork installations in their own Google Cloud project and track health and updates.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  managedDeploymentsMcp: {
    label: "Managed deployments in agents",
    description: "Agents connected to OpenWork can check deployment readiness, create deployments, prepare the cloud approval link or command, and follow progress until the deployment is ready.",
    since: "2026-10",
    deployments: ["cloud"],
    default: false,
  },
  managedDeployments: {
    label: "Managed deployments",
    description: "Organization admins install OpenWork in their own cloud account (AWS first) and see its health and updates in OpenWork.",
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
  slackWorkbotReplies: {
    label: "Slack: replies like Workbot",
    description: "OpenWork in Slack writes its reply as it works, reacts to messages with an emoji, and takes bigger jobs into the background, posting the result in the thread when done.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbot: {
    label: "Workbot",
    description: "Members can use Workbot, with side chats, a Calendar tab of its scheduled work and the option to run stopped tasks again, and organization admins choose the default model Workbot, the Slack assistant and cloud Automations answer with. Needs the deployment's Workbot app.",
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
  automationCalendar: {
    label: "Calendar: desktop app",
    description: "Members see a Calendar in the desktop app with their Automations next to meetings from their connected Google or Outlook calendar.",
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
  teamRoles: {
    label: "Team roles",
    description: "Members › Teams shows each team's role (Member, Admin or Custom) with one Change role action, and Members gets a Roles tab to see and create roles.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  sharedRoles: {
    label: "Shared roles",
    description: "A custom role can be given to more than one team: Change role lists every role, each role's page lists its teams, and a role can be created before any team has it. Needs Team roles and Permissions.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  agentPermissions: {
    label: "Agent permissions",
    description: "Organization admins choose what agents can do on members' computers: run commands, edit files, open websites and use local skills and MCP servers, for everyone or per team.",
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
  backgroundShellTasks: {
    label: "Desktop: running background tasks in chat",
    description: "The desktop chat shows how many commands the agent left running in the background, and adds a short row when each one finishes.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  orgDefaultModel: {
    label: "Desktop: organization default model",
    description: "Organization admins choose the model new desktop chats start with, for everyone or per team. Applies to the OpenCode v2 engine only; members can still change the model in each chat.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  gatewayProviderUsageLimits: {
    label: "AI Gateway: usage limits per provider",
    description: "Admins can attach a spend limit to one AI provider. Spend on that provider counts toward its own limit instead of the default limit, and members see which provider ran out.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  teamAccessRows: {
    label: "Team access rows",
    description: "Team plugin access shows compact rows with clear access sources and a confirmation before revoking a team grant.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  teamPageTabs: {
    label: "Team page: Browser and Models tabs",
    description: "Each team's page, and Everyone's, gets a Browser tab for the pages agents and the built-in browser can open, and a Models tab with the AI providers the team can use, its spend limits and its default model.",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  inviteLinkVerifiesEmail: {
    label: "Invite links verify the invited email",
    description: "Creating an account from an invitation link, emailed or shared by an admin, counts as verifying that email, so the invited person joins without entering an emailed code.",
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
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
