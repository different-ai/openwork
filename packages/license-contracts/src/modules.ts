import { isModuleId, MODULE_IDS, type ModuleId } from "./module-ids"

export {
  isModuleGroupId,
  isModuleId,
  MODULE_GROUPS,
  MODULE_IDS,
  moduleIdSchema,
  nearestModuleAncestor,
  parseModuleIdList,
  type ModuleGroupId,
  type ModuleId,
} from "./module-ids"

/** Same values as `DEN_DEPLOYMENT` and `FeatureDeployment` in `@openwork/features`. */
export type Deployment = "cloud" | "self_hosted"
export type TransitionOperationPolicy = "allow" | "owner_only" | "deny"
export type ModuleEntitlement = "free" | "licensed"
export type ModuleOrgToggle = "none" | "optOut"
export type ModuleExpiryPolicy = "immediate" | "continue" | "restricted" | "n/a"
export type ModuleStability = "ga" | "beta" | "deprecated"

export interface ModuleDefinition {
  readonly id: ModuleId
  /** UI label (English; clients may localize by id). */
  readonly name: string
  readonly description: string
  /**
   * Sub-module parent. Implies a hard dependency on the parent (D6). Must equal
   * the nearest id prefix that is a module; groups are skipped (D44).
   */
  readonly parent: ModuleId | null
  /** Hard dependencies: drive the effective state and the wave order. */
  readonly dependsOn: readonly ModuleId[]
  /** Informational: the module degrades gracefully without these. Never affects state. */
  readonly softDependsOn: readonly ModuleId[]
  /** Where the module can exist at all (D3, D13). */
  readonly deployments: readonly Deployment[]
  /** `free`: entitled whenever the scope has any entitlement source (never on keyless self-hosted, D14). */
  readonly entitlement: ModuleEntitlement
  /** `optOut`: an entitled org's owner or super-admin can switch it off (D7, D21, D25). */
  readonly orgToggle: ModuleOrgToggle
  /** Licensed modules only (`free` → `n/a`). Trial licenses always behave as `immediate` (D22). */
  readonly expiryPolicy: ModuleExpiryPolicy
  /** Required iff `expiryPolicy` is `restricted`; must contain `other`. */
  readonly transitionOperations?: Readonly<Record<string, TransitionOperationPolicy>>
  /** UI only; no effect on resolution. */
  readonly stability: ModuleStability
}

const BOTH: readonly Deployment[] = ["cloud", "self_hosted"]
const CLOUD: readonly Deployment[] = ["cloud"]

const LICENSED = {
  parent: null,
  dependsOn: [],
  softDependsOn: [],
  deployments: BOTH,
  entitlement: "licensed",
  orgToggle: "optOut",
  expiryPolicy: "continue",
  stability: "ga",
} as const

const FREE = {
  ...LICENSED,
  entitlement: "free",
  expiryPolicy: "n/a",
} as const

const registry = {
  "org.members.teams": {
    ...LICENSED,
    id: "org.members.teams",
    name: "Teams",
    description: "Group members into teams for access and policies.",
  },
  "org.members.roles": {
    ...LICENSED,
    id: "org.members.roles",
    name: "Custom roles",
    description: "Create roles with your own permissions.",
  },
  "org.auth.sso": {
    ...LICENSED,
    id: "org.auth.sso",
    name: "Single sign-on",
    description: "Let members sign in with your identity provider.",
    orgToggle: "none",
    expiryPolicy: "restricted",
    transitionOperations: {
      ssoSignIn: "allow",
      ssoJitProvision: "deny",
      ssoEnforcement: "allow",
      ssoRead: "owner_only",
      ssoConfigure: "deny",
      other: "deny",
    },
  },
  "org.auth.scim": {
    ...LICENSED,
    id: "org.auth.scim",
    name: "User provisioning",
    description: "Sync members from your identity provider with SCIM.",
    dependsOn: ["org.auth.sso"],
    softDependsOn: ["org.members.teams"],
    orgToggle: "none",
  },
  "org.observability.auditLogs": {
    ...LICENSED,
    id: "org.observability.auditLogs",
    name: "Audit logs",
    description: "Record who changed what in your organization.",
  },
  "org.observability.auditLogs.export": {
    ...LICENSED,
    id: "org.observability.auditLogs.export",
    name: "Audit log export",
    description: "Download audit logs as files.",
    parent: "org.observability.auditLogs",
  },
  "org.desktopPolicies": {
    ...LICENSED,
    id: "org.desktopPolicies",
    name: "Desktop policies",
    description: "Control which desktop features members can use.",
    softDependsOn: ["org.members.teams"],
  },
  "org.desktopPolicies.versionPinning": {
    ...LICENSED,
    id: "org.desktopPolicies.versionPinning",
    name: "Version pinning",
    description: "Choose which desktop versions members can run.",
    parent: "org.desktopPolicies",
  },
  "org.installLinks": {
    ...FREE,
    id: "org.installLinks",
    name: "Install links",
    description: "Share desktop download links with members.",
    softDependsOn: ["org.branding", "org.desktopPolicies.versionPinning"],
  },
  "org.branding": {
    ...LICENSED,
    id: "org.branding",
    name: "Branding",
    description: "Use your own logo and colors.",
  },
  "org.webOrigins": {
    ...LICENSED,
    id: "org.webOrigins",
    name: "Web origins",
    description: "Approve websites that can call OpenWork.",
  },
  "org.diagnostics": {
    ...LICENSED,
    id: "org.diagnostics",
    name: "Diagnostics",
    description: "Check network access from your deployment.",
  },
  "org.billing": {
    ...FREE,
    id: "org.billing",
    name: "Billing",
    description: "Manage your plan, seats and invoices.",
    deployments: CLOUD,
    orgToggle: "none",
  },
  "ai.gateway": {
    ...LICENSED,
    id: "ai.gateway",
    name: "AI Gateway",
    description: "Route model traffic through your organization's gateway.",
    softDependsOn: ["org.observability.auditLogs"],
  },
  "ai.gateway.usageLimits": {
    ...LICENSED,
    id: "ai.gateway.usageLimits",
    name: "Usage limits",
    description: "Set spending and request limits for the AI Gateway.",
    parent: "ai.gateway",
    softDependsOn: ["org.members.teams"],
  },
  "ai.gateway.openworkModels": {
    ...LICENSED,
    id: "ai.gateway.openworkModels",
    name: "OpenWork Models",
    description: "Use managed models billed through OpenWork.",
    parent: "ai.gateway",
    dependsOn: ["org.billing"],
    softDependsOn: ["ai.customProviders"],
    deployments: CLOUD,
  },
  "ai.gateway.openworkModels.analytics": {
    ...LICENSED,
    id: "ai.gateway.openworkModels.analytics",
    name: "Models analytics",
    description: "See usage and spend for OpenWork Models.",
    parent: "ai.gateway.openworkModels",
    deployments: CLOUD,
    stability: "beta",
  },
  "ai.gateway.freeInference": {
    ...LICENSED,
    id: "ai.gateway.freeInference",
    name: "Free models",
    description: "Offer free models to members.",
    parent: "ai.gateway",
    softDependsOn: ["org.desktopPolicies"],
    deployments: CLOUD,
    stability: "beta",
  },
  "ai.customProviders": {
    ...LICENSED,
    id: "ai.customProviders",
    name: "Custom providers",
    description: "Share your own model provider keys with members.",
    softDependsOn: ["org.desktopPolicies"],
  },
  "library.plugins": {
    ...LICENSED,
    id: "library.plugins",
    name: "Plugins",
    description: "Share plugins, skills and marketplaces across your organization.",
    softDependsOn: ["library.connectors", "library.workflows"],
  },
  "library.plugins.githubSync": {
    ...LICENSED,
    id: "library.plugins.githubSync",
    name: "GitHub sync",
    description: "Import plugins and skills from GitHub repositories.",
    parent: "library.plugins",
    softDependsOn: ["library.connectors"],
  },
  "library.workflows": {
    ...LICENSED,
    id: "library.workflows",
    name: "Workflows",
    description: "Save and run reusable agent workflows.",
    dependsOn: ["library.plugins"],
    softDependsOn: ["library.connectors", "automations"],
  },
  "library.apps": {
    ...LICENSED,
    id: "library.apps",
    name: "Apps",
    description: "Build interactive apps that run as MCP servers.",
    dependsOn: ["library.plugins", "library.connectors"],
    softDependsOn: ["library.workflows"],
    stability: "beta",
  },
  "library.connectors": {
    ...LICENSED,
    id: "library.connectors",
    name: "Connectors",
    description: "Connect MCP servers and apps that members can use.",
    softDependsOn: ["library.plugins"],
  },
  "library.connectors.native.googleWorkspace": {
    ...LICENSED,
    id: "library.connectors.native.googleWorkspace",
    name: "Google Workspace",
    description: "Connect Google Workspace accounts.",
    parent: "library.connectors",
  },
  "library.connectors.native.microsoft365": {
    ...LICENSED,
    id: "library.connectors.native.microsoft365",
    name: "Microsoft 365",
    description: "Connect Microsoft 365 accounts.",
    parent: "library.connectors",
  },
  "library.connectors.slackAssistant": {
    ...LICENSED,
    id: "library.connectors.slackAssistant",
    name: "Slack assistant",
    description: "Work with OpenWork from Slack.",
    parent: "library.connectors",
    softDependsOn: ["automations.remoteSessions", "openworkWeb"],
    stability: "beta",
  },
  "library.connectors.slackAssistant.headless": {
    ...LICENSED,
    id: "library.connectors.slackAssistant.headless",
    name: "Slack background runs",
    description: "Let the Slack assistant run tasks without a desktop.",
    parent: "library.connectors.slackAssistant",
    stability: "beta",
  },
  dashboards: {
    ...LICENSED,
    id: "dashboards",
    name: "Dashboards",
    description: "Publish dashboards for your organization.",
    softDependsOn: ["library.apps", "library.connectors"],
    stability: "beta",
  },
  automations: {
    ...LICENSED,
    id: "automations",
    name: "Automations",
    description: "Schedule agent work to run automatically.",
    softDependsOn: [
      "library.workflows",
      "openworkWeb",
      "ai.gateway",
      "ai.gateway.openworkModels",
      "ai.customProviders",
      "org.desktopPolicies",
    ],
  },
  "automations.headless": {
    ...LICENSED,
    id: "automations.headless",
    name: "Background automations",
    description: "Run automations in the cloud without a desktop.",
    parent: "automations",
    stability: "beta",
  },
  "automations.remoteSessions": {
    ...LICENSED,
    id: "automations.remoteSessions",
    name: "Remote sessions",
    description: "Start and follow agent sessions from the web or another device.",
    parent: "automations",
    softDependsOn: ["openworkWeb"],
    stability: "beta",
  },
  openworkWeb: {
    ...LICENSED,
    id: "openworkWeb",
    name: "OpenWork Web",
    description: "Run OpenWork chats in the cloud from a browser.",
    dependsOn: ["library.connectors"],
    softDependsOn: ["ai.gateway", "ai.gateway.openworkModels", "automations"],
  },
  workbot: {
    ...LICENSED,
    id: "workbot",
    name: "Workbot",
    description: "Give your organization a shared cloud agent.",
    dependsOn: ["library.connectors"],
    softDependsOn: ["automations.headless"],
    stability: "beta",
  },
} satisfies Record<ModuleId, ModuleDefinition>

function freezeDefinition(definition: ModuleDefinition): void {
  Object.freeze(definition.dependsOn)
  Object.freeze(definition.softDependsOn)
  Object.freeze(definition.deployments)
  if (definition.transitionOperations) Object.freeze(definition.transitionOperations)
  Object.freeze(definition)
}

function freezeRegistry(definitions: Record<ModuleId, ModuleDefinition>): Readonly<Record<ModuleId, ModuleDefinition>> {
  for (const id of MODULE_IDS) freezeDefinition(definitions[id])
  return Object.freeze(definitions)
}

/** The module registry, keyed in MODULE_IDS order. Deeply frozen. */
export const MODULE_DEFINITIONS: Readonly<Record<ModuleId, ModuleDefinition>> = freezeRegistry(registry)

/** Parent first, then hard dependencies. */
export function hardEdges(definition: ModuleDefinition): ModuleId[] {
  return definition.parent ? [definition.parent, ...definition.dependsOn] : [...definition.dependsOn]
}

/**
 * Topological order over `parent ∪ dependsOn`; ties keep MODULE_IDS order.
 * Throws when the hard graph has a cycle or references an unknown id.
 */
export function computeModuleTopoOrder(definitions: Readonly<Record<ModuleId, ModuleDefinition>>): ModuleId[] {
  const placed = new Set<ModuleId>()
  const order: ModuleId[] = []
  while (order.length < MODULE_IDS.length) {
    const next = MODULE_IDS.find(
      (id) => !placed.has(id) && hardEdges(definitions[id]).every((dependency) => {
        if (!isModuleId(dependency)) throw new Error(`Module ${id} references unknown module ${String(dependency)}`)
        return placed.has(dependency)
      }),
    )
    if (next === undefined) {
      const remaining = MODULE_IDS.filter((id) => !placed.has(id))
      throw new Error(`Module dependency cycle among: ${remaining.join(", ")}`)
    }
    placed.add(next)
    order.push(next)
  }
  return order
}

/** Every id once, after all of its parent and hard dependencies. */
export const MODULE_TOPO_ORDER: readonly ModuleId[] = Object.freeze(computeModuleTopoOrder(MODULE_DEFINITIONS))

/** Parent chain, nearest first. */
export function moduleAncestors(id: ModuleId): ModuleId[] {
  const out: ModuleId[] = []
  let parent = MODULE_DEFINITIONS[id].parent
  while (parent) {
    out.push(parent)
    parent = MODULE_DEFINITIONS[parent].parent
  }
  return out
}

/** Direct sub-modules, in MODULE_IDS order. */
export function moduleChildren(id: ModuleId): ModuleId[] {
  return MODULE_IDS.filter((candidate) => MODULE_DEFINITIONS[candidate].parent === id)
}

/** Transitive `parent ∪ dependsOn`, in topological order, excluding the module itself. */
export function hardDependencyClosure(id: ModuleId): ModuleId[] {
  const seen = new Set<ModuleId>()
  const stack = hardEdges(MODULE_DEFINITIONS[id])
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    stack.push(...hardEdges(MODULE_DEFINITIONS[next]))
  }
  return MODULE_TOPO_ORDER.filter((candidate) => seen.has(candidate))
}

/**
 * Den's entitlement fallback for a Cloud org without a license snapshot yet
 * (discovery §7.4). Reproduces today's free-tier module states
 * (`00-license-contract-changes.md` T8); the license server's free plan must equal it.
 * `ai.gateway.freeInference` follows the Cloud rollout setting, so it is not granted here.
 */
export const CLOUD_FREE_PLAN_MODULES: Readonly<Record<ModuleId, boolean>> = Object.freeze({
  "org.members.teams": true,
  "org.members.roles": true,
  "org.auth.sso": true,
  "org.auth.scim": true,
  "org.observability.auditLogs": false,
  "org.observability.auditLogs.export": false,
  "org.desktopPolicies": true,
  "org.desktopPolicies.versionPinning": true,
  "org.installLinks": true,
  "org.branding": true,
  "org.webOrigins": true,
  "org.diagnostics": true,
  "org.billing": true,
  "ai.gateway": true,
  "ai.gateway.usageLimits": true,
  "ai.gateway.openworkModels": true,
  "ai.gateway.openworkModels.analytics": false,
  "ai.gateway.freeInference": false,
  "ai.customProviders": true,
  "library.plugins": true,
  "library.plugins.githubSync": true,
  "library.workflows": true,
  "library.apps": false,
  "library.connectors": true,
  "library.connectors.native.googleWorkspace": true,
  "library.connectors.native.microsoft365": true,
  "library.connectors.slackAssistant": false,
  "library.connectors.slackAssistant.headless": false,
  dashboards: false,
  automations: true,
  "automations.headless": false,
  "automations.remoteSessions": true,
  openworkWeb: true,
  workbot: false,
} satisfies Record<ModuleId, boolean>)

export type LicenseModuleScope = "hosted_cloud_org" | "external_den"

export type LicenseModuleIssueCode =
  | "unknown_module"
  | "submodule_without_parent"
  | "not_on_deployment"
  | "missing_hard_dependency"

export interface LicenseModuleIssue {
  code: LicenseModuleIssueCode
  module: string
  detail?: string
}

/**
 * Checks a license `modules` map against the registry. The license server
 * refuses `unknown_module`, `submodule_without_parent` and `not_on_deployment`
 * at write time and shows `missing_hard_dependency` as a warning. Den only
 * reports these (the resolver already ignores unknown keys and resolves a
 * sub-module without its parent to `requires`).
 */
export function validateLicenseModules(
  modules: Readonly<Record<string, boolean>>,
  context: { scope: LicenseModuleScope },
  definitions: Readonly<Record<ModuleId, ModuleDefinition>> = MODULE_DEFINITIONS,
): LicenseModuleIssue[] {
  const deployment: Deployment = context.scope === "hosted_cloud_org" ? "cloud" : "self_hosted"
  const granted = (id: ModuleId) => modules[id] === true || (modules[id] === undefined && definitions[id].entitlement === "free")
  const issues: LicenseModuleIssue[] = []
  for (const [key, value] of Object.entries(modules)) {
    if (!isModuleId(key)) {
      issues.push({ code: "unknown_module", module: key })
      continue
    }
    if (value !== true) continue
    const definition = definitions[key]
    if (definition.parent && !granted(definition.parent)) {
      issues.push({ code: "submodule_without_parent", module: key, detail: definition.parent })
    }
    if (!definition.deployments.includes(deployment)) {
      issues.push({ code: "not_on_deployment", module: key, detail: deployment })
    }
    for (const dependency of definition.dependsOn) {
      if (!granted(dependency)) issues.push({ code: "missing_hard_dependency", module: key, detail: dependency })
    }
  }
  return issues
}
