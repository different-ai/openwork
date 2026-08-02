import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  enableCliConnector,
  listCliConnectors,
  type CliConnectorRow,
} from "../../capability-sources/cli-connections.js"
import {
  getCliConnectorManifest,
  GITHUB_CLI_DEMO_CATALOG_KEY,
} from "../../capability-sources/cli-connector-manifests.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import {
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  unauthorizedSchema,
} from "../../openapi.js"
import {
  ensureOrganizationAdminRole,
  orgAccessFailureStatus,
  type OrgRouteVariables,
} from "./shared.js"

const cliConnectorResponseSchema = z.object({
  id: z.string(),
  catalogKey: z.string(),
  name: z.string(),
  manifestVersion: z.string(),
  manifestDigest: z.string().nullable(),
  enabled: z.boolean(),
  readiness: z.enum(["ready", "needs_admin_setup"]),
  commandSummary: z.object({ read: z.number().int().nonnegative() }),
  createdAt: z.string(),
  updatedAt: z.string(),
}).meta({ ref: "CliConnector" })

const cliConnectorListResponseSchema = z.object({
  connections: z.array(cliConnectorResponseSchema),
})

const enableCliConnectorBodySchema = z.object({
  catalogKey: z.literal(GITHUB_CLI_DEMO_CATALOG_KEY),
})

type CliConnectorResponse = z.infer<typeof cliConnectorResponseSchema>

function toCliConnectorResponse(connection: CliConnectorRow): CliConnectorResponse {
  const manifest = getCliConnectorManifest(connection.catalogKey, connection.manifestVersion)
  return {
    id: connection.id,
    catalogKey: connection.catalogKey,
    name: connection.name,
    manifestVersion: connection.manifestVersion,
    manifestDigest: manifest?.digest ?? null,
    enabled: connection.enabled,
    readiness: connection.enabled && manifest ? "ready" : "needs_admin_setup",
    commandSummary: { read: manifest ? 1 : 0 },
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

export function registerCliConnectionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/cli-connections",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List hosted CLI connectors for the organization",
      responses: {
        200: jsonResponse("CLI connectors.", cliConnectorListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage CLI connectors.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can manage CLI connectors.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const organization = c.get("organizationContext").organization
      const connections = await listCliConnectors(organization.id)
      return c.json({ connections: connections.map(toCliConnectorResponse) })
    },
  )

  app.post(
    "/v1/cli-connections",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Enable a reviewed hosted CLI connector",
      description: "P0 only accepts the built-in GitHub CLI Demo catalog key. Executables, arguments, images, environment variables, and credentials are not accepted from the request.",
      responses: {
        200: jsonResponse("CLI connector enabled.", cliConnectorResponseSchema),
        400: jsonResponse("Unknown CLI connector catalog key.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can enable CLI connectors.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(enableCliConnectorBodySchema),
    async (c) => {
      const admin = ensureOrganizationAdminRole(c, "Only workspace owners and admins can enable CLI connectors.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const body = c.req.valid("json")
      const manifest = getCliConnectorManifest(body.catalogKey)
      if (!manifest) {
        return c.json({ error: "invalid_request", message: "Unknown CLI connector catalog key." }, 400)
      }
      const organizationContext = c.get("organizationContext")
      const connection = await enableCliConnector({
        organizationId: organizationContext.organization.id,
        catalogKey: manifest.catalogKey,
        name: manifest.displayName,
        manifestVersion: manifest.manifestVersion,
        createdByOrgMembershipId: organizationContext.currentMember.id,
      })
      return c.json(toCliConnectorResponse(connection))
    },
  )
}
