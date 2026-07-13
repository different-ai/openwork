import {
  egressDiagnosticConfigurationSchema,
  egressDiagnosticRunSchema,
  type EgressDiagnosticConfiguration,
} from "@openwork/types/den/egress-diagnostics"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { runEgressDiagnostic } from "../../egress-diagnostics.js"
import type { OrgRouteVariables } from "./shared.js"

const unavailableSchema = z.object({
  error: z.literal("egress_diagnostics_not_configured"),
  missingConfiguration: egressDiagnosticConfigurationSchema.shape.missingConfiguration,
})

export function egressDiagnosticConfiguration(): EgressDiagnosticConfiguration {
  const missingConfiguration: EgressDiagnosticConfiguration["missingConfiguration"] = []
  if (!env.diagnostics.bearerToken) missingConfiguration.push("DEN_DIAGNOSTICS_BEARER_TOKEN")
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
    (c) => c.json(egressDiagnosticConfiguration()),
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
      const configuration = egressDiagnosticConfiguration()
      if (!configuration.available || !env.diagnostics.bearerToken) {
        return c.json({
          error: "egress_diagnostics_not_configured" as const,
          missingConfiguration: configuration.missingConfiguration,
        }, 503)
      }

      const organizationId = c.get("organizationContext")?.organization.id ?? "unknown"
      console.info("den_egress_diagnostic_started", { organizationId })
      const result = await runEgressDiagnostic({
        bearerToken: env.diagnostics.bearerToken,
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
