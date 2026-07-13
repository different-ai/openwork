import {
  egressDiagnosticConfigurationSchema,
  egressDiagnosticRunSchema,
  type EgressDiagnosticConfiguration,
} from "@openwork/types/den/egress-diagnostics"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationDiagnosticCredentialTable } from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { db } from "../../db.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { runEgressDiagnostic } from "../../egress-diagnostics.js"
import type { OrgRouteVariables } from "./shared.js"

const unavailableSchema = z.object({
  error: z.literal("egress_diagnostics_not_configured"),
  missingConfiguration: egressDiagnosticConfigurationSchema.shape.missingConfiguration,
})

const diagnosticTokenSchema = z.object({
  bearerToken: z.string().trim().min(24).max(4096),
})

type OrganizationId = typeof OrganizationDiagnosticCredentialTable.$inferSelect.organizationId

async function configuredBearerToken(organizationId: OrganizationId) {
  const rows = await db
    .select({ bearerToken: OrganizationDiagnosticCredentialTable.bearerToken })
    .from(OrganizationDiagnosticCredentialTable)
    .where(eq(OrganizationDiagnosticCredentialTable.organizationId, organizationId))
    .limit(1)

  return rows[0]?.bearerToken ?? env.diagnostics.bearerToken
}

async function egressDiagnosticConfiguration(organizationId: OrganizationId): Promise<EgressDiagnosticConfiguration> {
  const missingConfiguration: EgressDiagnosticConfiguration["missingConfiguration"] = []
  if (!await configuredBearerToken(organizationId)) missingConfiguration.push("DEN_DIAGNOSTICS_BEARER_TOKEN")
  return {
    available: missingConfiguration.length === 0,
    targetOrigin: env.diagnostics.origin,
    missingConfiguration,
  }
}

export function registerOrgEgressDiagnosticRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/diagnostics/egress",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Describe the controlled Den egress diagnostic",
      description: "Reports whether the operator-configured public Diagnostics target is available. The target cannot be supplied by the browser.",
      responses: {
        200: jsonResponse("Egress diagnostic configuration returned successfully.", egressDiagnosticConfigurationSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can inspect egress diagnostics.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const organizationId = c.get("organizationContext")?.organization.id
      if (!organizationId) return c.json({ error: "organization_not_found" }, 404)
      return c.json(await egressDiagnosticConfiguration(organizationId))
    },
  )

  app.put(
    "/v1/diagnostics/egress/token",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Set the organization egress diagnostic bearer token",
      description: "Stores the synthetic Diagnostics bearer token encrypted for this organization. The token is never returned by the API.",
      responses: {
        204: { description: "The diagnostic token was stored." },
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can configure egress diagnostics.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const input = diagnosticTokenSchema.parse(await c.req.json())
      const organizationId = c.get("organizationContext")?.organization.id
      if (!organizationId) return c.json({ error: "organization_not_found" }, 404)
      await db.insert(OrganizationDiagnosticCredentialTable).values({
        organizationId,
        bearerToken: input.bearerToken,
      }).onDuplicateKeyUpdate({
        set: { bearerToken: input.bearerToken, updatedAt: new Date() },
      })
      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/diagnostics/egress",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Run the controlled Den egress diagnostic",
      description: "Runs fixed HTTP, redirect, OAuth-shaped, and MCP probes from the Den process to the operator-configured public Diagnostics origin.",
      responses: {
        200: jsonResponse("The completed diagnostic run, including a failed result when a layer did not pass.", egressDiagnosticRunSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can run egress diagnostics.", forbiddenSchema),
        503: jsonResponse("The Den operator has not configured the Diagnostics target.", unavailableSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const organizationId = c.get("organizationContext")?.organization.id
      if (!organizationId) return c.json({ error: "organization_not_found" }, 404)
      const bearerToken = await configuredBearerToken(organizationId)
      const configuration = await egressDiagnosticConfiguration(organizationId)
      if (!configuration.available || !bearerToken) {
        return c.json({
          error: "egress_diagnostics_not_configured" as const,
          missingConfiguration: configuration.missingConfiguration,
        }, 503)
      }

      console.info("den_egress_diagnostic_started", { organizationId })
      const result = await runEgressDiagnostic({
        bearerToken,
        origin: env.diagnostics.origin,
      })
      console.info("den_egress_diagnostic_completed", {
        failedStep: result.failedStep,
        organizationId,
        overallStatus: result.overallStatus,
        runId: result.runId,
      })
      return c.json(result)
    },
  )
}
