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
 * Features are for what people in organizations get. Controls that only
 * platform admins see in /admin (the deployment's own management) are not
 * features: ship them without a flag.
 *
 * Every entry names its author and, for new features, links an internal doc
 * under docs/ with a screenshot when the feature is visual.
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

/**
 * Groups for /admin, in the order they are shown. Pick the one a platform
 * admin would look under; add a group only when none fits.
 */
export const FEATURE_CATEGORIES = {
  billing: { label: "Plans, billing and usage", description: "Plans, checkout, grants and what people see when an allowance runs out." },
  models: { label: "Models and providers", description: "Which models people can pick and how providers stay in sync." },
  connect: { label: "Connect and integrations", description: "Connected services, their tools and MCP servers." },
  computerUse: { label: "Computer use and browser", description: "Agents using apps, browsers and remote computers." },
  workbot: { label: "Workbot", description: "Documents, the workspace assistant and navigation in Workbot." },
  automations: { label: "Automations", description: "Scheduled work and where it shows up." },
  administration: { label: "Administration and security", description: "Organization controls, deployments and how Den stores sign-ins." },
  experience: { label: "Onboarding and everyday use", description: "Getting set up, signing in, dictation, imports and Apps." },
} as const satisfies Record<string, { label: string; description: string }>

export type FeatureCategory = keyof typeof FEATURE_CATEGORIES

export type FeatureDefinition = {
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** Group the feature is listed under in /admin. */
  category: FeatureCategory
  /** Day the flag was first added to this registry, e.g. "2026-10-26". Never changes. */
  added: `${number}-${number}-${number}`
  /** Year and month the entry was added or last changed, e.g. "2026-10". */
  since: `${number}-${number}`
  /**
   * GitHub handle of the person who owns the feature: who to ask what it does,
   * whether it is safe to turn on, and when the flag can go. Shown in /admin.
   */
  author: string
  /**
   * Repo path of the internal doc that explains the feature, e.g.
   * "docs/features/new-thing/README.md". Internal docs live in the repo's
   * docs/ folder, not the published site in packages/docs. A visual feature
   * shows at least one screenshot (stored next to the doc); any other feature
   * says what changes, for whom, how to try it and what turning it off does.
   * Linked from /admin. Required for new features (`pnpm features:check`).
   */
  docs?: `docs/${string}.md`
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
  nativeAffordanceCodeMode: {
    label: "OpenWork commands in Code Mode",
    description: "Let assistants compose OpenWork queries and sidebar commands in Code Mode using the same checked app actions.",
    category: "experience",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/development/native-affordance-codemode.md",
    deployments: everywhere,
    default: false,
  },
  libraryConnectorNavigation: {
    label: "Library: connected items and skill previews",
    description: "Open assigned connectors in My Library from Manage and expand skills in plugins and My Library.",
    category: "connect",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/library-connector-navigation/README.md",
    deployments: everywhere,
    default: false,
  },
  mcpAppLibraries: {
    label: "Apps: built-in libraries",
    description: "Apps built in OpenWork can use icons, charts, animation, 3D and SVG drawing from pinned libraries bundled into each App, with no remote scripts or network access.",
    category: "experience",
    added: "2026-10-23",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/mcp-app-libraries/README.md",
    deployments: everywhere,
    default: false,
  },
  autoRouter: {
    label: "AI Gateway: Auto Router",
    description: "Admins describe when to use each AI Gateway model, and members can pick Auto: each prompt goes to the model and thinking level that fits it best.",
    category: "models",
    added: "2026-10-26",
    since: "2026-10",
    author: "OmarMcAdam",
    docs: "docs/features/auto-router/README.md",
    deployments: ["cloud"],
    default: false,
  },
  mermaidZoom: {
    label: "Desktop: zoom into diagrams",
    description: "Mermaid diagrams in chat and file previews can be zoomed, panned and opened full screen so large diagrams are readable.",
    category: "experience",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/mermaid-zoom/README.md",
    deployments: everywhere,
    default: false,
  },
  administratorRecovery: {
    label: "Deploy-time administrator recovery",
    description: "Run a one-time, operator-selected Admin-team permission repair at deployment; disabling stops future repairs, not existing grants.",
    category: "administration",
    added: "2026-10-23",
    since: "2026-10",
    author: "yomgui",
    deployments: everywhere,
    default: false,
  },
  nativeDictation: {
    label: "Native dictation",
    description: "Dictate editable prompts in OpenWork and Workbot using native desktop dictation or live browser speech recognition.",
    category: "experience",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/native-dictation.md",
    deployments: everywhere,
    default: false,
  },
  sandboxOrgs: {
    label: "Sandbox organizations",
    description: "Platform admins create try-it-out organizations from /admin with fictional workplace connectors, included models and a shareable join link that expires.",
    category: "administration",
    added: "2026-10-23",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: ["cloud"],
    default: false,
  },
  connectionMcpServers: {
    label: "Connect: an MCP server for each connection",
    description: "Members can add one connected service, such as Gmail or Linear, to an agent like Claude Code as its own MCP server that lists only that service's tools.",
    category: "connect",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  slackSendAsBot: {
    label: "Connect: Slack messages from the OpenWork bot",
    description: "Chats and Automations can send a Slack message from the OpenWork app instead of as the member: a DM that notifies them (\"ping me when this is done\") or a channel post that names whose agent sent it. Needs the OpenWork app in Slack; limited to 20 messages a day per member.",
    category: "connect",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/slack-send-as-bot/README.md",
    deployments: everywhere,
    default: false,
  },
  liveProviderSync: {
    label: "Live provider sync",
    description: "Keep desktop OpenCode v2 models up to date with the organization's AI Gateway in real time.",
    category: "models",
    added: "2026-10-17",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/live-provider-sync.md",
    deployments: everywhere,
    default: false,
  },
  opencodeV2Only: {
    label: "OpenCode v2 only",
    description: "Desktop chats always run on OpenCode v2: switching to OpenCode v1 is turned off and earlier chats are copied to v2 in the background.",
    category: "experience",
    added: "2026-10-27",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/opencode-v2-only/README.md",
    deployments: everywhere,
    default: false,
  },
  managedDeployments: {
    label: "Managed deployments",
    description: "Organization admins install OpenWork in their own AWS account or Google Cloud project and see its health and updates in OpenWork, and agents connected to OpenWork can create and follow those deployments.",
    category: "administration",
    added: "2026-10-08",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/managed-deployments.md",
    deployments: ["cloud"],
    default: false,
  },
  workbotDocuments: {
    label: "Workbot Documents",
    description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, and save supported text and spreadsheet edits to Drive.",
    category: "workbot",
    added: "2026-10-16",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  workbotDocumentEditing: {
    label: "Workbot Documents: editing",
    description: "Members choose Edit from a document preview. Full Office editing starts their Cloud workspace only when requested. Requires Workbot Documents.",
    category: "workbot",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  workbotWorkspaceAssistant: {
    label: "Workbot: workspace assistant",
    description: "Members ask Workbot about the document or calendar view they have open, chat without leaving their work, and navigate from a compact sidebar. Workbot offers to open the documents it mentions, and the conversation stays open beside the document.",
    category: "workbot",
    added: "2026-10-16",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  workbotProactive: {
    label: "Workbot: Your agent",
    description: "Every member gets a background agent that reads their Gmail and Google Calendar each morning and about every three hours in working hours, and sends them one short DM from the Workbot Slack app only when something needs them. Admins turn it on and choose what it tells people about in Manage › Workbot; members turn it off, snooze it or mute a kind of message. It only reads and never sends, accepts or edits anything for them.",
    category: "workbot",
    added: "2026-10-24",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/workbot-proactive/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotAgentHealthView: {
    label: "Workbot: Your agent health in Manage › Workbot",
    description: "Admins see, for the last 7 days and per responsibility, how many checks members' agents ran, the share that stayed quiet, how many messages they sent and how many members muted it. Counts only, no member names or content. Needs Workbot: Your agent.",
    category: "workbot",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/workbot-proactive/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotIncludedModels: {
    label: "Workbot: included OpenWork models by default",
    description: "Signed-in members chat in Workbot on their included OpenWork models without an AI Gateway provider. When the free allowance runs out, Workbot says when it resets and links admins to OpenWork Models or the workspace's model settings.",
    category: "billing",
    added: "2026-10-22",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: everywhere,
    default: false,
  },
  workbotUsageRecovery: {
    label: "Workbot: usage limits and upgrades",
    description: "Signed-in Workbot uses free Auto or the member’s paid Models Luna entitlement, with allowance recovery and permission-aware upgrades in the conversation.",
    category: "billing",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  automationCalendar: {
    label: "Calendar: desktop app",
    description: "Members see a Calendar in the desktop app with their Automations next to meetings from their connected Google or Outlook calendar.",
    category: "automations",
    added: "2026-10-07",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: everywhere,
    default: false,
  },
  automationIntervalSchedules: {
    label: "Automations: every few hours",
    description: "Members and their agents can schedule an Automation to run every few hours, for example every 3 hours between 9:00 and 18:00 on weekdays, instead of once a day or once a week.",
    category: "automations",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/automation-interval-schedules/README.md",
    deployments: everywhere,
    default: false,
  },
  automationCalendarTriggers: {
    label: "Automations: before or after meetings",
    description: "Members and their agents can run a Cloud Automation a set time before or after each meeting on their Google Calendar, for example 5 minutes after every meeting with people outside the organization.",
    category: "automations",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/automation-calendar-triggers/README.md",
    deployments: everywhere,
    default: false,
  },
  computerUse: {
    label: "Computer use",
    description: "Let agents use Mac apps or a managed cloud desktop with a live view and Take over and Stop controls. While enabled, requested apps and windows open directly without additional OpenWork approval prompts. GUI access is experimental and is not sandboxed by structured-tool permission rules.",
    category: "computerUse",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },

  browserUse: {
    label: "Workbot: browser use",
    description: "Workbot uses the browser on its cloud computer, with a Browser view people can watch and take over. Needs remote computers. Computer use separately controls Workbot's other desktop apps.",
    category: "computerUse",
    added: "2026-10-26",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/computer-use/workbot.md",
    deployments: everywhere,
    default: false,
  },

  browserDemonstrations: {
    label: "Workbot: teach browser tasks",
    description: "Demonstrate a browser task with explanations, save it as a private reusable skill, and run it with new inputs.",
    category: "computerUse",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/computer-use/browser-demonstrations.md",
    deployments: everywhere,
    default: false,
  },

  browserLiveView: {
    label: "Workbot: browser live view",
    description: "Workbot's Browser view streams the browser page itself, sending a frame only when the page changes, instead of video of the whole browser window, with Workbot's own tabs to switch and close. Taking control sends input to the page, so Chrome's toolbar stays hidden.",
    category: "computerUse",
    added: "2026-10-22",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },

  browserFloatingView: {
    label: "Desktop: floating and full-screen browser",
    description: "The built-in browser can float as a small live card over the chat, sit beside it, or fill the window, with the side rail's Browser button showing when it needs the person.",
    category: "computerUse",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },

  remoteComputers: {
    label: "Desktop: computer use on remote computers",
    description: "Use a Linux cloud computer with its browser and desktop in OpenWork Web, or connect a VM from Desktop. Configured and conversation-owned desktops open directly when enabled, including follow-ups and internal session renewal. Take over and Stop stay available.",
    category: "computerUse",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  remoteSessionSubagents: {
    label: "Desktop: tasks on other computers as sub-agents",
    description: "A task the agent starts on the cloud or another computer shows in the chat as a sub-agent row: where it runs, whether it is working, needs an answer or finished, and a Stop button.",
    category: "computerUse",
    added: "2026-10-15",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/session-offloading-architecture.md",
    deployments: everywhere,
    default: false,
  },
  remoteSessionThreadView: {
    label: "Desktop: open a sub-agent task's conversation",
    description: "Clicking the row of a task on another computer opens its conversation beside the chat, where people read it and follow up. Needs tasks on other computers as sub-agents.",
    category: "computerUse",
    added: "2026-10-26",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/session-offloading-architecture.md",
    deployments: everywhere,
    default: false,
  },
  activationChecklist: {
    label: "Get set up checklist",
    description: "After their first answer, people see a Get set up checklist in Desktop and Workbot: invite a teammate, use a skill, add a model provider, share one on AI Gateway and connect an app, each checked off once it works.",
    category: "experience",
    added: "2026-10-22",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: everywhere,
    default: false,
  },
  connectStandardTools: {
    label: "Connect: standard tools",
    description: "Supported clients, including OpenWork Desktop, OpenCode and Claude Code, discover connected actions, Workflows and Apps as individual tools. Capability search uses MCP tool schemas with older fields kept for compatibility. Turning this off restores the previous search view and schemas.",
    category: "connect",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  teamPlan: {
    label: "Team plan checkout",
    description: "Going past 5 people moves the workspace to the Team plan at $10 per person per month, and paying sets the plan.",
    category: "billing",
    added: "2026-10-22",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: ["cloud"],
    default: false,
  },
  selfServeEnterprise: {
    label: "Self-serve Enterprise",
    description: "Owners can buy Enterprise by card at the planned per-person price.",
    category: "billing",
    added: "2026-10-22",
    since: "2026-10",
    author: "benjaminshafii",
    deployments: ["cloud"],
    default: false,
  },
  gatewayProviderAuthErrors: {
    label: "AI Gateway: rejected provider credentials in chat",
    description: "When a provider rejects your organization's AI Gateway credential, the chat says which provider rejected it and asks you to contact your administrator, with a request ID for support, instead of sending you to your own model settings.",
    category: "models",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/gateway-provider-auth-errors/README.md",
    deployments: everywhere,
    default: false,
  },
  providerCredentialStatus: {
    label: "Desktop: honest AI provider key status",
    description: "AI Providers says \"Not checked yet\" for a key that has not answered a chat, and \"Key not accepted\" with Replace key (or ask your admin, for organization providers) after the provider rejects it, instead of always \"Ready to use\".",
    category: "models",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/provider-credential-status/README.md",
    deployments: everywhere,
    default: false,
  },
  outlookAttachments: {
    label: "Outlook attachments",
    description: "Agents read the files attached to Outlook messages and create Outlook drafts and replies with workspace files attached, after the member approves each draft. Drafts are never sent.",
    category: "connect",
    added: "2026-10-26",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/outlook-attachments/README.md",
    deployments: everywhere,
    default: false,
  },
  sessionTokenHashing: {
    label: "Hashed sign-in sessions",
    description: "Den keeps only a one-way hash of each sign-in session token, so a copy of the database cannot sign anyone in. New sessions are stored hashed and older ones convert the next time they are used; turn on only once every Den replica runs a release that reads both forms.",
    category: "administration",
    added: "2026-10-23",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  lastUsedSignIn: {
    label: "Remember last sign-in method",
    description: "People who last signed in with a password, Google or GitHub skip the email step next time: Den web lists the sign-in methods with a Last used badge, and Single sign-on returns to the email step. Signing in with SSO forgets the method.",
    category: "experience",
    added: "2026-10-26",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/last-used-sign-in/README.md",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
