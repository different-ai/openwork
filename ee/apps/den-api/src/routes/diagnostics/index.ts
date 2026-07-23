import {
  connectDiagnosticClientBatchSchema,
} from "@openwork/types/den/connect-diagnostics"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  configuredConnectDiagnosticBearerToken,
  desktopConnectDiagnosticIncidents,
  forwardConnectDiagnosticIncidents,
} from "../../connect-diagnostics.js"
import {
  jsonValidator,
  orgMemberRoute,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

type DiagnosticsRouteVariables = AuthContextVariables & Partial<OrganizationContextVariables>

const diagnosticsUnavailableSchema = z.object({
  error: z.literal("connect_diagnostics_unavailable"),
  message: z.string(),
}).meta({ ref: "ConnectDiagnosticsUnavailableError" })
const diagnosticsPayloadTooLargeSchema = z.object({
  error: z.literal("payload_too_large"),
  message: z.string(),
}).meta({ ref: "ConnectDiagnosticsPayloadTooLargeError" })

export function registerConnectDiagnosticRoutes<T extends { Variables: DiagnosticsRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/diagnostics/connect-incidents",
    describeRoute({
      hide: true,
      summary: "Report OpenWork Connect incidents",
      description: "Accepts metadata-only desktop OpenWork Connect health events and relays them to the operator diagnostics service without member identity or customer content.",
      responses: {
        204: emptyResponse("Connection incidents accepted."),
        413: jsonResponse("Connection diagnostic batch is too large.", diagnosticsPayloadTooLargeSchema),
        503: jsonResponse("Connection diagnostics delivery is unavailable.", diagnosticsUnavailableSchema),
      },
    }),
    orgMemberRoute(),
    bodyLimit({
      maxSize: 128 * 1_024,
      onError: (c) => c.json({
        error: "payload_too_large" as const,
        message: "Connection diagnostic batches must fit within 128 KiB.",
      }, 413),
    }),
    jsonValidator(connectDiagnosticClientBatchSchema),
    async (c) => {
      const organizationId = c.get("organizationContext")?.organization.id
      const bearerToken = configuredConnectDiagnosticBearerToken()
      if (!organizationId || !bearerToken) {
        return c.json({
          error: "connect_diagnostics_unavailable" as const,
          message: "Connection diagnostics delivery is not configured.",
        }, 503)
      }
      try {
        await forwardConnectDiagnosticIncidents({
          incidents: desktopConnectDiagnosticIncidents({
            organizationId,
            events: c.req.valid("json").events,
            bearerToken,
          }),
        })
        return c.body(null, 204)
      } catch {
        return c.json({
          error: "connect_diagnostics_unavailable" as const,
          message: "Connection diagnostics delivery is temporarily unavailable.",
        }, 503)
      }
    },
  )
}
