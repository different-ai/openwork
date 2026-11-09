/**
 * Config blobs (feature `configBlobs`): export the organization's
 * configuration as JSON and import it back through change requests.
 * Design: docs/features/config-blobs/change-requests.md (API table).
 *
 * Every route: orgMemberRoute() → requireFeature("configBlobs") (404 when
 * off) → requireConfigScope(…) (UI sessions pass; API keys only as config
 * tokens holding the scope). Member permissions are the areas' own view /
 * manage keys, checked per request by the service (sensitive keys also need a
 * recent sign-in, exactly as in the dashboard).
 */
import {
  CONFIG_BLOB_MAX_BYTES,
  CONFIG_CHANGE_REQUEST_SOURCES,
  CONFIG_CHANGE_REQUEST_STATUSES,
  CONFIG_IMPORT_MODES,
  CONFIG_PLAN_OPS,
  approveConfigChangeRequestSchema,
  configAreaKeySchema,
  configBlobSettingsPatchSchema,
  configDecisionsSchema,
  configDeploymentSchema,
  configSecretInputsSchema,
  createConfigChangeRequestSchema,
} from "@openwork/types/den/config-blobs"
import type { PermissionKey } from "@openwork/types/den/permissions"
import type { Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import type { DenApiKeySession } from "../../api-keys.js"
import {
  ConfigBlobError,
  approveChangeRequest,
  cancelChangeRequest,
  describeAreas,
  dryRunChangeRequest,
  exportBlob,
  getBeforeSnapshot,
  getChangeRequestDetail,
  getChangeRequestPlan,
  getConfigBlobSettings,
  listChangeRequestSummaries,
  parseAreaList,
  requestApply,
  revertChangeRequest,
  submitChangeRequest,
  updateConfigBlobSettings,
  updateDecisions,
  updateInputs,
  type ConfigCaller,
  type ConfigOrganization,
} from "../../config-blobs/service.js"
import { configBlobJsonSchema } from "../../config-blobs/json-schema.js"
import { allowConfigTokenSecrets, apiKeyHasConfigScope, getConfigTokenAreas, requireConfigScope } from "../../config-blobs/token.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, publicRoute, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { refuseMachineSecrets } from "../../middleware/refuse-machine-secrets.js"
import { checkFreshPrivilegedSession, organizationPrivilegedSessionMaxAgeMs } from "../../privileged-session.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import {
  idParamSchema,
  memberPermissionsForRequest,
  orgAccessFailureStatus,
  permissionFailureHeaders,
  requirePermission,
  type OrgRouteVariables,
  type PermissionRouteContext,
} from "./shared.js"

const BASE = "/v1/config-blobs"
const TAGS = ["Config blobs"]

// ---------------------------------------------------------------------------
// OpenAPI shapes (the TypeScript contract is @openwork/types/den/config-blobs)

const errorSchema = z.object({ error: z.string(), message: z.string().optional() }).passthrough().meta({ ref: "ConfigBlobError" })
const featureDisabledSchema = z.object({ error: z.string(), feature: z.string().optional() }).meta({ ref: "ConfigBlobNotFound" })

const planSummarySchema = z.object(Object.fromEntries([...CONFIG_PLAN_OPS, "blocking"].map((key) => [key, z.number().int()]))).meta({ ref: "ConfigPlanSummary" })

const changeRequestSchema = z.object({
  id: z.string(),
  status: z.enum(CONFIG_CHANGE_REQUEST_STATUSES),
  title: z.string().nullable(),
  mode: z.enum(CONFIG_IMPORT_MODES),
  source: z.enum(CONFIG_CHANGE_REQUEST_SOURCES),
  sourceOrganization: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
  sourceDeployment: configDeploymentSchema.nullable(),
  areas: z.array(configAreaKeySchema),
  summary: planSummarySchema.nullable(),
  planHash: z.string().nullable(),
  approvals: z.array(z.object({ memberId: z.string(), name: z.string().nullable(), at: z.string().datetime() })),
  autoApply: z.boolean(),
  createdBy: z.object({ memberId: z.string().nullable(), name: z.string().nullable(), apiKeyName: z.string().nullable() }),
  revertsChangeRequestId: z.string().nullable(),
  revertedByChangeRequestId: z.string().nullable(),
  errors: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable(),
}).meta({ ref: "ConfigChangeRequest" })

const planSchema = z.object({
  planHash: z.string(),
  mode: z.enum(CONFIG_IMPORT_MODES),
  summary: planSummarySchema,
  areas: z.array(z.object({ area: configAreaKeySchema, label: z.string(), items: z.array(z.record(z.string(), z.unknown())) })),
  issues: z.array(z.object({ level: z.enum(["error", "warning", "info"]), message: z.string(), area: configAreaKeySchema.optional() })),
}).meta({ ref: "ConfigPlan" })

const reportSchema = z.object({
  items: z.array(z.object({
    area: configAreaKeySchema, ref: z.string(), op: z.enum(CONFIG_PLAN_OPS), localId: z.string().nullable(),
    status: z.enum(["applied", "failed", "skipped"]), warnings: z.array(z.string()), error: z.string().optional(),
  })),
  warnings: z.array(z.string()),
  afterRevs: z.record(z.string(), z.string()).optional(),
}).meta({ ref: "ConfigApplyReport" })

const blobSchema = z.object({
  $schema: z.string().optional(),
  format: z.literal("openwork.config-blob"),
  formatVersion: z.literal(1),
  exportedAt: z.string().datetime().optional(),
  source: z.object({
    deployment: configDeploymentSchema,
    instanceId: z.string(),
    appVersion: z.string(),
    organization: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  }).optional(),
  scope: z.array(configAreaKeySchema),
  baseHash: z.string().optional(),
  areas: z.record(z.string(), z.unknown()),
  secrets: z.array(z.object({ path: z.string(), area: configAreaKeySchema, itemId: z.string().optional(), itemName: z.string(), field: z.string(), set: z.boolean() })).optional(),
  omitted: z.array(z.object({ area: configAreaKeySchema, reason: z.string() })).optional(),
}).meta({ ref: "ConfigBlob" })

const areasResponseSchema = z.object({
  areas: z.array(z.object({
    key: configAreaKeySchema,
    label: z.string(),
    path: z.array(z.string()),
    specVersion: z.number().int(),
    supported: z.boolean(),
    unsupportedReason: z.string().optional(),
    canExport: z.boolean(),
    canImport: z.boolean(),
    containsConfidentialContent: z.boolean(),
    secretFields: z.array(z.string()),
  })),
  deployment: configDeploymentSchema,
  allowEnvSecrets: z.boolean(),
}).meta({ ref: "ConfigAreasResponse" })

const changeRequestResponseSchema = z.object({ changeRequest: changeRequestSchema }).meta({ ref: "ConfigChangeRequestResponse" })
const changeRequestListSchema = z.object({ changeRequests: z.array(changeRequestSchema) }).meta({ ref: "ConfigChangeRequestListResponse" })
const changeRequestDetailSchema = z.object({ changeRequest: changeRequestSchema, report: reportSchema.nullable() }).meta({ ref: "ConfigChangeRequestDetailResponse" })
const planResponseSchema = z.object({ plan: planSchema.nullable(), decisions: configDecisionsSchema }).meta({ ref: "ConfigChangeRequestPlanResponse" })
const planUpdateResponseSchema = z.object({ changeRequest: changeRequestSchema, plan: planSchema.nullable() }).meta({ ref: "ConfigChangeRequestPlanUpdateResponse" })
const dryRunResponseSchema = z.object({
  dryRun: z.literal(true),
  plan: planSchema.nullable(),
  errors: z.array(z.string()),
}).meta({ ref: "ConfigChangeRequestDryRunResponse" })
const jsonSchemaDocumentSchema = z.record(z.string(), z.unknown()).meta({ ref: "ConfigBlobJsonSchema" })
const settingsResponseSchema = z.object({ settings: z.object({ requireSecondApprover: z.boolean() }) }).meta({ ref: "ConfigBlobSettingsResponse" })

const changeRequestParams = idParamSchema("changeRequestId", "configChangeRequest")
const listQuerySchema = z.object({ state: z.enum(["open", "closed"]).default("open") })
const submitQuerySchema = z.object({ dryRun: z.enum(["true", "false"]).optional() })
const schemaParamsSchema = z.object({ formatVersion: z.string().max(10) })
const exportQuerySchema = z.object({ areas: z.string().max(2000).optional() })
const applyBodySchema = z.object({ planHash: z.string().optional() }).strict()

const commonErrors = {
  401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
  403: jsonResponse("The caller lacks the area's permission, or the config token lacks the scope.", forbiddenSchema),
  404: jsonResponse("The change request was not found, or config import and export is off for this organization.", featureDisabledSchema),
}

function describe(summary: string, description: string, ok: { status: 200 | 201 | 202; schema: z.ZodType; description: string }, extra: Record<number, ReturnType<typeof jsonResponse>> = {}) {
  return describeRoute({
    tags: TAGS,
    summary,
    description,
    responses: { [ok.status]: jsonResponse(ok.description, ok.schema), ...commonErrors, ...extra },
  })
}

// ---------------------------------------------------------------------------
// Caller

type ConfigTokenVariables = { Variables: Partial<AuthContextVariables> }

/** Any config scope (the area list is useful to every config token). Standard API keys: 403. */
const requireAnyConfigScope: MiddlewareHandler<ConfigTokenVariables> = async (c, next) => {
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  if (!apiKey) return next()
  if (apiKeyHasConfigScope(apiKey, "config:export") || apiKeyHasConfigScope(apiKey, "config:submit") || apiKeyHasConfigScope(apiKey, "config:apply")) return next()
  return c.json({ error: "config_scope_required", scope: "config:export" }, 403)
}

/** Settings are changed in the dashboard only: no API key may turn the second-approver rule off. */
const refuseApiKeys: MiddlewareHandler<ConfigTokenVariables> = async (c, next) => {
  if (c.get("apiKey")) return c.json({ error: "forbidden", message: "Config settings can only be changed by a signed-in person." }, 403)
  return next()
}

async function configCaller(c: PermissionRouteContext, tokenAreas: string[] | null): Promise<{ org: ConfigOrganization; caller: ConfigCaller }> {
  const payload = c.get("organizationContext")
  const permissions = await memberPermissionsForRequest(c)
  if (!payload || !permissions) throw new ConfigBlobError(404, { error: "organization_not_found" })
  const apiKey = c.get("apiKey")
  return {
    org: { id: payload.organization.id, slug: payload.organization.slug, name: payload.organization.name, features: payload.features },
    caller: {
      userId: payload.currentMember.userId,
      memberId: payload.currentMember.id,
      apiKeyId: apiKey?.id ?? null,
      can: (key) => permissions.has(key),
      tokenAreas,
      authorize: async (keys: readonly PermissionKey[]) => {
        for (const key of keys) {
          const check = await requirePermission(c, key)
          if (!check.ok) throw new ConfigBlobError(orgAccessFailureStatus(check.response), check.response, permissionFailureHeaders(check.response))
        }
      },
      requireApprovalStepUp: () => requireApprovalStepUp(c),
    },
  }
}

/**
 * Approving and applying: a config token (D3: no session to step up), or a
 * person who signed in recently (the organization's "Enforce fresh admin
 * sessions" window, whatever the areas' permissions). Never an agent: the MCP
 * re-entry session is synthesized at request time, so it would always look fresh.
 */
function requireApprovalStepUp(c: PermissionRouteContext): void {
  if (c.get("apiKey")) return
  const session = c.get("session")
  if (!session || session.id === MCP_INTERNAL_SESSION_ID) {
    throw new ConfigBlobError(403, { error: "forbidden", message: "Config changes are approved by a signed-in person or a config token." })
  }
  const fresh = checkFreshPrivilegedSession({ apiKey: null, session }, organizationPrivilegedSessionMaxAgeMs(c.get("organizationContext")))
  if (!fresh.ok) throw new ConfigBlobError(403, fresh.response)
}

const MCP_INTERNAL_SESSION_ID = "mcp_internal"

/** Sends a service refusal; anything else is a real error for the app's handler. */
function refusal(error: unknown): Response {
  if (error instanceof ConfigBlobError) {
    return new Response(JSON.stringify(error.body), { status: error.status, headers: { "Content-Type": "application/json", ...error.headers } })
  }
  throw error
}

function attachment(body: unknown, fileName: string): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
      "Cache-Control": "no-store",
    },
  })
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Routes

export function registerOrgConfigBlobRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const feature = requireFeature("configBlobs")

  // Public and not behind the per-organization flag: the format is the same for everyone, and editors and CI fetch it without credentials.
  app.get(
    `${BASE}/schema/:formatVersion`,
    describeRoute({
      tags: TAGS,
      security: [],
      summary: "Get the config blob JSON Schema",
      description: "The JSON Schema (draft 2020-12) of a config blob in this format version: the envelope and every area's item spec. Exports point their `$schema` here. Public, no authentication.",
      responses: {
        200: jsonResponse("The JSON Schema.", jsonSchemaDocumentSchema),
        404: jsonResponse("Unknown format version.", errorSchema),
      },
    }),
    publicRoute,
    paramValidator(schemaParamsSchema),
    (c) => {
      const version = c.req.valid("param").formatVersion
      const schema = /^\d+$/.test(version) ? configBlobJsonSchema(Number(version)) : null
      if (!schema) return c.json({ error: "unknown_format_version", message: `No config blob format version ${version} on this server.` }, 404)
      c.header("Cache-Control", "public, max-age=3600")
      return c.json(schema)
    },
  )

  app.get(
    `${BASE}/areas`,
    describe("List config areas", "The config areas of this server: label, sidebar path, spec version, whether each is supported here, and whether the caller may export or import it.", { status: 200, schema: areasResponseSchema, description: "Config areas returned." }),
    orgMemberRoute(),
    feature,
    requireAnyConfigScope,
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json(describeAreas(org, caller))
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/export`,
    describe("Export configuration", "Downloads the organization's configuration as a config blob (JSON attachment): every area, or the comma-separated `areas`. Areas the caller can't view are left out and listed in `omitted`. Secrets are never exported; they appear as `$secret` placeholders.", { status: 200, schema: blobSchema, description: "The config blob." }, { 400: jsonResponse("Unknown area.", errorSchema) }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:export"),
    queryValidator(exportQuerySchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        const blob = await exportBlob(org, caller, parseAreaList(c.req.valid("query").areas))
        return attachment(blob, `openwork-config-${org.slug}-${today()}.json`)
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.post(
    `${BASE}/change-requests`,
    describe("Upload a config change request", "Uploads a config blob as a change request. It is analyzed in the background: poll the request until it is `needs_review`, then read its plan. With `?dryRun=true` the blob is analyzed at once and nothing is stored (no change request, nothing superseded): the response is `200 { dryRun, plan, errors }`, for CI checks. `errors` are what would make the request `invalid`; `plan.summary.blocking` counts items that would need a decision.", { status: 202, schema: changeRequestResponseSchema, description: "Stored; analysis is queued." }, {
      200: jsonResponse("Dry run: the plan the upload would produce. Nothing was stored.", dryRunResponseSchema),
      400: jsonResponse("Not a valid config blob.", errorSchema),
      413: jsonResponse("The blob is larger than the limit.", errorSchema),
    }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    queryValidator(submitQuerySchema),
    bodyLimit({ maxSize: CONFIG_BLOB_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: "blob_too_large", message: `Config files are limited to ${CONFIG_BLOB_MAX_BYTES / (1024 * 1024)} MB.` }, 413) }),
    jsonValidator(createConfigChangeRequestSchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        const body = c.req.valid("json")
        if (c.req.valid("query").dryRun === "true") {
          return c.json({ dryRun: true, ...await dryRunChangeRequest(org, caller, { blob: body.blob, mode: body.mode }) }, 200)
        }
        const changeRequest = await submitChangeRequest(org, caller, { blob: body.blob, mode: body.mode, autoApply: body.autoApply, ...(body.title ? { title: body.title } : {}) })
        return c.json({ changeRequest }, 202)
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/change-requests`,
    describe("List config change requests", "Open (`state=open`, default) or closed change requests whose areas the caller can view, newest first.", { status: 200, schema: changeRequestListSchema, description: "Change requests returned." }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    queryValidator(listQuerySchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json({ changeRequests: await listChangeRequestSummaries(org.id, caller, c.req.valid("query").state) })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/change-requests/:changeRequestId`,
    describe("Get a config change request", "Status, summary, approvals and, once applied, the apply report.", { status: 200, schema: changeRequestDetailSchema, description: "The change request." }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    paramValidator(changeRequestParams),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json(await getChangeRequestDetail(org.id, c.req.valid("param").changeRequestId, caller))
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/change-requests/:changeRequestId/plan`,
    describe("Get a config change request's plan", "The full plan (matches, field diffs, references, secret decisions, blocking flags) and the saved decisions. Never secret values.", { status: 200, schema: planResponseSchema, description: "The plan." }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    paramValidator(changeRequestParams),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json(await getChangeRequestPlan(org.id, c.req.valid("param").changeRequestId, caller))
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/change-requests/:changeRequestId/before-snapshot`,
    describe("Download a change request's before-snapshot", "The configuration of the request's areas as it was just before it was applied (JSON attachment): the source of a revert.", { status: 200, schema: blobSchema, description: "The before-snapshot blob." }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:export"),
    paramValidator(changeRequestParams),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        const id = c.req.valid("param").changeRequestId
        return attachment(await getBeforeSnapshot(org.id, id, caller), `openwork-config-${org.slug}-before-${id}.json`)
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.put(
    `${BASE}/change-requests/:changeRequestId/decisions`,
    describe("Save config change decisions", "Replaces the request's decisions (matches, references, deletes, overrides, skips, renames, invitation emails) and re-plans at once. A different plan hash drops approvals.", { status: 200, schema: planUpdateResponseSchema, description: "Decisions saved; the new plan." }, {
      400: jsonResponse("Invalid decisions.", invalidRequestSchema),
      409: jsonResponse("The request can't be edited now.", errorSchema),
    }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    paramValidator(changeRequestParams),
    jsonValidator(configDecisionsSchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json(await updateDecisions(org.id, c.req.valid("param").changeRequestId, caller, c.req.valid("json")))
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.put(
    `${BASE}/change-requests/:changeRequestId/inputs`,
    describe("Save config change secret inputs", "Sets secret decisions by placeholder path: keep, unset, an environment variable (self-hosted, operator allowlist) or a value. Values are write-only: stored encrypted on the request, used once at apply and deleted. Entering a value drops approvals. API keys may send values only as config tokens with config:submit.", { status: 200, schema: planUpdateResponseSchema, description: "Inputs saved; the new plan." }, {
      400: jsonResponse("Unknown placeholder or a decision this server refuses.", errorSchema),
      409: jsonResponse("The request can't be edited now.", errorSchema),
    }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    refuseMachineSecrets(["inputs"], { allowApiKeys: allowConfigTokenSecrets }),
    paramValidator(changeRequestParams),
    jsonValidator(configSecretInputsSchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json(await updateInputs(org.id, c.req.valid("param").changeRequestId, caller, c.req.valid("json").inputs))
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.post(
    `${BASE}/change-requests/:changeRequestId/approve`,
    describe("Approve a config change request", "Approves the plan with this `planHash`. Refused while blocking flags remain or when the plan changed. With auto-apply on, a fully approved request is queued at once.", { status: 200, schema: changeRequestResponseSchema, description: "Approved." }, {
      400: jsonResponse("Invalid body.", invalidRequestSchema),
      409: jsonResponse("Plan changed, blocked, or already approved by the caller.", errorSchema),
    }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:apply"),
    paramValidator(changeRequestParams),
    jsonValidator(approveConfigChangeRequestSchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json({ changeRequest: await approveChangeRequest(org.id, c.req.valid("param").changeRequestId, caller, c.req.valid("json").planHash) })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.post(
    `${BASE}/change-requests/:changeRequestId/apply`,
    describe("Apply a config change request", "Queues an approved request for the organization's apply queue. With `planHash`, a request in review is approved and queued in one call.", { status: 200, schema: changeRequestResponseSchema, description: "Queued." }, {
      400: jsonResponse("Invalid body.", invalidRequestSchema),
      409: jsonResponse("Not approved, or the plan changed.", errorSchema),
    }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:apply"),
    paramValidator(changeRequestParams),
    jsonValidator(applyBodySchema),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json({ changeRequest: await requestApply(org.id, c.req.valid("param").changeRequestId, caller, c.req.valid("json").planHash) })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.post(
    `${BASE}/change-requests/:changeRequestId/cancel`,
    describe("Cancel a config change request", "Withdraws an open request (not while it is being applied) and deletes its secret inputs. Its creator, or anyone who may import its areas.", { status: 200, schema: changeRequestResponseSchema, description: "Cancelled." }, { 409: jsonResponse("Already closed or being applied.", errorSchema) }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:submit"),
    paramValidator(changeRequestParams),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json({ changeRequest: await cancelChangeRequest(org.id, c.req.valid("param").changeRequestId, caller) })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.post(
    `${BASE}/change-requests/:changeRequestId/revert`,
    describe("Revert a config change request", "Creates a new change request (source `revert`) from the applied request's before-snapshot, in mirror mode with the deletes of the items it created already ticked. It is reviewed and applied like any other.", { status: 201, schema: changeRequestResponseSchema, description: "The revert change request." }, { 409: jsonResponse("Not applied, or a revert is already open.", errorSchema) }),
    orgMemberRoute(),
    feature,
    requireConfigScope("config:apply"),
    paramValidator(changeRequestParams),
    async (c) => {
      try {
        const { org, caller } = await configCaller(c, getConfigTokenAreas(c))
        return c.json({ changeRequest: await revertChangeRequest(org, c.req.valid("param").changeRequestId, caller) }, 201)
      } catch (error) {
        return refusal(error)
      }
    },
  )

  app.get(
    `${BASE}/settings`,
    describe("Get config change settings", "Organization settings for config change requests: whether a second approver is required.", { status: 200, schema: settingsResponseSchema, description: "Settings returned." }),
    orgMemberRoute(),
    feature,
    requireAnyConfigScope,
    async (c) => {
      const payload = c.get("organizationContext")
      return c.json({ settings: await getConfigBlobSettings(payload.organization.id) })
    },
  )

  app.patch(
    `${BASE}/settings`,
    describe("Update config change settings", "Turns the second-approver rule on or off. Signed-in people with Edit organization settings only; never an API key.", { status: 200, schema: settingsResponseSchema, description: "Settings saved." }, { 400: jsonResponse("Invalid body.", invalidRequestSchema) }),
    orgMemberRoute(),
    feature,
    refuseApiKeys,
    requireOrgPermission("organization.update"),
    jsonValidator(configBlobSettingsPatchSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      return c.json({ settings: await updateConfigBlobSettings(payload.organization.id, c.req.valid("json")) })
    },
  )
}
