/**
 * Zod-free module id and group lists, so plain Node scripts can read them
 * without this package's dependencies installed. `module-ids.ts` builds the
 * schema and helpers on top of them.
 *
 * Ids are location paths (D44): they mirror where the feature lives in the
 * product, in camelCase segments, at most 4 segments. Every prefix of a module
 * id is either a module or a group.
 */

/**
 * Pure namespaces (D44). Groups are never toggled, never entitled, never a
 * parent and never appear in resolved module states: they are always on.
 */
export const MODULE_GROUPS = [
  "org",
  "org.members",
  "org.auth",
  "org.observability",
  "ai",
  "library",
  "library.connectors.native",
] as const

export type ModuleGroupId = (typeof MODULE_GROUPS)[number]

/**
 * Every module id, in dependency-map §2a tree order. APPEND-ONLY once merged:
 * never remove, rename or reorder an id. Retire one with
 * `stability: "deprecated"` in the registry. `module-ids.snapshot.json` must
 * stay a prefix of this list.
 */
export const MODULE_IDS = [
  "org.members.teams",
  "org.members.roles",
  "org.auth.sso",
  "org.auth.scim",
  "org.observability.auditLogs",
  "org.observability.auditLogs.export",
  "org.desktopPolicies",
  "org.desktopPolicies.versionPinning",
  "org.installLinks",
  "org.branding",
  "org.webOrigins",
  "org.diagnostics",
  "org.billing",
  "ai.gateway",
  "ai.gateway.usageLimits",
  "ai.gateway.openworkModels",
  "ai.gateway.openworkModels.analytics",
  "ai.gateway.freeInference",
  "ai.customProviders",
  "library.plugins",
  "library.plugins.githubSync",
  "library.workflows",
  "library.apps",
  "library.connectors",
  "library.connectors.native.googleWorkspace",
  "library.connectors.native.microsoft365",
  "library.connectors.slackAssistant",
  "library.connectors.slackAssistant.headless",
  "dashboards",
  "automations",
  "automations.headless",
  "automations.remoteSessions",
  "openworkWeb",
  "workbot",
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

/** D44: ids have at most this many dot-separated segments. */
export const MODULE_ID_MAX_SEGMENTS = 4
