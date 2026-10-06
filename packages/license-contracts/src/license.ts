import { z } from "zod"
import { isModuleId, type ModuleId } from "./module-ids"
import { MODULE_DEFINITIONS } from "./modules"

export const LICENSE_CHECK_PATH = "/v1/licenses/check"
export const LICENSE_CACHE_TTL_SECONDS = 300
export const LICENSE_VERIFICATION_GRACE_MS = 24 * 60 * 60 * 1000
export const LICENSE_TRANSITION_MS = 30 * 24 * 60 * 60 * 1000

// One commercial module, with operation-specific transition behavior.
/** @deprecated Use the `transitionOperations` of `org.auth.sso` in MODULE_DEFINITIONS. Kept for v1 consumers. */
export const AUTH_TRANSITION_POLICY = Object.freeze({
  ssoSignIn: "verified_owner_or_superadmin",
  scim: "continue",
  other: "deny",
})

export const licenseCheckRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseUrl: z.url(),
  organizationId: z.string().optional(),
  currentUsers: z.number().int().nonnegative(),
})

const timestamp = z.iso.datetime({ offset: true })

export const licenseCheckResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  licenseId: z.string(),
  status: z.enum(["active", "expired", "suspended", "revoked"]),
  modules: z.strictObject({ auth: z.boolean() }),
  featureFlags: z.record(z.string(), z.boolean()),
  maxUsers: z.number().int().nonnegative(),
  expiresAt: timestamp.nullable(),
  invalidatedAt: timestamp.nullable(),
  checkedAt: timestamp,
  cacheTtlSeconds: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if ((value.status === "suspended" || value.status === "revoked") && value.invalidatedAt === null) {
    ctx.addIssue({ code: "custom", path: ["invalidatedAt"], message: "Invalid licenses require their effective invalidation timestamp" })
  }
  if (value.status === "expired" && value.expiresAt === null) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expired licenses require their expiry timestamp" })
  }
})

export type LicenseCheckRequest = z.infer<typeof licenseCheckRequestSchema>
export type LicenseCheckResponse = z.infer<typeof licenseCheckResponseSchema>

// ---------------------------------------------------------------------------
// Everything above is the v1 contract, byte-identical to the vendored preview
// (plus the imports and the @deprecated note). Do not rename or change it: the private license
// server imports these names. Everything below is the v2 (modules) contract.
// ---------------------------------------------------------------------------

export const LICENSE_CHECK_BATCH_PATH = "/v1/licenses/check-batch"
export const ENTITLEMENT_INVALIDATION_PATH = "/internal/entitlements/invalidate"
export const LICENSE_SCHEMA_VERSIONS = [1, 2] as const
export const LICENSE_SCHEMA_VERSION_CURRENT = 2
/** Den clamps a server-sent `cacheTtlSeconds` to these bounds. */
export const LICENSE_CACHE_TTL_BOUNDS = Object.freeze({ min: 60, max: 3600 })
/** D14: length of the self-hosted trial the license server issues. */
export const LICENSE_TRIAL_DURATION_MS = 5 * 24 * 60 * 60 * 1000

/** v1 names. The unsuffixed exports above are the same schemas. */
export const licenseCheckRequestSchemaV1 = licenseCheckRequestSchema
export const licenseCheckResponseSchemaV1 = licenseCheckResponseSchema
export type LicenseCheckRequestV1 = LicenseCheckRequest
export type LicenseCheckResponseV1 = LicenseCheckResponse

export const licenseStatusSchema = z.enum(["active", "expired", "suspended", "revoked"])
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

/** Trial marker (D22, Q-B9). Orthogonal to `status`, so an expired trial is still a trial. */
export const licenseKindSchema = z.enum(["standard", "trial"])
export type LicenseKind = z.infer<typeof licenseKindSchema>

/** A module key on the wire. Den tolerates (and ignores) keys it doesn't know. */
export const licenseModuleKeySchema = z.string().max(100).regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/)
/** Flat, dotted module map. Unknown or missing keys mean "not entitled". */
export const licenseModulesSchema = z.record(licenseModuleKeySchema, z.boolean())
export const licenseFeatureFlagsSchema = z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), z.boolean())

export const licenseCheckRequestSchemaV2 = z.strictObject({
  schemaVersion: z.literal(2),
  baseUrl: z.url(),
  organizationId: z.string().min(1).max(200).optional(),
  currentUsers: z.number().int().nonnegative(),
  /** Pod name or per-process id. Diagnostics only: never used for binding or summed. */
  instanceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  /** Running OpenWork release. */
  version: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
})
export type LicenseCheckRequestV2 = z.infer<typeof licenseCheckRequestSchemaV2>

export const licenseCheckRequestSchemaAny = z.discriminatedUnion("schemaVersion", [licenseCheckRequestSchemaV1, licenseCheckRequestSchemaV2])
export type LicenseCheckRequestAny = z.infer<typeof licenseCheckRequestSchemaAny>

/** Tolerant: unknown top-level fields (including any `userFlags`) are stripped. */
export const licenseCheckResponseSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  licenseId: z.string(),
  kind: licenseKindSchema,
  status: licenseStatusSchema,
  modules: licenseModulesSchema,
  featureFlags: licenseFeatureFlagsSchema,
  maxUsers: z.number().int().nonnegative(),
  expiresAt: timestamp.nullable(),
  invalidatedAt: timestamp.nullable(),
  checkedAt: timestamp,
  cacheTtlSeconds: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if ((value.status === "suspended" || value.status === "revoked") && value.invalidatedAt === null) {
    ctx.addIssue({ code: "custom", path: ["invalidatedAt"], message: "Invalid licenses require their effective invalidation timestamp" })
  }
  if (value.status === "expired" && value.expiresAt === null) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expired licenses require their expiry timestamp" })
  }
  if (value.kind === "trial" && value.expiresAt === null) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Trial licenses require their expiry timestamp" })
  }
})
export type LicenseCheckResponseV2 = z.infer<typeof licenseCheckResponseSchemaV2>

export const licenseCheckResponseSchemaAny = z.union([licenseCheckResponseSchemaV1, licenseCheckResponseSchemaV2])
export type LicenseCheckResponseAny = z.infer<typeof licenseCheckResponseSchemaAny>

/**
 * Stale v1 hosted capability names carried in `featureFlags`, mapped to module ids.
 * `remoteMcpApps` was retired with `remote_mcp_app` (D36) and is dropped.
 */
export const LEGACY_V1_CAPABILITY_MODULES = Object.freeze({
  installLinks: "org.installLinks",
  mcpConnections: "library.connectors",
  workflows: "library.workflows",
  cloud: "openworkWeb",
  remoteMcpApps: null,
} satisfies Record<string, ModuleId | null>)

const LEGACY_V1_CAPABILITIES: ReadonlyMap<string, ModuleId | null> = new Map(Object.entries(LEGACY_V1_CAPABILITY_MODULES))

/** The modules v1 `auth` covered. `org.auth` itself is a group, never a module (D44). */
export const LEGACY_V1_AUTH_MODULES = Object.freeze(["org.auth.sso", "org.auth.scim"] as const satisfies readonly ModuleId[])

/** v1 `auth` covered SSO and SCIM: it grants both `org.auth.*` modules. */
function authModulesFromV1(auth: boolean): Record<string, boolean> {
  return Object.fromEntries(LEGACY_V1_AUTH_MODULES.map((id) => [id, auth]))
}

/**
 * Upgrades a v1 answer to the v2 shape: `auth` becomes `org.auth.sso` and
 * `org.auth.scim`, legacy capability flags move into `modules`, other
 * flags stay flags, and `kind` is `standard`.
 */
export function upgradeLicenseCheckResponseToV2(response: LicenseCheckResponseV1): LicenseCheckResponseV2 {
  const modules: Record<string, boolean> = authModulesFromV1(response.modules.auth)
  const featureFlags: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(response.featureFlags)) {
    if (!LEGACY_V1_CAPABILITIES.has(key)) {
      featureFlags[key] = value
      continue
    }
    const target = LEGACY_V1_CAPABILITIES.get(key)
    if (target) modules[target] = value
  }
  return {
    schemaVersion: 2,
    licenseId: response.licenseId,
    kind: "standard",
    status: response.status,
    modules,
    featureFlags,
    maxUsers: response.maxUsers,
    expiresAt: response.expiresAt,
    invalidatedAt: response.invalidatedAt,
    checkedAt: response.checkedAt,
    cacheTtlSeconds: response.cacheTtlSeconds,
  }
}

function grantedOnWire(modules: Readonly<Record<string, boolean>>, id: ModuleId): boolean {
  return modules[id] ?? MODULE_DEFINITIONS[id].entitlement === "free"
}

/**
 * Projects a v2 answer for a v1 consumer. `auth` is least privilege (both
 * `org.auth.*` modules), the legacy capability flags are rebuilt from the
 * module map, and `kind` is dropped.
 */
export function projectLicenseResponseToV1(response: LicenseCheckResponseV2): LicenseCheckResponseV1 {
  const featureFlags: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(response.featureFlags)) {
    if (!LEGACY_V1_CAPABILITIES.has(key)) featureFlags[key] = value
  }
  for (const [key, target] of LEGACY_V1_CAPABILITIES) {
    featureFlags[key] = target ? grantedOnWire(response.modules, target) : false
  }
  return {
    schemaVersion: 1,
    licenseId: response.licenseId,
    status: response.status,
    modules: { auth: LEGACY_V1_AUTH_MODULES.every((id) => response.modules[id] === true) },
    featureFlags,
    maxUsers: response.maxUsers,
    expiresAt: response.expiresAt,
    invalidatedAt: response.invalidatedAt,
    checkedAt: response.checkedAt,
    cacheTtlSeconds: response.cacheTtlSeconds,
  }
}

/** A license answer (v1 or v2) normalized for the resolver. */
export interface LicenseEntitlement {
  readonly wireVersion: 1 | 2
  readonly licenseId: string
  readonly status: LicenseStatus
  readonly kind: LicenseKind
  /** `kind === "trial"`: expiry is immediate, never the 30-day transition (D22). */
  readonly isTrial: boolean
  /** Known module ids only; unknown keys are dropped. */
  readonly modules: Readonly<Partial<Record<ModuleId, boolean>>>
  readonly featureFlags: Readonly<Record<string, boolean>>
  readonly maxUsers: number
  readonly expiresAt: string | null
  readonly invalidatedAt: string | null
  readonly checkedAt: string
  readonly cacheTtlSeconds: number
}

/**
 * Normalizes a validated v1 or v2 answer. v1 goes through
 * `upgradeLicenseCheckResponseToV2`. A v2 answer that still carries the v1
 * `auth` key (server not migrated) is read like v1 `auth` for any
 * `org.auth.*` module it doesn't set; `validateLicenseModules` reports the key
 * as `unknown_module` for logging.
 */
export function normalizeLicenseCheckResponse(response: LicenseCheckResponseAny): LicenseEntitlement {
  const wireVersion = response.schemaVersion
  const v2 = response.schemaVersion === 1 ? upgradeLicenseCheckResponseToV2(response) : response
  const wire: Record<string, boolean> = { ...v2.modules }
  const legacyAuth = wireVersion === 2 ? v2.modules.auth : undefined
  if (legacyAuth !== undefined) {
    for (const id of LEGACY_V1_AUTH_MODULES) wire[id] ??= legacyAuth
  }
  const modules: Partial<Record<ModuleId, boolean>> = {}
  for (const [key, value] of Object.entries(wire)) {
    if (isModuleId(key)) modules[key] = value
  }
  return {
    wireVersion,
    licenseId: v2.licenseId,
    status: v2.status,
    kind: v2.kind,
    isTrial: v2.kind === "trial",
    modules,
    featureFlags: { ...v2.featureFlags },
    maxUsers: v2.maxUsers,
    expiresAt: v2.expiresAt,
    invalidatedAt: v2.invalidatedAt,
    checkedAt: v2.checkedAt,
    cacheTtlSeconds: v2.cacheTtlSeconds,
  }
}
