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
  experience: { label: "Onboarding and everyday use", description: "Getting set up, signing in, dictation, imports and artifacts." },
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
  /**
   * The feature works in the background (a schedule, a calendar, an agent's
   * checks, messages sent by runs), so no request shows whether it ran or
   * worked. /admin › Features reads its outcomes from the store that already
   * holds them: den-api registers exactly one reader for each feature that
   * sets this (ee/apps/den-api/src/feature-outcomes/readers.ts), and its
   * typecheck fails without one.
   */
  outcomes?: true
}

function defineFeatures<const T extends Record<string, FeatureDefinition>>(features: T): T {
  return features
}

const everywhere = ["cloud", "self_hosted"] as const

export const FEATURES = defineFeatures({
  nativeMcpEvents: {
    label: "Session and computer MCP events",
    description: "Subscribe to changes in your remote sessions and computers through MCP Events.",
    category: "connect", added: "2026-11-12", since: "2026-11", author: "reachjalil",
    docs: "docs/features/native-mcp-events/README.md", deployments: everywhere, default: false, outcomes: true,
  },
  mcpThreadEvents: {
    label: "MCP thread events",
    description: "Subscribe a hosted chat to signed webhook events from its connected MCP servers.",
    category: "connect",
    added: "2026-11-12",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/mcp-thread-events/README.md",
    deployments: everywhere,
    default: false,
    outcomes: true,
  },
  remoteDesktopDeviceLogin: {
    label: "Remote desktop device sign-in",
    description: "Sign a remote OpenWork desktop into an organization by approving a code on another computer.",
    category: "experience",
    added: "2026-11-09",
    since: "2026-11",
    author: "yomgui",
    docs: "docs/features/remote-desktop-device-login/README.md",
    deployments: everywhere,
    default: false,
  },
  followUpSuggestions: {
    label: "Desktop: suggested follow-ups",
    description: "After a reply finishes, the empty message box can show a suggested next message in gray. Tab fills it in; typing anything else ignores it. A small model writes the suggestion, and nothing shows when it has no clear next step to offer.",
    category: "experience",
    added: "2026-11-11",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/follow-up-suggestions/README.md",
    deployments: everywhere,
    default: false,
  },
  questionMinimize: {
    label: "Desktop: minimize a pending question",
    description: "When an agent asks a question, the person can minimize it to one line above the message box to read the conversation, then reopen it with everything they picked or typed still there. The question stays pending the whole time. Turning it off shows the question fully open, as before.",
    category: "experience",
    added: "2026-11-13",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/question-minimize/README.md",
    deployments: everywhere,
    default: false,
  },
  denGreySidebar: {
    label: "Den: grey sidebar, white pages",
    description: "The Den dashboard shows its sidebar on a light grey band and every page on white, like the admin dashboard pictured on the website, instead of a white sidebar beside lightly tinted pages. Only colours change: navigation, page layouts and every control stay where they are. Turning it off restores the earlier colours at once.",
    category: "experience",
    added: "2026-11-11",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/den-grey-sidebar/README.md",
    deployments: everywhere,
    default: false,
  },
  teamSettingsSidebar: {
    label: "Den: team sections in a sidebar",
    description: "On Members › Teams, a team's page and Everyone's page list their sections (Role, Members, Access, Agents, Browser, Models, Workbot, Prompts, Desktop) in a grouped sidebar on the left instead of a row of tabs across the top. The Role, Agents and Browser sections get a heading with a tooltip that explains them, and a role that adds nothing says so. Turning it off restores the tabs and the earlier sections.",
    category: "administration",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/team-settings-sidebar/README.md",
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
    description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, play video and audio files in the tab, and save supported text and spreadsheet edits to Drive.",
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
    description: "Members ask Workbot about the document they have open (Ask Workbot brings it into the chat) and navigate from a compact sidebar. Workbot offers to open the documents it mentions. The chat itself stays on its own page.",
    category: "workbot",
    added: "2026-10-16",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  workbotProfileComputers: {
    label: "Workbot: Computers in its profile",
    description: "Moves the existing Devices entry into Workbot's profile as a Computers tab. The same member-scoped computers, status and Open actions remain available. Requires the profile sheet and Devices.",
    category: "workbot",
    added: "2026-11-12",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/workbot-profile-computers/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotCalmChat: {
    label: "Workbot: calm chat look",
    description: "A quieter look for Workbot's chat: a labelled sidebar with the open page as a white pill, Workbot's name and live status in one pill at the top, a narrower conversation with smaller text, a compact browser card, and a softer message box. Looks only; chats, files, browser tasks and navigation work the same.",
    category: "workbot",
    added: "2026-11-12",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/workbot-calm-chat/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotAgentBrief: {
    label: "Workbot: Your agent's brief and check rhythm",
    description: "With Your agent on, it checks on one rhythm (every 2 hours in working hours by default, plus up to 3 extra checks it asks for) instead of four fixed message types, and follows a plain-text brief: the organization's default plus each member's own lines, set in Manage › Workbot, My bot or chat. Each check researches first and then writes at most a few short messages, each one finding with a lock-screen first sentence. Messages per day and hours stay hard limits.",
    category: "workbot",
    added: "2026-11-03",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/workbot-agent-brief/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotAgentCheckGate: {
    label: "Workbot: Your agent skips checks when nothing new arrived",
    description: "With Your agent's brief on, admins can turn on Skip checks when nothing new arrived in Manage › Workbot. Before a scheduled check, Workbot looks at what reached the member's Gmail and Google Calendar since the agent last looked. With nothing new, or only routine mail, the agent doesn't run for that check. The first check of the day, checks the agent asked for, and a check after two skipped in a row always run.",
    category: "workbot",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-agent-check-gate/README.md",
    deployments: ["cloud"],
    default: false,
  },
  workbotAgentSendCheck: {
    label: "Workbot: Your agent checks each message before sending",
    description: "With Your agent's brief on, admins can turn on Check each message before sending in Manage › Workbot. A fast second model then reads each message Your agent wrote against the brief and what the member was already told today, and holds a message the brief says to skip or that repeats one from today. It never writes, changes or adds a message, and when it can't answer the message is sent as before.",
    category: "workbot",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-agent-send-check/README.md",
    deployments: ["cloud"],
    default: false,
  },
  workbotSettingsTabs: {
    label: "Workbot: settings in tabs",
    description: "Workbot's settings are split into three tabs, General, Agents and Data sources, instead of one long page: in Manage › Workbot and on the Workbot section of a team's page and Everyone's page. With Your agent's brief on, the Agents tab groups its rows (Messages, Schedule), uses switches for yes or no choices and explains each row in a tooltip. Turning it off restores the single page and its rows.",
    category: "workbot",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-settings-tabs/README.md",
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
  remoteTasksOptIn: {
    label: "Desktop: other devices reach a computer only after its owner allows it",
    description: "A signed-in computer takes nothing from its owner's other devices, Workbot or agents until the owner allows it in Desktop Settings > Devices: no task can be started there and no session reached. Off, a computer whose owner has not chosen keeps taking tasks started remotely, as before. In both cases the owner can turn a computer off, and organization owners can turn remote access off for everyone on Manage > Computers.",
    category: "computerUse",
    added: "2026-11-11",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/remote-tasks-opt-in/README.md",
    deployments: everywhere,
    default: false,
  },
  sandboxGateway: {
    label: "Workbot: computers through the sandbox gateway",
    description: "Workbot's cloud computers for this organization run through the runner's sandbox gateway (Differently), which holds the provider keys and picks the provider, instead of the runner's own Freestyle or Daytona account. Needs a runner with SANDBOX_GATEWAY set; without one, or while it is down, new computers use the runner's own provider.",
    category: "computerUse",
    added: "2026-10-28",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/computer-use/workbot.md",
    deployments: everywhere,
    default: false,
  },
  sandboxSlack: {
    label: "Sandboxes: sample Slack for Workbot",
    description: "New sandbox organizations get a sample Slack: a Slack connector at the sandbox's sample work apps with the Workbot Slack app already installed, so Proactive Mode can be turned on and each person's agent messages arrive on their own sample Slack page. Each person connects Slack once in their own browser. Only sandbox organizations are affected; every other organization keeps real Slack. Turning it off stops the sample Slack without sending anything to Slack.",
    category: "connect",
    added: "2026-11-11",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/sandbox-slack/README.md",
    deployments: ["cloud"],
    default: false,
  },
  connectStandardTools: {
    label: "Connect: standard tools",
    description: "Claude Code and standalone OpenCode discover connected actions, Workflows and artifacts as individual tools; OpenWork Desktop, Web and automation runs keep capability search. Capability search uses MCP tool schemas with older fields kept for compatibility. Turning this off restores the previous search view and schemas.",
    category: "connect",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  connectEngineTools: {
    label: "Connect: a tool for each action in OpenWork's engine",
    description: "OpenWork Desktop, Web and automation runs get each connected action, Workflow and artifact as its own tool, found with their engine's Code Mode search; capability search stays for OpenWork's own operations and skills. Other clients are unaffected. Turning this off restores capability search.",
    category: "connect",
    added: "2026-10-28",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/connect-engine-tools/README.md",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

/** Features whose outcomes /admin › Features reads (`outcomes: true`). */
export type OutcomeFeatureKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { outcomes: true } ? K : never }[FeatureKey]

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
