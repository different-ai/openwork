/**
 * OpenWork feature registry: the one place a feature is declared.
 *
 * This is the file you edit to add a feature. Read
 * .opencode/skills/add-a-feature/SKILL.md before adding or changing an
 * entry. Every new user-visible feature, or a change existing users would
 * notice, starts here — set to "off" in both deployments — before any feature
 * code is written.
 *
 * Each entry decides, separately for OpenWork Cloud and for self-hosted
 * installs, whether the feature exists there and who controls it:
 *
 *   "unavailable"                         not part of this deployment, by design
 *   "off"                                 built, but dark for now
 *   "on"                                  on for every organization
 *   { control: "platform", default }      platform admins turn it on or off per
 *                                         organization in /admin (on self-hosted,
 *                                         that is the customer's operator)
 *
 * Only `platform` features get a Helm key (`config.features.<key>`), an
 * `/admin` toggle, and a stored per-organization override. After editing this
 * file, run `pnpm features:sync` to regenerate the Helm chart files.
 *
 * Keys are permanent: the same name is the Helm values key, the
 * DEN_FEATURE_<KEY> environment variable, the API field, and the stored row.
 * Use lowerCamelCase with no consecutive capitals.
 */

export type FeatureDeployment = "cloud" | "self_hosted"

export type FeatureAvailability =
  | "unavailable"
  | "off"
  | "on"
  | { control: "platform"; default: boolean }

export type FeatureDefinition = {
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** Year and month the entry was added or last changed state, e.g. "2026-10". */
  since: `${number}-${number}`
  cloud: FeatureAvailability
  selfHosted: FeatureAvailability
}

function defineFeatures<const T extends Record<string, FeatureDefinition>>(features: T): T {
  return features
}

const platformDefaultOn = { control: "platform", default: true } as const
const platformDefaultOff = { control: "platform", default: false } as const

export const FEATURES = defineFeatures({
  installLinks: {
    label: "Install links",
    description: "Workspace admins can create desktop install links for their organization.",
    since: "2026-10",
    cloud: platformDefaultOn,
    selfHosted: platformDefaultOn,
  },
  mcpConnections: {
    label: "OpenWork Connect",
    description: "Members see the organization's connections, marketplace capabilities on the agent rail, and the desktop Connect tab.",
    since: "2026-10",
    cloud: platformDefaultOn,
    selfHosted: platformDefaultOn,
  },
  modelsAnalytics: {
    label: "OpenWork Models task analytics",
    description: "Organization admins can opt in to task analytics for OpenWork Models.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  auditLogs: {
    label: "Audit logs",
    description: "Organization admins can read and configure audit logs. Capture still needs an audit entitlement.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  orgManagedDashboards: {
    label: "Dashboards",
    description: "Organization admins publish dashboards to members in Den and the desktop app.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  slackAssistant: {
    label: "Slack Assistant",
    description: "Answers Slack mentions and DMs for the organization after the Slack connector is set up.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  slackAssistantHeadless: {
    label: "Slack Assistant: headless runtime",
    description: "Answers Slack on the shared headless runner instead of each member's OpenWork Web computer. Needs the deployment's headless runner.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  headlessAutomations: {
    label: "Cloud Automations: headless runtime",
    description: "Runs the organization's cloud Automations on the shared headless runner. Needs the deployment's headless runner and a plan that includes it.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  workbot: {
    label: "Workbot",
    description: "Members can use Workbot. Needs the deployment's Workbot app.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
