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
  autoRouter: {
    label: "AI Gateway: Smart Model Router",
    description: "Admins create Smart Routers for everyone, teams or people, listing AI Gateway models and the tasks each handles. Members pick \"Smart: <name>\": each prompt goes to the model whose tasks fit it best, at the thinking level it needs.",
    category: "models",
    added: "2026-10-26",
    since: "2026-10",
    author: "OmarMcAdam",
    docs: "docs/features/auto-router/README.md",
    deployments: ["cloud"],
    default: false,
  },
  settledSessions: {
    label: "Desktop: settle finished sessions",
    description: "Finished sessions can be settled into a collapsed Settled row at the end of their workspace, by hand or after a few idle days, and come back on new activity.",
    category: "experience",
    added: "2026-10-29",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/settled-sessions/README.md",
    deployments: everywhere,
    default: false,
  },
  composerBackgroundTasks: {
    label: "Desktop: background tasks on the composer",
    description: "Commands the agent leaves running in the background are listed on top of the composer, under the Agents list, with how long each has run, instead of a count in the chat.",
    category: "experience",
    added: "2026-11-01",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/composer-background-tasks/README.md",
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
    description: "Every member gets a read-only background agent that checks Gmail and Google Calendar each morning and about every three working hours, sending a short Workbot Slack DM only when needed. Members review checks and messages in My bot, tell it what they care about, narrow its hours and limits, undo changes, snooze or mute it. Admins choose its responsibilities and see aggregate 7-day health in Manage › Workbot, without member names or content. It never sends email, accepts invitations or edits data for them.",
    category: "workbot",
    added: "2026-10-24",
    since: "2026-10",
    author: "benjaminshafii",
    docs: "docs/features/workbot-proactive/README.md",
    deployments: everywhere,
    default: false,
    outcomes: true,
  },
  computerUse: {
    label: "Computer use",
    description: "Let agents use Mac apps or a managed cloud desktop with a live view and Take over and Stop controls. On Mac, supported app windows stay in the background without moving your cursor; agents read controls first and take screenshots only when needed. Canvas apps such as Blender still come to the front. Requested apps open without additional OpenWork approval prompts. GUI access is experimental and is not sandboxed by structured-tool permission rules.",
    category: "computerUse",
    added: "2026-10-20",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/computer-use-background/README.md",
    deployments: everywhere,
    default: false,
  },

  computerSessionHistory: {
    label: "Desktop: computer session history",
    description: "Computer actions share one compact session card in chat, with captured views to browse or replay. Turning it off restores individual actions and screenshots.",
    category: "computerUse",
    added: "2026-10-30",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/computer-session-history/README.md",
    deployments: everywhere,
    default: false,
  },

  browserUse: {
    label: "Workbot: browser use",
    description: "Workbot uses the browser on its cloud computer with a live Browser view people can watch and take over. It streams the page only when it changes, with Workbot tabs to switch and close; takeover controls the page without Chrome's toolbar. Needs remote computers. Computer use separately controls other desktop apps.",
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
  connectStandardTools: {
    label: "Connect: standard tools",
    description: "Claude Code and standalone OpenCode discover connected actions, Workflows and Apps as individual tools; OpenWork Desktop, Web and automation runs keep capability search. Capability search uses MCP tool schemas with older fields kept for compatibility. Turning this off restores the previous search view and schemas.",
    category: "connect",
    added: "2026-10-21",
    since: "2026-10",
    author: "reachjalil",
    deployments: everywhere,
    default: false,
  },
  connectEngineTools: {
    label: "Connect: a tool for each action in OpenWork's engine",
    description: "OpenWork Desktop, Web and automation runs get each connected action, Workflow and App as its own tool, found with their engine's Code Mode search; capability search stays for OpenWork's own operations and skills. Other clients are unaffected. Turning this off restores capability search.",
    category: "connect",
    added: "2026-10-28",
    since: "2026-10",
    author: "reachjalil",
    docs: "docs/features/connect-engine-tools/README.md",
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
})

export type FeatureKey = keyof typeof FEATURES

/** Features whose outcomes /admin › Features reads (`outcomes: true`). */
export type OutcomeFeatureKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { outcomes: true } ? K : never }[FeatureKey]

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
