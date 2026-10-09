import { z } from "zod"

/**
 * Organization permission catalog shared by den-api (enforcement) and den-web
 * (editors and gating). See docs/permissions/overview.md, sections 4 and 7.
 *
 * Rules:
 * - Keys are permanent. Never reuse a key for a different meaning.
 * - Actions only the owner can ever do (delete organization, transfer
 *   ownership) are not here.
 * - Baseline member actions (things every member can do today) are not here.
 * - `defaultOn` reproduces the role checks from before Permissions: a key is
 *   `["admin"]` only when every action it gates was open to plain admins.
 *   Actions that needed super-admin (now removed) are owner-only by default:
 *   `defaultOn: []`. The owner holds every key, and with the Permissions
 *   feature on can grant owner-only keys to Admin or team permissions.
 * - `sensitive` matches the old recent sign-in requirement of what it gates.
 */

export const PERMISSION_DEFAULT_SET_KEYS = ["member", "admin"] as const
export type PermissionDefaultSetKey = (typeof PERMISSION_DEFAULT_SET_KEYS)[number]

export const PERMISSION_AREAS = {
  organization: { label: "Organization" },
  members: { label: "Members and teams" },
  access: { label: "Permissions" },
  sharing: { label: "Sharing" },
  security: { label: "Security and sign-in" },
  desktop: { label: "Desktop app" },
  deployments: { label: "Deployments" },
  billing: { label: "Billing" },
  models: { label: "Models and providers" },
  gateway: { label: "AI Gateway" },
  connections: { label: "Connections" },
  library: { label: "Plugins and marketplaces" },
  dashboards: { label: "Dashboards" },
} as const satisfies Record<string, { label: string }>

export type PermissionAreaKey = keyof typeof PERMISSION_AREAS

export type PermissionDefinition = {
  area: PermissionAreaKey
  /** Short, user-facing label, e.g. "Delete providers". */
  label: string
  description?: string
  /** Code defaults (feature off) and seed/reconcile targets (feature on). */
  defaultOn: readonly PermissionDefaultSetKey[]
  /** Can never be denied in these default sets. No key uses it today: the owner can always restore access. */
  lockedOn?: readonly "admin"[]
  /** Requires a recent sign-in (PRIVILEGED_SESSION_MAX_AGE_MS). */
  sensitive?: boolean
  /**
   * Reconciliation only allows this key in a default set where `follows` is
   * currently allowed. Must name another catalog key; checked at compile time
   * by `PermissionFollowsTarget` and at runtime by `permissionCatalogProblems`.
   */
  follows?: string
}

const ADMIN = ["admin"] as const
/** Owner-only by default: formerly super-admin (or owner) actions. */
const OWNER_ONLY = [] as const

export const PERMISSIONS = {
  // Organization
  "organization.update": {
    area: "organization",
    label: "Edit organization settings",
    description: "Change the organization name, slug and other workspace settings.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "branding.update": {
    area: "organization",
    label: "Change branding",
    description: "Upload the organization logo and other brand assets.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "web_origins.view": {
    area: "organization",
    label: "View approved web origins",
    defaultOn: ADMIN,
  },
  "web_origins.manage": {
    area: "organization",
    label: "Manage approved web origins",
    description: "Approve and remove websites that may embed or call OpenWork.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "install_links.update": {
    area: "organization",
    label: "Rotate install links",
    description: "Replace existing desktop install links. Creating a link stays open to every member.",
    defaultOn: ADMIN,
    sensitive: true,
  },

  // Members and teams
  "invitations.manage": {
    area: "members",
    label: "Invite people",
    description: "Invite people as members and cancel pending invitations. Inviting someone as an admin also needs Change member roles.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "members.update": {
    area: "members",
    label: "Change member roles",
    description: "Make people admins or members, including inviting someone as an admin.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "members.delete": {
    area: "members",
    label: "Remove members",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "teams.view": {
    area: "members",
    label: "View any team",
    description: "Open any team's details, including teams you are not in.",
    defaultOn: ADMIN,
  },
  "teams.manage": {
    area: "members",
    label: "Manage teams",
    description: "Create, rename and delete teams and change who is in them.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "teams.manage_admin": {
    area: "members",
    label: "Manage Admin teams",
    description: "Mark a team as an Admin team, change its members, delete it, or invite people into it.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Permissions
  "permissions.view": {
    area: "access",
    label: "View permissions",
    description: "See Member, Admin and team permissions and their history.",
    defaultOn: ADMIN,
  },
  "permissions.manage": {
    area: "access",
    label: "Manage permissions",
    description: "Change Member, Admin and team permissions.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Sharing
  "sharing.manage_all": {
    area: "sharing",
    label: "Manage everything shared",
    description: "Act as a manager on every plugin, marketplace, skill and connector in the organization, even when it was not shared with you.",
    defaultOn: ADMIN,
  },
  "sharing.share_org_wide": {
    area: "sharing",
    label: "Share with everyone",
    description: "Share plugins, skills, marketplaces and connections with the whole organization.",
    defaultOn: ADMIN,
  },

  // Security and sign-in
  "sso.view": {
    area: "security",
    label: "View single sign-on",
    defaultOn: ADMIN,
  },
  "sso.manage": {
    area: "security",
    label: "Manage single sign-on",
    description: "Configure SAML or OIDC, verify domains, and turn single sign-on on or off.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "scim.view": {
    area: "security",
    label: "View SCIM provisioning",
    defaultOn: ADMIN,
  },
  "scim.manage": {
    area: "security",
    label: "Manage SCIM provisioning",
    description: "Create SCIM tokens, change mapping, reconcile and turn SCIM off.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "api_keys.view": {
    area: "security",
    label: "View API keys",
    defaultOn: ADMIN,
  },
  "api_keys.manage": {
    area: "security",
    label: "Manage API keys",
    description: "Create and revoke organization API keys.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "audit.view": {
    area: "security",
    label: "View audit history",
    description: "Read and export the organization's audit events and usage.",
    defaultOn: ADMIN,
  },
  "audit.manage": {
    area: "security",
    label: "Change audit capture",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "egress_diagnostics.view": {
    area: "security",
    label: "View network diagnostics",
    defaultOn: ADMIN,
  },
  "egress_diagnostics.manage": {
    area: "security",
    label: "Run network diagnostics",
    description: "Configure and run outbound network diagnostics.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Desktop app
  "desktop_policies.view": {
    area: "desktop",
    label: "View desktop policies",
    defaultOn: ADMIN,
  },
  "desktop_policies.manage": {
    area: "desktop",
    label: "Manage desktop policies",
    description: "Create, change and delete desktop app policies.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Deployments
  "deployments.view": {
    area: "deployments",
    label: "View deployments",
    description: "See the organization's installations in its own cloud accounts and which clouds can be launched.",
    defaultOn: ADMIN,
  },
  "deployments.manage": {
    area: "deployments",
    label: "Manage deployments",
    description: "Create, launch, update and remove installations in the organization's own cloud accounts.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Billing
  "billing.view": {
    area: "billing",
    label: "View billing",
    defaultOn: ADMIN,
  },
  "billing.manage": {
    area: "billing",
    label: "Start a subscription",
    description: "Start paid billing in checkout and refresh its status afterwards.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "billing_portal.use": {
    area: "billing",
    label: "Open the billing portal",
    description: "Change payment details, see invoices and change or cancel the subscription.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },

  // Models and providers
  "inference.view": {
    area: "models",
    label: "View OpenWork Models settings",
    description: "See OpenWork Models settings and the organization's free allowance summary.",
    defaultOn: ADMIN,
  },
  "inference.manage": {
    area: "models",
    label: "Manage OpenWork Models",
    description: "Turn OpenWork Models on or off and change the Auto pin.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "analytics.view": {
    area: "models",
    label: "View task analytics",
    defaultOn: ADMIN,
  },
  "analytics.manage": {
    area: "models",
    label: "Manage task analytics",
    description: "Turn task analytics on or off and connect or disconnect analytics exports.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "llm_providers.view": {
    area: "models",
    label: "View all providers",
    description: "See every provider in the organization, not only your own or those shared with you.",
    defaultOn: ADMIN,
  },
  "llm_providers.update": {
    area: "models",
    label: "Edit any provider",
    description: "Change any provider and who can use it. People can always edit providers they added.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "llm_providers.delete": {
    area: "models",
    label: "Delete any provider",
    description: "People can always delete providers they added.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "llm_provider_credentials.manage": {
    area: "models",
    label: "Manage people's provider keys",
    description: "List, provision and block member credentials for providers.",
    defaultOn: ADMIN,
    sensitive: true,
  },

  // AI Gateway
  "gateway_providers.view": {
    area: "gateway",
    label: "View Gateway providers",
    description: "See Gateway providers, model groups, credential sets and access grants.",
    defaultOn: ADMIN,
  },
  "gateway_providers.manage": {
    area: "gateway",
    label: "Manage Gateway providers",
    description: "Create, change and delete Gateway providers, model groups, credential sets and access grants.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "gateway_usage.view": {
    area: "gateway",
    label: "View Gateway usage",
    defaultOn: ADMIN,
  },
  "gateway_limits.view": {
    area: "gateway",
    label: "View usage limits",
    description: "See usage limit policies, assignments, member status and reset requests.",
    defaultOn: ADMIN,
  },
  "gateway_limits.manage": {
    area: "gateway",
    label: "Manage usage limits",
    description: "Change usage limit policies and assignments, and approve or deny reset requests.",
    defaultOn: ADMIN,
  },

  // Connections
  "connections.view": {
    area: "connections",
    label: "View all connections",
    description: "See every connection, its tools, apps and tool policy, not only your own.",
    defaultOn: ADMIN,
  },
  "connections.manage": {
    area: "connections",
    label: "Manage connections",
    description: "Add organization connections, change who can use any connection, set tool policies, connect shared accounts and configure the Slack assistant.",
    defaultOn: ADMIN,
  },
  "connections.update": {
    area: "connections",
    label: "Edit any connection",
    description: "Change any connection's server, sign-in and settings. People can always edit connections they added.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "connections.disconnect": {
    area: "connections",
    label: "Disconnect any connection",
    description: "Sign out every account stored for a connection, keeping the connection itself.",
    defaultOn: ADMIN,
    sensitive: true,
  },
  "connections.delete": {
    area: "connections",
    label: "Remove any connection",
    description: "Delete any connection. People can always remove connections they added.",
    defaultOn: OWNER_ONLY,
    sensitive: true,
  },
  "oauth_clients.view": {
    area: "connections",
    label: "View OAuth apps",
    defaultOn: ADMIN,
  },
  "oauth_clients.manage": {
    area: "connections",
    label: "Manage OAuth apps",
    description: "Bring your own OAuth app for providers such as Google Workspace.",
    defaultOn: ADMIN,
    sensitive: true,
  },

  // Plugins and marketplaces
  "marketplaces.manage": {
    area: "library",
    label: "Create and remove marketplaces",
    defaultOn: ADMIN,
  },
  "plugins.import": {
    area: "library",
    label: "Import plugins from GitHub",
    defaultOn: ADMIN,
  },
  "connectors.manage": {
    area: "library",
    label: "Manage sync sources",
    description: "Connect GitHub accounts and repositories and apply what they discover.",
    defaultOn: ADMIN,
  },

  // Dashboards
  "dashboards.view": {
    area: "dashboards",
    label: "View all dashboards",
    description: "See every dashboard and who it is shared with.",
    defaultOn: ADMIN,
  },
  "dashboards.manage": {
    area: "dashboards",
    label: "Manage dashboards",
    description: "Create, change, delete and share dashboards.",
    defaultOn: ADMIN,
  },
} as const satisfies Record<string, PermissionDefinition>

export type PermissionKey = keyof typeof PERMISSIONS

type PermissionFollowsTargets = {
  [K in PermissionKey]: (typeof PERMISSIONS)[K] extends { follows: infer Target } ? Target : never
}[PermissionKey]

type AssertPermissionKeys<T extends PermissionKey> = T

/** Fails to compile when a `follows` value is not a catalog key. */
export type PermissionFollowsTarget = AssertPermissionKeys<PermissionFollowsTargets>

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value)
}

export const PERMISSION_KEYS: readonly PermissionKey[] = Object.keys(PERMISSIONS).filter(isPermissionKey)

export function getPermissionDefinition(key: PermissionKey): PermissionDefinition {
  return PERMISSIONS[key]
}

export function permissionDefaultKeys(set: PermissionDefaultSetKey): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => getPermissionDefinition(key).defaultOn.includes(set))
}

export function isPermissionLockedOn(key: PermissionKey, set: PermissionDefaultSetKey): boolean {
  if (set !== "admin") return false
  return getPermissionDefinition(key).lockedOn?.includes(set) ?? false
}

/** No default set includes it: only the owner holds it until someone grants it with Permissions on. */
export function isPermissionOwnerOnlyByDefault(key: PermissionKey): boolean {
  return getPermissionDefinition(key).defaultOn.length === 0
}

export function isPermissionSensitive(key: PermissionKey): boolean {
  return getPermissionDefinition(key).sensitive === true
}

export const PERMISSION_KEY_PATTERN = /^[a-z_]+\.[a-z_]+$/

/** Catalog invariants. Returns human-readable problems; empty means valid. */
export function permissionCatalogProblems(): string[] {
  const problems: string[] = []
  for (const key of PERMISSION_KEYS) {
    const definition = getPermissionDefinition(key)
    if (!PERMISSION_KEY_PATTERN.test(key)) problems.push(`${key}: key must match ${PERMISSION_KEY_PATTERN}`)
    if (!Object.prototype.hasOwnProperty.call(PERMISSION_AREAS, definition.area)) problems.push(`${key}: unknown area ${definition.area}`)
    if (definition.label.trim().length === 0) problems.push(`${key}: label is empty`)
    if (definition.follows !== undefined) {
      if (!isPermissionKey(definition.follows)) problems.push(`${key}: follows unknown key ${definition.follows}`)
      else if (definition.follows === key) problems.push(`${key}: follows itself`)
    }
    for (const set of definition.lockedOn ?? []) {
      if (!definition.defaultOn.includes(set)) problems.push(`${key}: locked on ${set} but not default on ${set}`)
    }
  }
  return problems
}

export const permissionKeySchema = z.enum(PERMISSION_KEYS)
export const permissionDefaultSetKeySchema = z.enum(PERMISSION_DEFAULT_SET_KEYS)
