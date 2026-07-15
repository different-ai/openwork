import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { checkEntitlement } from "../../entitlements.js"
import { env } from "../../env.js"
import { authenticatedRoute, jsonValidator, orgMemberRoute, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import {
  admitOrganizationMember,
  ensureOrganizationAdmissionPolicy,
  evaluateOrganizationAdmission,
  OrganizationAdmissionConflictError,
  OrganizationAdmissionPolicyValidationError,
  updateOrganizationAdmissionPolicy,
} from "../../organization-admission.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"
import { setSessionActiveOrganization } from "../../orgs.js"

const admissionMethodSchema = z.enum(["self_join", "invitation", "sso_jit", "scim"])
const emailDomainRuleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("any") }),
  z.object({ mode: z.literal("allowlist"), domains: z.array(z.string().trim().min(1).max(255)).min(1).max(100) }),
])
const admissionPolicyInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  admissionMethods: z.array(admissionMethodSchema).min(1).max(4),
  emailDomainRule: emailDomainRuleSchema,
  authenticationRequirement: z.enum(["any", "organization_sso"]),
  lifecycleAuthority: z.enum(["local", "scim"]),
})
const admissionAttemptSchema = z.object({
  invitationToken: z.string().trim().min(16).max(512).optional(),
})
const admissionSlugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(255),
})

async function organizationBySlug(slug: string) {
  const rows = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, slug))
    .limit(1)
  return rows[0] ?? null
}

async function requestAssurance(sessionId: string | null | undefined) {
  if (!sessionId) return null
  let id
  try {
    id = normalizeDenTypeId("session", sessionId)
  } catch {
    return null
  }
  const rows = await db
    .select({
      providerId: AuthSessionTable.authenticationProviderId,
      organizationId: AuthSessionTable.authenticationOrganizationId,
    })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.id, id))
    .limit(1)
  return rows[0] ?? null
}

function decisionStatus(decision: Awaited<ReturnType<typeof evaluateOrganizationAdmission>>) {
  return decision.decision === "deny" && decision.reason === "seat_limit_reached" ? 402 : 403
}

export function registerOrgAdmissionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/admission-policy",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get organization admission policy",
      responses: { 200: { description: "Organization admission policy." } },
    }),
    orgMemberRoute(),
    async (c) => {
      const context = c.get("organizationContext")
      const policy = await ensureOrganizationAdmissionPolicy(context.organization.id)
      if (!policy) return c.json({ error: "policy_unavailable" }, 404)
      return c.json({ policy, enforcementMode: env.organizationAdmissionEnforcement })
    },
  )

  app.put(
    "/v1/org/admission-policy",
    describeRoute({
      tags: ["Organizations"],
      summary: "Update organization admission policy",
      responses: {
        200: { description: "Organization admission policy updated." },
        400: { description: "Policy validation failed." },
        402: { description: "Enterprise organization controls are required." },
        403: { description: "Owner and fresh authentication are required." },
        409: { description: "The policy changed concurrently." },
      },
    }),
    orgRoleRoute(["owner"]),
    jsonValidator(admissionPolicyInputSchema),
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) return c.json(permission.response, 403)
      const context = c.get("organizationContext")
      const entitlement = checkEntitlement(context.organization.metadata, "orgControls")
      if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)
      const input = c.req.valid("json")
      try {
        const policy = await updateOrganizationAdmissionPolicy({
          organizationId: context.organization.id,
          actorUserId: normalizeDenTypeId("user", c.get("user").id),
          ...input,
        })
        return c.json({ policy, enforcementMode: env.organizationAdmissionEnforcement })
      } catch (error) {
        if (error instanceof OrganizationAdmissionConflictError) {
          return c.json({ error: "policy_version_conflict", message: "Reload the policy and try again." }, 409)
        }
        if (error instanceof OrganizationAdmissionPolicyValidationError) {
          return c.json({ error: error.code, message: error.message }, 400)
        }
        throw error
      }
    },
  )

  for (const operation of ["evaluate", "join"] as const) {
    app.post(
      `/v1/orgs/:slug/admission/${operation}`,
      describeRoute({
        tags: ["Organizations"],
        summary: operation === "evaluate" ? "Evaluate organization admission" : "Join organization",
        responses: {
          200: { description: "Admission decision returned." },
          402: { description: "A paid seat is required." },
          403: { description: "Admission requires another action or was denied." },
          404: { description: "Organization not found." },
        },
      }),
      authenticatedRoute(),
      paramValidator(admissionSlugParamsSchema),
      jsonValidator(admissionAttemptSchema),
      async (c) => {
        if (c.get("apiKey")) return c.json({ decision: { decision: "deny", reason: "identity_conflict" } }, 403)
        const organization = await organizationBySlug(c.req.valid("param").slug)
        if (!organization) return c.json({ decision: { decision: "deny", reason: "organization_unavailable" } }, 404)
        const input = c.req.valid("json")
        const attempt = {
          organizationId: organization.id,
          userId: normalizeDenTypeId("user", c.get("user").id),
          evidence: input.invitationToken
            ? { kind: "invitation" as const, token: input.invitationToken }
            : { kind: "self_join" as const },
          assurance: await requestAssurance(c.get("session")?.id),
        }
        try {
          const decision = operation === "join"
            ? await admitOrganizationMember(attempt)
            : await evaluateOrganizationAdmission(attempt)
          if (operation === "evaluate") return c.json({ decision, organizationId: organization.id })
          if (decision.decision !== "allow") return c.json({ decision }, decisionStatus(decision))
          if (operation === "join" && c.get("session")?.id) {
            await setSessionActiveOrganization(normalizeDenTypeId("session", c.get("session")!.id), organization.id)
          }
          return c.json({ decision, organizationId: organization.id })
        } catch (error) {
          if (error instanceof OrganizationAdmissionConflictError) {
            return c.json({ error: "admission_state_changed", message: "The organization policy changed. Try again." }, 409)
          }
          throw error
        }
      },
    )
  }
}
