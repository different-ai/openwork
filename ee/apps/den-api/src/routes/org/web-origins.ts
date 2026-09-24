import {
  ORGANIZATION_WEB_ORIGIN_LIMIT,
  normalizeExactHttpsOrigin,
  organizationWebOriginInputSchema,
  organizationWebOriginListSchema,
  organizationWebOriginSchema,
} from "@openwork/types/den/organization-web-origins"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { jsonValidator, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import {
  approveOrganizationWebOrigin,
  listOrganizationWebOrigins,
  removeOrganizationWebOrigin,
  type OrganizationWebOriginRecord,
} from "../../organization-web-origins.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole, ensureOrganizationSuperAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"

const INVALID_WEB_ORIGIN_MESSAGE = "Enter an exact HTTPS origin like https://workspace.example.com, with an optional port and no path."
const WEB_ORIGIN_ALREADY_APPROVED_MESSAGE = "This origin is already approved."
const WEB_ORIGIN_LIMIT_REACHED_MESSAGE = `This organization already has ${ORGANIZATION_WEB_ORIGIN_LIMIT} approved web origins. Remove one before adding another.`
const WEB_ORIGIN_NOT_FOUND_MESSAGE = "This approved origin no longer exists."

// OpenAPI-only view of the shared contract: den-web parses responses with the
// shared schema, so the `date-time` format is declared here instead of there.
const organizationWebOriginDocumentSchema = organizationWebOriginSchema.extend({
  createdAt: z.string().datetime(),
}).meta({ ref: "OrganizationWebOrigin" })

const organizationWebOriginListDocumentSchema = organizationWebOriginListSchema.extend({
  origins: z.array(organizationWebOriginDocumentSchema).max(ORGANIZATION_WEB_ORIGIN_LIMIT),
}).meta({ ref: "OrganizationWebOriginList" })

const organizationWebOriginInputDocumentSchema = organizationWebOriginInputSchema.meta({ ref: "OrganizationWebOriginApproveBody" })

const invalidWebOriginSchema = z.object({
  error: z.literal("invalid_web_origin"),
  message: z.string(),
}).meta({ ref: "InvalidWebOriginError" })

const approveWebOriginBadRequestSchema = z.union([
  invalidRequestSchema,
  invalidWebOriginSchema,
]).meta({ ref: "ApproveWebOriginBadRequest" })

const webOriginAlreadyApprovedSchema = z.object({
  error: z.literal("web_origin_already_approved"),
  message: z.string(),
}).meta({ ref: "WebOriginAlreadyApprovedError" })

const webOriginLimitReachedSchema = z.object({
  error: z.literal("web_origin_limit_reached"),
  message: z.string(),
}).meta({ ref: "WebOriginLimitReachedError" })

const approveWebOriginConflictSchema = z.union([
  webOriginAlreadyApprovedSchema,
  webOriginLimitReachedSchema,
]).meta({ ref: "ApproveWebOriginConflict" })

const webOriginNotFoundSchema = z.object({
  error: z.literal("web_origin_not_found"),
  message: z.string(),
}).meta({ ref: "WebOriginNotFoundError" })

const organizationNotFoundSchema = z.object({
  error: z.literal("organization_not_found"),
}).meta({ ref: "WebOriginOrganizationNotFoundError" })

const removeWebOriginNotFoundSchema = z.union([
  webOriginNotFoundSchema,
  organizationNotFoundSchema,
]).meta({ ref: "RemoveWebOriginNotFound" })

const webOriginParamsSchema = idParamSchema("webOriginId", "organizationWebOrigin")

function serializeWebOrigin(record: OrganizationWebOriginRecord) {
  return {
    id: record.id,
    origin: record.origin,
    createdAt: record.createdAt.toISOString(),
    createdByName: record.createdByName,
  }
}

export function registerOrgWebOriginRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/web-origins",
    describeRoute({
      tags: ["Organizations"],
      summary: "List approved web origins",
      description: "Lists the exact HTTPS origins this organization approved for web sign-in handoff and browser access to the Den API.",
      responses: {
        200: jsonResponse("Approved web origins returned successfully.", organizationWebOriginListDocumentSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can view approved web origins.", forbiddenSchema),
        404: jsonResponse("The organization was not found.", organizationNotFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const permission = ensureOrganizationAdminRole(c, "Only workspace owners and admins can view approved web origins.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))

      const payload = c.get("organizationContext")
      const origins = await listOrganizationWebOrigins(payload.organization.id)
      return c.json({
        origins: origins.map(serializeWebOrigin),
        limit: ORGANIZATION_WEB_ORIGIN_LIMIT,
      })
    },
  )

  app.post(
    "/v1/org/web-origins",
    describeRoute({
      tags: ["Organizations"],
      summary: "Approve a web origin",
      description: "Approves one exact HTTPS origin (scheme, host, and optional port) for this organization. Approved origins can receive web sign-in handoffs for this organization and make credentialed browser requests to the Den API.",
      responses: {
        201: jsonResponse("The web origin was approved.", organizationWebOriginDocumentSchema),
        400: jsonResponse("The origin was not an exact HTTPS origin.", approveWebOriginBadRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and super-admins with a recent sign-in can approve web origins.", forbiddenSchema),
        404: jsonResponse("The organization was not found.", organizationNotFoundSchema),
        409: jsonResponse("The origin is already approved or the organization reached its approved origin limit.", approveWebOriginConflictSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    jsonValidator(organizationWebOriginInputDocumentSchema),
    async (c) => {
      const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can approve web origins.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))

      const payload = c.get("organizationContext")
      const origin = normalizeExactHttpsOrigin(c.req.valid("json").origin)
      if (!origin) {
        return c.json({ error: "invalid_web_origin" as const, message: INVALID_WEB_ORIGIN_MESSAGE }, 400)
      }

      const result = await approveOrganizationWebOrigin({
        organizationId: payload.organization.id,
        origin,
        createdByOrgMemberId: payload.currentMember.id,
      })
      if (!result.ok) {
        return result.reason === "already_approved"
          ? c.json({ error: "web_origin_already_approved" as const, message: WEB_ORIGIN_ALREADY_APPROVED_MESSAGE }, 409)
          : c.json({ error: "web_origin_limit_reached" as const, message: WEB_ORIGIN_LIMIT_REACHED_MESSAGE }, 409)
      }

      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.webOriginApproved,
        payload: { origin },
      })
      return c.json(serializeWebOrigin(result.webOrigin), 201)
    },
  )

  app.delete(
    "/v1/org/web-origins/:webOriginId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Remove an approved web origin",
      description: "Removes one approved web origin from this organization. New web sign-in handoffs stop immediately; browser access stops within about 30 seconds on every Den API replica.",
      responses: {
        204: emptyResponse("The approved web origin was removed."),
        400: jsonResponse("The web origin id was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and super-admins with a recent sign-in can remove approved web origins.", forbiddenSchema),
        404: jsonResponse("The approved web origin or organization was not found.", removeWebOriginNotFoundSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    paramValidator(webOriginParamsSchema),
    async (c) => {
      const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can remove approved web origins.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))

      const payload = c.get("organizationContext")
      const removedOrigin = await removeOrganizationWebOrigin({
        organizationId: payload.organization.id,
        id: normalizeDenTypeId("organizationWebOrigin", c.req.valid("param").webOriginId),
      })
      if (!removedOrigin) {
        return c.json({ error: "web_origin_not_found" as const, message: WEB_ORIGIN_NOT_FOUND_MESSAGE }, 404)
      }

      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.webOriginRemoved,
        payload: { origin: removedOrigin },
      })
      return c.body(null, 204)
    },
  )
}
