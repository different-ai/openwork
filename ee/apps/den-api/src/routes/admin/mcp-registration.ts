import { MCP_REGISTRATION_OUTCOMES, MCP_REGISTRATION_SOURCES, mcpRegistrationStatusSchema } from "@openwork/types/den/mcp-registration"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { runMcpRegistrationProbe } from "../../mcp-registration/probe.js"
import { countMcpRegistrationEvents, listMcpRegistrationStatuses } from "../../mcp-registration/status.js"
import { adminRoute, jsonValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const DAY_MS = 24 * 60 * 60 * 1000
const timestamp = z.iso.datetime().nullable()

const providerSchema = z.object({
  issuer: z.string(),
  presetId: z.string().nullable(),
  serverUrl: z.string().nullable(),
  status: mcpRegistrationStatusSchema,
  clientMetadataSupported: z.boolean().nullable(),
  dynamicRegistrationSupported: z.boolean().nullable(),
  registrationEndpoint: z.string().nullable(),
  lastSource: z.enum(MCP_REGISTRATION_SOURCES).nullable(),
  lastHttpStatus: z.number().int().nullable(),
  lastDiagnosticCode: z.string().nullable(),
  lastReference: z.string().nullable(),
  acceptedCount: z.number().int(),
  refusedCount: z.number().int(),
  lastAcceptedAt: timestamp,
  lastRefusedAt: timestamp,
  lastObservedAt: timestamp,
  lastProbedAt: timestamp,
  /** Observations in the last 30 days by source and outcome. */
  last30Days: z.array(z.object({ source: z.enum(MCP_REGISTRATION_SOURCES), outcome: z.enum(MCP_REGISTRATION_OUTCOMES), count: z.number().int() })),
})

const reportSchema = z.object({
  providers: z.array(providerSchema),
  generatedAt: z.iso.datetime(),
}).meta({ ref: "AdminMcpRegistrationReport" })

const runSchema = z.object({
  /** Also register OpenWork with providers whose metadata cannot tell (a test client, deleted again when the provider allows). */
  tryRegistration: z.boolean().default(false),
}).meta({ ref: "AdminMcpRegistrationRunRequest" })

const runResultSchema = z.object({ checked: z.number().int(), skipped: z.number().int() }).meta({ ref: "AdminMcpRegistrationRunResult" })

const iso = (value: Date | null) => value ? value.toISOString() : null

export function registerAdminMcpRegistrationRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/admin/mcp-registration",
    describeRoute({
      tags: ["Admin"],
      summary: "Which MCP providers let OpenWork sign people in",
      description: "For every MCP OAuth authorization server OpenWork has seen, from members' real sign-ins and the scheduled preset check: whether it accepts OpenWork's client (Client ID Metadata Document or dynamic registration), refuses it (only approved apps), or needs an admin-created OAuth app, with counts and when each was last seen. Deployment-wide; holds no credentials. Platform administrators only.",
      responses: {
        200: jsonResponse("Registration report returned.", reportSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
      },
    }),
    adminRoute(),
    async (c) => {
      const [statuses, counts] = await Promise.all([
        listMcpRegistrationStatuses(),
        countMcpRegistrationEvents(new Date(Date.now() - 30 * DAY_MS)),
      ])
      const byIssuer = new Map<string, z.infer<typeof providerSchema>["last30Days"]>()
      for (const count of counts) {
        const list = byIssuer.get(count.issuer) ?? []
        list.push({ source: count.source, outcome: count.outcome, count: count.count })
        byIssuer.set(count.issuer, list)
      }
      return c.json({
        providers: statuses.map((row) => ({
          issuer: row.issuer,
          presetId: row.presetId,
          serverUrl: row.serverUrl,
          status: row.status,
          clientMetadataSupported: row.clientMetadataSupported,
          dynamicRegistrationSupported: row.dynamicRegistrationSupported,
          registrationEndpoint: row.registrationEndpoint,
          lastSource: row.lastSource,
          lastHttpStatus: row.lastHttpStatus,
          lastDiagnosticCode: row.lastDiagnosticCode,
          lastReference: row.lastReference,
          acceptedCount: row.acceptedCount,
          refusedCount: row.refusedCount,
          lastAcceptedAt: iso(row.lastAcceptedAt),
          lastRefusedAt: iso(row.lastRefusedAt),
          lastObservedAt: iso(row.lastObservedAt),
          lastProbedAt: iso(row.lastProbedAt),
          last30Days: byIssuer.get(row.issuer) ?? [],
        })),
        generatedAt: new Date().toISOString(),
      })
    },
  )

  app.post(
    "/v1/admin/mcp-registration/check",
    describeRoute({
      tags: ["Admin"],
      summary: "Check the preset MCP providers now",
      description: "Runs the scheduled preset check once: reads each OAuth preset's sign-in metadata and records what it shows. With tryRegistration, also registers OpenWork's client (as a member's sign-in would) where only a registration can tell, deleting it again when the provider allows. Providers checked within the scheduled interval are skipped. Platform administrators only.",
      responses: {
        200: jsonResponse("Check finished.", runResultSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign in required.", unauthorizedSchema),
        403: jsonResponse("Platform administrator required.", forbiddenSchema),
      },
    }),
    adminRoute(),
    jsonValidator(runSchema),
    async (c) => {
      const { tryRegistration } = c.req.valid("json")
      return c.json(await runMcpRegistrationProbe({ tryRegistration }))
    },
  )
}
