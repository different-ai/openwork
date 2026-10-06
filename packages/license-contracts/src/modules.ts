import { isModuleId, MODULE_IDS, type ModuleId } from "./module-ids"

export { isModuleId, MODULE_IDS, moduleIdSchema, parseModuleIdList, type ModuleId } from "./module-ids"

export type Deployment = "cloud" | "selfHosted"
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
  /** Sub-module parent. Implies a hard dependency on the parent (D6). Must equal the id prefix. */
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

const BOTH: readonly Deployment[] = ["cloud", "selfHosted"]
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
  connect: {
    ...LICENSED,
    id: "connect",
    name: "Connectors",
    description: "Connect MCP servers and apps that members can use.",
    softDependsOn: ["marketplace"],
  },
  "connect.nativeProviders": {
    ...LICENSED,
    id: "connect.nativeProviders",
    name: "Google Workspace and Microsoft 365",
    description: "Connect Google Workspace and Microsoft 365 accounts.",
    parent: "connect",
  },
  marketplace: {
    ...LICENSED,
    id: "marketplace",
    name: "Marketplace",
    description: "Share plugins and skills across your organization.",
    softDependsOn: ["connect", "workflows"],
  },
  "marketplace.githubSync": {
    ...LICENSED,
    id: "marketplace.githubSync",
    name: "GitHub sync",
    description: "Import plugins and skills from GitHub repositories.",
    parent: "marketplace",
    softDependsOn: ["connect"],
  },
  workflows: {
    ...LICENSED,
    id: "workflows",
    name: "Workflows",
    description: "Save and run reusable agent workflows.",
    dependsOn: ["marketplace"],
    softDependsOn: ["connect", "automations"],
  },
  mcpApps: {
    ...LICENSED,
    id: "mcpApps",
    name: "MCP Apps",
    description: "Build interactive apps that run as MCP servers.",
    dependsOn: ["connect", "marketplace"],
    softDependsOn: ["workflows"],
    stability: "beta",
  },
  dashboards: {
    ...LICENSED,
    id: "dashboards",
    name: "Dashboards",
    description: "Publish dashboards for your organization.",
    softDependsOn: ["mcpApps", "connect"],
    stability: "beta",
  },
  automations: {
    ...LICENSED,
    id: "automations",
    name: "Automations",
    description: "Schedule agent work to run automatically.",
    softDependsOn: ["workflows", "openworkWeb", "aiGateway", "openworkModels", "customProviders", "desktopPolicies"],
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
    dependsOn: ["connect"],
    softDependsOn: ["aiGateway", "openworkModels", "automations"],
  },
  workbot: {
    ...LICENSED,
    id: "workbot",
    name: "Workbot",
    description: "Give your organization a shared cloud agent.",
    dependsOn: ["connect"],
    softDependsOn: ["automations.headless"],
    stability: "beta",
  },
  slackAssistant: {
    ...LICENSED,
    id: "slackAssistant",
    name: "Slack assistant",
    description: "Work with OpenWork from Slack.",
    dependsOn: ["connect"],
    softDependsOn: ["automations.remoteSessions", "openworkWeb"],
    stability: "beta",
  },
  "slackAssistant.headless": {
    ...LICENSED,
    id: "slackAssistant.headless",
    name: "Slack background runs",
    description: "Let the Slack assistant run tasks without a desktop.",
    parent: "slackAssistant",
    stability: "beta",
  },
  aiGateway: {
    ...LICENSED,
    id: "aiGateway",
    name: "AI Gateway",
    description: "Route model traffic through your organization's gateway.",
    softDependsOn: ["auditLogs"],
  },
  "aiGateway.usageLimits": {
    ...LICENSED,
    id: "aiGateway.usageLimits",
    name: "Usage limits",
    description: "Set spending and request limits for the AI Gateway.",
    parent: "aiGateway",
    softDependsOn: ["teams"],
  },
  openworkModels: {
    ...LICENSED,
    id: "openworkModels",
    name: "OpenWork Models",
    description: "Use managed models billed through OpenWork.",
    dependsOn: ["billing"],
    softDependsOn: ["customProviders"],
    deployments: CLOUD,
  },
  "openworkModels.analytics": {
    ...LICENSED,
    id: "openworkModels.analytics",
    name: "Models analytics",
    description: "See usage and spend for OpenWork Models.",
    parent: "openworkModels",
    deployments: CLOUD,
    stability: "beta",
  },
  freeInference: {
    ...LICENSED,
    id: "freeInference",
    name: "Free models",
    description: "Offer free models to members.",
    softDependsOn: ["desktopPolicies"],
    deployments: CLOUD,
    stability: "beta",
  },
  customProviders: {
    ...LICENSED,
    id: "customProviders",
    name: "Custom providers",
    description: "Share your own model provider keys with members.",
    softDependsOn: ["desktopPolicies"],
  },
  desktopPolicies: {
    ...LICENSED,
    id: "desktopPolicies",
    name: "Desktop policies",
    description: "Control which desktop features members can use.",
    softDependsOn: ["teams"],
  },
  versionPinning: {
    ...LICENSED,
    id: "versionPinning",
    name: "Version pinning",
    description: "Choose which desktop versions members can run.",
  },
  branding: {
    ...LICENSED,
    id: "branding",
    name: "Branding",
    description: "Use your own logo and colors.",
  },
  analytics: {
    ...LICENSED,
    id: "analytics",
    name: "Analytics",
    description: "See how your organization uses OpenWork.",
    softDependsOn: ["workflows"],
  },
  auditLogs: {
    ...LICENSED,
    id: "auditLogs",
    name: "Audit logs",
    description: "Record who changed what in your organization.",
  },
  "auditLogs.export": {
    ...LICENSED,
    id: "auditLogs.export",
    name: "Audit log export",
    description: "Download audit logs as files.",
    parent: "auditLogs",
  },
  teams: {
    ...LICENSED,
    id: "teams",
    name: "Teams",
    description: "Group members into teams for access and policies.",
  },
  advancedPermissions: {
    ...LICENSED,
    id: "advancedPermissions",
    name: "Custom roles",
    description: "Create roles with your own permissions.",
  },
  diagnostics: {
    ...LICENSED,
    id: "diagnostics",
    name: "Diagnostics",
    description: "Check network access from your deployment.",
  },
  billing: {
    ...FREE,
    id: "billing",
    name: "Billing",
    description: "Manage your plan, seats and invoices.",
    deployments: CLOUD,
    orgToggle: "none",
  },
  enterpriseAuth: {
    ...LICENSED,
    id: "enterpriseAuth",
    name: "Enterprise sign-in",
    description: "Single sign-on and user provisioning.",
    orgToggle: "none",
  },
  "enterpriseAuth.sso": {
    ...LICENSED,
    id: "enterpriseAuth.sso",
    name: "Single sign-on",
    description: "Let members sign in with your identity provider.",
    parent: "enterpriseAuth",
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
  "enterpriseAuth.scim": {
    ...LICENSED,
    id: "enterpriseAuth.scim",
    name: "User provisioning",
    description: "Sync members from your identity provider with SCIM.",
    parent: "enterpriseAuth",
    dependsOn: ["enterpriseAuth.sso"],
    softDependsOn: ["teams"],
    orgToggle: "none",
  },
  installLinks: {
    ...FREE,
    id: "installLinks",
    name: "Install links",
    description: "Share desktop download links with members.",
    softDependsOn: ["branding", "versionPinning"],
  },
  webOrigins: {
    ...LICENSED,
    id: "webOrigins",
    name: "Web origins",
    description: "Approve websites that can call OpenWork.",
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
 * `freeInference` follows the Cloud rollout setting, so it is not granted here.
 */
export const CLOUD_FREE_PLAN_MODULES: Readonly<Record<ModuleId, boolean>> = Object.freeze({
  connect: true,
  "connect.nativeProviders": true,
  marketplace: true,
  "marketplace.githubSync": true,
  workflows: true,
  mcpApps: false,
  dashboards: false,
  automations: true,
  "automations.headless": false,
  "automations.remoteSessions": true,
  openworkWeb: true,
  workbot: false,
  slackAssistant: false,
  "slackAssistant.headless": false,
  aiGateway: true,
  "aiGateway.usageLimits": true,
  openworkModels: true,
  "openworkModels.analytics": false,
  freeInference: false,
  customProviders: true,
  desktopPolicies: true,
  versionPinning: true,
  branding: true,
  analytics: true,
  auditLogs: false,
  "auditLogs.export": false,
  teams: true,
  advancedPermissions: true,
  diagnostics: true,
  billing: true,
  enterpriseAuth: true,
  "enterpriseAuth.sso": true,
  "enterpriseAuth.scim": true,
  installLinks: true,
  webOrigins: true,
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
  const deployment: Deployment = context.scope === "hosted_cloud_org" ? "cloud" : "selfHosted"
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
