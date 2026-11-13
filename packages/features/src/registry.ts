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
  claudeAgentProvider: {
    label: "Claude Code sign-in",
    description: "Connect Claude through the Claude Code login on this computer, without an Anthropic API key.",
    category: "models",
    added: "2026-11-09",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/claude-agent-provider/README.md",
    deployments: everywhere,
    default: false,
  },
  webPerMember: {
    label: "OpenWork Web per member",
    description: "Admins choose which members get OpenWork Web from the Members page, and the organization pays for Web only for them. Members without it can't open a Web computer. Off: every member and pending invitation has Web and is billed for it.",
    category: "administration",
    added: "2026-11-05",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/web-per-member/README.md",
    deployments: everywhere,
    default: false,
  },
  localModelsPolicy: {
    label: "AI Gateway: limit local models (Ollama, LM Studio)",
    description: "Admins turn local models on or off in AI Gateway › Who can use models, separately from members adding their own provider keys. Off: local models follow the provider setting (\"Only models you provide\" blocks them).",
    category: "models",
    added: "2026-11-10",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/local-models-policy/README.md",
    deployments: everywhere,
    default: false,
  },
  shareDeviceProvider: {
    label: "Desktop: share a provider key with your organization",
    description: "In Settings › AI Providers, a person who manages AI Gateway shares an API key already saved on their device with everyone in the organization, after confirming who can use it and who pays. People they invite get those models without anyone pasting the key again. Off: sharing means adding the provider again in AI Gateway.",
    category: "models",
    added: "2026-11-10",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/share-device-provider/README.md",
    deployments: everywhere,
    default: false,
  },
  singleOpenWorkModelsRow: {
    label: "Desktop: one OpenWork Models row you can turn off",
    description: "Settings › AI Providers and Connect a provider list OpenWork Models once. When the organization pays for it, the organization's row replaces the free on-device row, and it has Turn off / Turn on on this device: for every member, or only for admins when the organization manages models (Only models you provide).",
    category: "models",
    added: "2026-11-09",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/single-openwork-models-row/README.md",
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
  passwordSignInGoogle: {
    label: "Sign-in: offer Google alongside a password",
    description: "The email-first password step also offers Continue with Google when Google sign-in is configured. Off: the password step is unchanged. Resolved deployment-wide before sign-in; organization and member overrides do not apply.",
    category: "administration",
    added: "2026-11-12",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/password-sign-in-google/README.md",
    deployments: everywhere,
    default: false,
  },
  signInEmailSync: {
    label: "Sign-in: account email follows Google or SSO",
    description: "When someone's email changes at Google or at their company's identity provider, their OpenWork account moves to the new email the next time they sign in that way, so signing in with the new email opens the same account instead of creating a second one. Off: the account keeps the email it was created with.",
    category: "administration",
    added: "2026-11-10",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/sign-in-email-sync/README.md",
    deployments: everywhere,
    default: false,
  },
  ssoOidcSetupCheck: {
    label: "SSO: check the OIDC issuer during setup",
    description: "The OIDC setup form accepts the provider's issuer or its discovery URL, checks it while the administrator types and on save, shows the issuer and endpoints it found, and reports a wrong address on the field with the exact URL that was tried. Manual endpoints move behind a disclosure and reject a discovery URL as the issuer. Off: the form saves what was typed and reports discovery failures in the page banner.",
    category: "administration",
    added: "2026-11-11",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/sso-oidc-setup-check/README.md",
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
  denPageConsistency: {
    label: "Den: predictable page interactions",
    description: "Audit filters apply as they change, organization settings show Save and Discard only for unsaved changes, and team pages offer Edit team. Analytics no longer offers the separate Workflow Runs tab; existing run links still work. Turning it off restores explicit audit filtering, the persistent settings save action, and the earlier navigation. Layout polish is independent of this switch.",
    category: "administration",
    added: "2026-11-12",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/den-page-consistency/README.md",
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
  workbotScrollToBottom: {
    label: "Workbot: scroll to latest messages",
    description: "People reading earlier messages keep their place while Workbot replies, with a button to return to the latest messages.",
    category: "workbot",
    added: "2026-11-08",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/workbot-scroll-to-bottom/README.md",
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
  workbotApps: {
    label: "Workbot: open artifacts from chat",
    description: "An artifact that Workbot builds, changes, or opens appears as a card under its reply. Select the card to open the artifact beside the chat.",
    category: "workbot",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-apps/README.md",
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
  workbotTeamSettings: {
    label: "Workbot: settings per team",
    description: "Admins can give a team its own Workbot default model and its own Workbot name, and turn Workbot on or off for everyone or for a team; teams without their own use the organization's. A member on several teams whose settings differ gets the organization's.",
    category: "workbot",
    added: "2026-11-09",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-team-settings/README.md",
    deployments: everywhere,
    default: false,
  },
  workbotUsageAnalytics: {
    label: "Workbot: cost in Analytics",
    description: "Admins see what Workbot spent on models over the last 30 days in Analytics › Workbot: the total, per day, per person, per model, and split between chats, members' agents, and Slack and automations.",
    category: "workbot",
    added: "2026-11-10",
    since: "2026-11",
    author: "reachjalil",
    docs: "docs/features/workbot-usage-analytics/README.md",
    deployments: everywhere,
    default: false,
  },
  fileSendPermissions: {
    label: "Connected accounts: one permission for files the agent sends",
    description: "Drive uploads, saves back to Drive, OneDrive and SharePoint, and Gmail and Outlook drafts with attachments ask the same way: Allow once, Allow for this chat or Always allow. Admins set Allow, Ask first or Block on the Agents tab, and members revoke remembered approvals in Settings.",
    category: "connect",
    added: "2026-11-12",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/file-send-permissions/README.md",
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
  remoteDevices: {
    label: "Computers",
    description: "Computers in Den lets organization owners and admins view their team's reported desktops, cloud computers, registered virtual computers and OpenWork instances, with owners, status, last contact, versions and supported inventory. My Computers in Den, Desktop Settings > Devices and Workbot's Devices page show each member their own and shared computers. Registration does not provision a computer or grant provider access. Off, these views are hidden and desktop reports stop; existing computer use and remote tasks are unchanged.",
    category: "computerUse",
    added: "2026-11-10",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/remote-devices/README.md",
    deployments: everywhere,
    default: false,
  },
  remoteSessionAccess: {
    label: "Desktop: other devices can open sessions started on a computer",
    description: "A member can let their other devices, Workbot and agents working for them open sessions they started on one of their own computers, continue them, stop them and answer what they wait on, not only tasks that were started remotely. Organization owners choose whether members may allow it (Manage > Computers > Remote access); each member then allows it per computer in Desktop Settings > Devices. It needs both choices and is enforced on that computer. Off, other devices reach only sessions started remotely, as before, and computers report no sessions.",
    category: "computerUse",
    added: "2026-11-10",
    since: "2026-11",
    author: "benjaminshafii",
    docs: "docs/features/remote-session-access/README.md",
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
