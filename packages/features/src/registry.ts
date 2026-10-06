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
 *
 * Every feature belongs to exactly one module (`module`, a module id from
 * @openwork/license-contracts). Modules say what an organization has
 * (permanent, decided by plan or license plus the organization's opt-outs);
 * features say whether new code is safe to show yet (temporary rollout). A
 * feature is on only when its module is on and its flag is on, so a flag can
 * hold a module back but never grants one. A brand-new product area adds a
 * module id first (append-only, in packages/license-contracts), then declares
 * its flag here with that module. When the rollout is done, delete the flag
 * and the module's entitlement is the only gate.
 */

import type { ModuleId } from "@openwork/license-contracts"

export type FeatureDeployment = "cloud" | "self_hosted"

export type FeatureDefinition = {
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** The module this feature belongs to. The feature is on only when the module is on too. */
  module: ModuleId
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
  installLinks: {
    label: "Install links",
    description: "Workspace admins can create desktop install links for their organization.",
    module: "installLinks",
    since: "2026-10",
    deployments: everywhere,
    default: true,
  },
  mcpConnections: {
    label: "OpenWork Connect",
    description: "Members see the organization's connections, marketplace capabilities on the agent rail, and the desktop Connect tab.",
    module: "connect",
    since: "2026-10",
    deployments: everywhere,
    default: true,
  },
  modelsAnalytics: {
    label: "OpenWork Models task analytics",
    description: "Organization admins can opt in to task analytics for OpenWork Models.",
    module: "openworkModels.analytics",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  auditLogs: {
    label: "Audit logs",
    description: "Organization admins can read and configure audit logs. Capture still needs an audit entitlement.",
    module: "auditLogs",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  orgManagedDashboards: {
    label: "Dashboards",
    description: "Organization admins publish dashboards to members in Den and the desktop app.",
    module: "dashboards",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  slackAssistant: {
    label: "Slack Assistant",
    description: "Answers Slack mentions and DMs for the organization after the Slack connector is set up.",
    module: "slackAssistant",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  slackAssistantHeadless: {
    label: "Slack Assistant: headless runtime",
    description: "Answers Slack on the shared headless runner instead of each member's OpenWork Web computer. Needs the deployment's headless runner.",
    module: "slackAssistant.headless",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  headlessAutomations: {
    label: "Cloud Automations: headless runtime",
    description: "Runs the organization's cloud Automations on the shared headless runner. Needs the deployment's headless runner and a plan that includes it.",
    module: "automations.headless",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  workbot: {
    label: "Workbot",
    description: "Members can use Workbot. Needs the deployment's Workbot app.",
    module: "workbot",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
  litellm: {
    label: "AI Gateway: LiteLLM",
    description: "Organization admins can connect their own LiteLLM proxy to AI Gateway, with one shared key, each person's own key, or keys OpenWork creates for each person.",
    module: "aiGateway",
    since: "2026-10",
    deployments: everywhere,
    default: false,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
