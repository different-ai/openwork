import { z } from "zod"

export const MICX_CLOUD_MCP_CONNECTION_ACTION_VERSION = 1 as const
export const MICX_CLOUD_MCP_CONNECTION_ACTION_KIND = "connection_action" as const
export const MICX_CLOUD_MCP_CONNECTION_ACTION_SOURCE = "micx-cloud" as const

export const micxCloudMcpConnectionActionSchema = z.object({
  version: z.literal(MICX_CLOUD_MCP_CONNECTION_ACTION_VERSION),
  kind: z.literal(MICX_CLOUD_MCP_CONNECTION_ACTION_KIND),
  source: z.literal(MICX_CLOUD_MCP_CONNECTION_ACTION_SOURCE),
  connectionId: z.string().min(1),
  connectionName: z.string().min(1),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  state: z.enum(["needs_connection", "reauth_required", "provider_error"]),
  actor: z.enum([
    "member",
    "organization_admin",
    "provider_admin",
    "network_admin",
    "micx",
  ]),
  action: z.object({
    type: z.enum([
      "connect",
      "reconnect",
      "update_credentials",
      "inspect_connection",
      "fix_provider",
      "fix_network",
      "contact_micx",
    ]),
    surface: z.enum([
      "micx_your_connections",
      "micx_organization_connections",
      "provider_admin_console",
      "network_infrastructure",
      "micx_support",
    ]),
    retry: z.literal("search_capabilities"),
  }),
})

/**
 * The only connection action that chat may execute directly. Shared OAuth,
 * API-key, provider-admin, and support actions remain descriptive because the
 * current member may not own the credential or have permission to repair it.
 */
export const micxCloudMcpInlineReconnectSchema = micxCloudMcpConnectionActionSchema.extend({
  authType: z.literal("oauth"),
  credentialMode: z.literal("per_member"),
  state: z.literal("reauth_required"),
  actor: z.literal("member"),
  action: z.object({
    type: z.literal("reconnect"),
    surface: z.literal("micx_your_connections"),
    retry: z.literal("search_capabilities"),
  }),
})

export type MicxCloudMcpConnectionAction = z.infer<typeof micxCloudMcpConnectionActionSchema>
export type MicxCloudMcpInlineReconnect = z.infer<typeof micxCloudMcpInlineReconnectSchema>
