/**
 * Every preview flag. A preview gates unfinished work: it has an owner and a
 * day it expires, and by then it ships (move the key to ./retired.ts and
 * remove its checks) or is cut. The export name is the key, in alphabetical
 * order. Read .opencode/skills/add-a-feature/SKILL.md before adding one.
 */
import { definePreview, everywhere } from "@openwork/features/define"

export const activationLocalSetup = definePreview({
  label: "Get set up: count what works on this device",
  description: "The Get set up checklist also checks off a model provider and a connection that work on the person's own device, without setting them up again in OpenWork, and inviting a teammate becomes optional while they are the only person in the organization, so someone working alone can finish setup. Turning it off restores the earlier checklist at once; nothing is lost.",
  category: "experience",
  added: "2026-11-13",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/activation-local-setup/README.md",
  deployments: everywhere,
  default: false,
})

export const administratorRecovery = definePreview({
  label: "Deploy-time administrator recovery",
  description: "Run a one-time, operator-selected Admin-team permission repair at deployment; disabling stops future repairs, not existing grants.",
  category: "administration",
  added: "2026-10-23",
  owner: "yomgui",
  expiresOn: "2026-12-31",
  deployments: everywhere,
  default: false,
})

export const automationArchiveRestore = definePreview({
  label: "Automations: restore from archive",
  description: "Find archived Automations and restore them without resuming their schedules.",
  category: "automations",
  added: "2026-11-20",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/automation-archive-restore/README.md",
  deployments: everywhere,
  default: false,
})

export const automationFailureNotifications = definePreview({
  label: "Automations: notify when a run fails or is missed",
  description: "When one of your Automations fails, including when a connection it needs must be reconnected, the OpenWork app tells you once: a message that stays until you dismiss it and, while the app is in the background, a system notification. When a run is missed because no desktop was connected, it offers to run it now or to move its schedule to the cloud.",
  category: "automations",
  added: "2026-11-04",
  owner: "reachjalil",
  expiresOn: "2026-12-15",
  docs: "docs/features/automation-failure-notifications/README.md",
  deployments: everywhere,
  default: false,
})

export const automationSharing = definePreview({
  label: "Automations: share with teammates",
  description: "Share one of your Automations with people, teams or your whole organization. They see it under Shared with you and can add their own copy, which runs with their own connections and models.",
  category: "automations",
  added: "2026-11-18",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/automation-sharing/README.md",
  deployments: everywhere,
  default: false,
})

export const automationSimpleReview = definePreview({
  label: "Automations: simpler chat review",
  description: "See what an Automation will do, when it runs, and where, with setup options one click away.",
  category: "automations",
  added: "2026-11-20",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/automation-simple-review/README.md",
  deployments: everywhere,
  default: false,
})

export const browserDemonstrations = definePreview({
  label: "Workbot: teach browser tasks",
  description: "Demonstrate a browser task with explanations, save it as a private reusable skill, and run it with new inputs.",
  category: "computerUse",
  added: "2026-10-21",
  owner: "reachjalil",
  expiresOn: "2026-12-31",
  docs: "docs/computer-use/browser-demonstrations.md",
  deployments: everywhere,
  default: false,
})

export const browserSecretHandles = definePreview({
  label: "Browser: secret handles",
  description: "Save a password, one-time code or token for a conversation and choose the sites it may go to. The agent fills it in the built-in browser on those sites without ever seeing it, and asks you before each fill.",
  category: "computerUse",
  added: "2026-11-18",
  owner: "benjaminshafii",
  expiresOn: "2027-01-31",
  docs: "docs/browser/secret-handles.md",
  deployments: everywhere,
  default: false,
})

export const chatSkillCardShare = definePreview({
  label: "Chat: share created skills",
  description: "Share a skill from its result card in chat without leaving the conversation.",
  category: "experience",
  added: "2026-11-18",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/chat-skill-card-share/README.md",
  deployments: everywhere,
  default: false,
})

export const composerInlineSuggestions = definePreview({
  label: "Suggestions anywhere in a message",
  description: "Find skills with / and reference tasks, files, agents, and computers with @ anywhere in a chat draft.",
  category: "experience",
  added: "2026-11-23",
  owner: "different-ai",
  expiresOn: "2026-12-15",
  docs: "docs/features/composer-inline-suggestions/README.md",
  deployments: everywhere,
  default: false,
})

export const connectionSelectedScopesOnly = definePreview({
  label: "Connect: request only chosen scopes",
  description: "Admins can make a connection ask for only the scopes they list when people sign in, leaving out any others the server asks for.",
  category: "connect",
  added: "2026-11-16",
  owner: "reachjalil",
  expiresOn: "2026-12-15",
  docs: "docs/features/connection-selected-scopes-only/README.md",
  deployments: everywhere,
  default: false,
})

export const desktopSystemProxy = definePreview({
  label: "Desktop: follow the computer's proxy settings",
  description: "On a network that only allows traffic through a company proxy, connectors, the person's own model providers, web fetches and commands the agent runs use the same proxy the computer is set to, including automatic (PAC) settings. Nothing to set up on the computer.",
  category: "experience",
  added: "2026-11-19",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/desktop-system-proxy/README.md",
  deployments: everywhere,
  default: false,
})

export const gatewayOpenCodeSetup = definePreview({
  label: "AI Gateway: OpenCode setup",
  description: "Show members how to install the OpenWork plugin for OpenCode 2 and sign in from My Library › Models.",
  category: "models",
  added: "2026-11-17",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/gateway-open-code-setup/README.md",
  deployments: everywhere,
  default: false,
})

export const gmailThreadRead = definePreview({
  label: "Read Gmail threads",
  description: "Read the messages, headers, and labels in a Gmail conversation without loading full message bodies.",
  category: "connect",
  added: "2026-11-24",
  owner: "yomgui",
  expiresOn: "2027-01-31",
  docs: "docs/features/gmail-thread-read/README.md",
  deployments: everywhere,
  default: false,
})

export const importOpencodeConnections = definePreview({
  label: "Desktop: import connections from OpenCode",
  description: "Settings shows how many connections a person set up in their own OpenCode config are not in OpenWork, with an Import from OpenCode action. Importing copies them into OpenWork once, like adding each by hand, then shows each one's real state and anything that was left out. The person's OpenCode files are never changed. Off, Settings does not look at the OpenCode config.",
  category: "experience",
  added: "2026-11-13",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/import-opencode-connections/README.md",
  deployments: everywhere,
  default: false,
})

export const lowStorageWarning = definePreview({
  label: "Desktop: low disk space warning",
  description: "When the computer running OpenWork is almost out of disk space, the app says how much is left and asks the person to free up space, before saving starts to fail.",
  category: "experience",
  added: "2026-11-13",
  owner: "reachjalil",
  expiresOn: "2026-12-15",
  docs: "docs/features/low-storage-warning/README.md",
  deployments: everywhere,
  default: false,
})

export const managedDeploymentAssistants = definePreview({
  label: "Gateway-managed deployments",
  description: "New AWS installations include the model gateway, managed runner, Workbot and Slack/Automations. Existing installations upgrade only with approval; cloud computers stay optional.",
  category: "administration",
  added: "2026-11-16",
  owner: "benjaminshafii",
  expiresOn: "2027-02-28",
  docs: "docs/features/managed-deployment-assistants/README.md",
  deployments: ["cloud"],
  default: false,
})

export const managedDeploymentAwsSignIn = definePreview({
  label: "Deployments: guided AWS approval",
  description: "Each deployment opens as its own page with the approval steps in order, a copyable approval link and what to do when AWS shows something else. Admins can save the organization's AWS access portal so every AWS link signs in to the right account first.",
  category: "administration",
  added: "2026-11-17",
  owner: "benjaminshafii",
  expiresOn: "2027-02-28",
  docs: "docs/features/managed-deployment-aws-sign-in/README.md",
  deployments: ["cloud"],
  default: false,
})

export const managedDeploymentConfigUpdates = definePreview({
  label: "Deployment configuration changes",
  description: "Organization admins edit an installed AWS deployment's configuration, or turn on the gateway runtime and cloud computers later, and approve the change in their own AWS account without waiting for a newer installer.",
  category: "administration",
  added: "2026-11-17",
  owner: "benjaminshafii",
  expiresOn: "2027-02-28",
  docs: "docs/features/managed-deployment-config-updates/README.md",
  deployments: ["cloud"],
  default: false,
})

export const managedDeployments = definePreview({
  label: "Managed deployments",
  description: "Organization admins install OpenWork in their own AWS account or Google Cloud project and see its health and updates in OpenWork, and agents connected to OpenWork can create and follow those deployments.",
  category: "administration",
  added: "2026-10-08",
  owner: "benjaminshafii",
  expiresOn: "2027-02-28",
  docs: "docs/managed-deployments.md",
  deployments: ["cloud"],
  default: false,
})

export const managedGoogleCloudDeployments = definePreview({
  label: "Managed Google Cloud deployments",
  description: "Allow the workspace to prepare and approve OpenWork installations and updates in Google Cloud. An installer release must also be configured.",
  category: "administration",
  added: "2026-11-23",
  owner: "benjaminshafii",
  expiresOn: "2027-02-28",
  docs: "docs/features/managed-google-cloud-deployments/README.md",
  deployments: ["cloud"],
  default: false,
})

export const mcpThreads = definePreview({
  label: "Threads over MCP",
  description: "Start, follow and answer OpenWork sessions from any MCP client with standard tools, and hear about their changes through MCP Events instead of polling.",
  category: "connect",
  added: "2026-11-17",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/mcp-threads/README.md",
  deployments: everywhere,
  default: false,
})

export const officeOutlinePreview = definePreview({
  label: "Desktop: PowerPoint and Word outlines",
  description: "Read PowerPoint slides and Word documents as text in the chat side panel, without opening another app.",
  category: "experience",
  added: "2026-11-20",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/office-outline-preview/README.md",
  deployments: everywhere,
  default: false,
})

export const opencodeV2Only = definePreview({
  label: "OpenCode v2 only",
  description: "Desktop chats always run on OpenCode v2: switching to OpenCode v1 is turned off and earlier chats are copied to v2 in the background.",
  category: "experience",
  added: "2026-10-27",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/opencode-v2-only/README.md",
  deployments: everywhere,
  default: false,
})

export const privateValues = definePreview({
  label: "Private values the agent never sees",
  description: "The agent puts a password, token, one-time code or any other private value into a website, a program or one https request by naming a command that prints it, such as your password manager's, or by asking you to paste it. OpenWork fetches the value after you approve and delivers it; the agent and its model provider never see it.",
  category: "computerUse",
  added: "2026-11-23",
  owner: "benjaminshafii",
  expiresOn: "2027-01-31",
  docs: "docs/private-values.md",
  deployments: everywhere,
  default: false,
})

export const providerFilterSyncFix = definePreview({
  label: "Desktop: exact provider search and guided provider sharing",
  description: "The model picker shows only the provider and model you typed, and sharing a provider from this device waits until it is listed under your organization before saying it is shared.",
  category: "models",
  added: "2026-11-16",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/provider-filter-sync-fix/README.md",
  deployments: everywhere,
  default: false,
})

export const questionInThread = definePreview({
  label: "Desktop: questions in the conversation",
  description: "When an agent asks a question, it shows as a card at the end of the conversation instead of above the message box, so the person can scroll and keep typing. Sending a message from the message box skips the question. Off, the question opens above the message box, as before.",
  category: "experience",
  added: "2026-11-18",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/question-in-thread/README.md",
  deployments: everywhere,
  default: false,
})

export const questionMinimize = definePreview({
  label: "Desktop: minimize a pending question",
  description: "When an agent asks a question, the person can minimize it to one line above the message box to read the conversation, then reopen it with everything they picked or typed still there. The question stays pending the whole time. Turning it off shows the question fully open, as before.",
  category: "experience",
  added: "2026-11-13",
  owner: "benjaminshafii",
  expiresOn: "2026-12-15",
  docs: "docs/features/question-minimize/README.md",
  deployments: everywhere,
  default: false,
})

export const remoteComputers = definePreview({
  label: "Desktop: computer use on remote computers",
  description: "Use a Linux cloud computer with its browser and desktop in OpenWork Web, or connect a VM from Desktop. Configured and conversation-owned desktops open directly when enabled, including follow-ups and internal session renewal. Take over and Stop stay available.",
  category: "computerUse",
  added: "2026-10-20",
  owner: "reachjalil",
  expiresOn: "2026-12-31",
  deployments: everywhere,
  default: false,
})

export const remoteDesktopDeviceLogin = definePreview({
  label: "Remote desktop device sign-in",
  description: "Sign a remote OpenWork desktop into an organization by approving a code on another computer.",
  category: "experience",
  added: "2026-11-09",
  owner: "yomgui",
  expiresOn: "2027-01-31",
  docs: "docs/features/remote-desktop-device-login/README.md",
  deployments: everywhere,
  default: false,
})

export const remoteTasksOptIn = definePreview({
  label: "Desktop: other devices reach a computer only after its owner allows it",
  description: "A signed-in computer takes nothing from its owner's other devices, Workbot or agents until the owner allows it in Desktop Settings > Devices: no task can be started there and no session reached. Off, a computer whose owner has not chosen keeps taking tasks started remotely, as before. In both cases the owner can turn a computer off, and organization owners can turn remote access off for everyone on Manage > Computers.",
  category: "computerUse",
  added: "2026-11-11",
  owner: "benjaminshafii",
  expiresOn: "2027-01-31",
  docs: "docs/features/remote-tasks-opt-in/README.md",
  deployments: everywhere,
  default: false,
})

export const sessionTree = definePreview({
  label: "Desktop: sessions started from a session nest under it",
  description: "Side chats and sessions the agent starts are listed under the session they came from in the sidebar, with a way back to it. A session the agent started reports to that session when it finishes.",
  category: "experience",
  added: "2026-11-16",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/session-tree/README.md",
  deployments: everywhere,
  default: false,
})

export const sideChatFromSelection = definePreview({
  label: "Desktop: start a side chat from selected text",
  description: "Selecting text in a reply shows a small Start a side chat bar above it. Choosing it opens a side chat beside the conversation with the text quoted in the message box.",
  category: "experience",
  added: "2026-11-20",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/side-chat-from-selection/README.md",
  deployments: everywhere,
  default: false,
})

export const sideQuestions = definePreview({
  label: "Desktop: side chat answers from the conversation",
  description: "A side chat asks quick questions about the conversation on screen and is answered from what that conversation already knows, in a panel beside it. Nothing is added to the conversation, no tools run and no new session appears in the sidebar. /btw in the message box asks one too.",
  category: "experience",
  added: "2026-11-17",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/side-questions/README.md",
  deployments: everywhere,
  default: false,
})

export const workbotAgentCheckGate = definePreview({
  label: "Workbot: Your agent skips checks when nothing new arrived",
  description: "With Your agent's brief on, admins can turn on Skip checks when nothing new arrived in Manage › Workbot. Before a scheduled check, Workbot looks at what reached the member's Gmail and Google Calendar since the agent last looked. With nothing new, or only routine mail, the agent doesn't run for that check. The first check of the day, checks the agent asked for, and a check after two skipped in a row always run.",
  category: "workbot",
  added: "2026-11-10",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/workbot-agent-check-gate/README.md",
  deployments: ["cloud"],
  default: false,
})

export const workbotAgentSendCheck = definePreview({
  label: "Workbot: Your agent checks each message before sending",
  description: "With Your agent's brief on, admins can turn on Check each message before sending in Manage › Workbot. A fast second model then reads each message Your agent wrote against the brief and what the member was already told today, and holds a message the brief says to skip or that repeats one from today. It never writes, changes or adds a message, and when it can't answer the message is sent as before.",
  category: "workbot",
  added: "2026-11-10",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/workbot-agent-send-check/README.md",
  deployments: ["cloud"],
  default: false,
})

export const workbotCalmChat = definePreview({
  label: "Workbot: calm chat look",
  description: "A quieter look for Workbot's chat: a labelled sidebar with the open page as a white pill, Workbot's name and live status in one pill at the top, a narrower conversation with smaller text, a compact browser card, and a softer message box. Looks only; chats, files, browser tasks and navigation work the same.",
  category: "workbot",
  added: "2026-11-12",
  owner: "benjaminshafii",
  expiresOn: "2027-01-31",
  docs: "docs/features/workbot-calm-chat/README.md",
  deployments: everywhere,
  default: false,
})

export const workbotDocuments = definePreview({
  label: "Workbot Documents",
  description: "Members browse recent Google Drive files and folders in Workbot, open documents in tabs, play video and audio files in the tab, and save supported text and spreadsheet edits to Drive.",
  category: "workbot",
  added: "2026-10-16",
  owner: "reachjalil",
  expiresOn: "2026-12-31",
  deployments: everywhere,
  default: false,
})

export const workbotMobile = definePreview({
  label: "Workbot: phone app",
  description: "Members can sign in to the OpenWork app on iPhone and use Workbot there. Needs Workbot.",
  category: "workbot",
  added: "2026-11-16",
  owner: "reachjalil",
  expiresOn: "2027-01-31",
  docs: "docs/features/workbot-mobile/README.md",
  deployments: everywhere,
  default: false,
})

export const workbotWorkspaceAssistant = definePreview({
  label: "Workbot: workspace assistant",
  description: "Members ask Workbot about the document they have open (Ask Workbot brings it into the chat) and navigate from a compact sidebar. Workbot offers to open the documents it mentions. The chat itself stays on its own page.",
  category: "workbot",
  added: "2026-10-16",
  owner: "reachjalil",
  expiresOn: "2026-12-31",
  deployments: everywhere,
  default: false,
})
