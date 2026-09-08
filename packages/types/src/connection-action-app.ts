import { z } from "zod"

const idSchema = z.string().trim().min(1).max(160)

export const connectionActionAppSchemaVersion = "1" as const
export const connectionActionAppResourceUri = "ui://openwork/connection-action/v1/view.html"
export const connectionActionToolName = "connection_action"

/**
 * Data contract for the first-party connection-action MCP App: one live
 * status report for one Connect connection, including the exact human action
 * (sign in, admin setup, provider fix) that unblocks it. `connected` is the
 * healthy probe result; the other states mirror the gateway's
 * ExternalConnectionStatus steering.
 */
export const connectionActionPayloadSchema = z.object({
  schemaVersion: z.literal(connectionActionAppSchemaVersion),
  connectionId: idSchema,
  connectionName: z.string().trim().min(1).max(255),
  state: z.enum(["connected", "needs_connection", "reauth_required", "provider_error"]),
  actor: z.enum([
    "member",
    "organization_admin",
    "provider_admin",
    "network_admin",
    "openwork",
  ]).nullable(),
  message: z.string().trim().min(1).max(2_000),
  action: z.object({
    type: z.enum([
      "connect",
      "reconnect",
      "update_credentials",
      "inspect_connection",
      "fix_provider",
      "fix_network",
      "contact_openwork",
    ]),
    label: z.string().trim().min(1).max(255),
    surface: z.enum([
      "openwork_your_connections",
      "openwork_organization_connections",
      "provider_admin_console",
      "network_infrastructure",
      "openwork_support",
    ]),
    url: z.string().url().optional(),
  }).nullable(),
})

export type ConnectionActionPayload = z.infer<typeof connectionActionPayloadSchema>

/** Curated setup suggestions, distinct from connected/executable capabilities. */
export const connectorCatalogSchema = z.object({
  version: z.literal(1),
  selectedIds: z.array(z.string()),
  entries: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    description: z.string(),
    serviceUrl: z.string().url().optional(),
    setup: z.enum(["oauth", "oauth_client", "api_key", "instant", "suite"]),
    setupUrl: z.string().url(),
  })),
})
export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>
