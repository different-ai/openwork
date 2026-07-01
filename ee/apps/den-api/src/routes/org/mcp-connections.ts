import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { createOAuthStateToken, verifyOAuthStateToken } from "../../capability-sources/generic-oauth.js"
import {
  connectExternalMcp,
  completeExternalMcpAuth,
} from "../../capability-sources/external-mcp-client.js"
import {
  createExternalMcpConnection,
  deleteExternalMcpConnection,
  disconnectExternalMcpConnection,
  getExternalMcpConnection,
  getExternalMcpConnectionById,
  listExternalMcpConnections,
} from "../../capability-sources/external-mcp-connections.js"
import { EXTERNAL_MCP_PRESETS } from "../../capability-sources/external-mcp-presets.js"
import { ensureOrganizationAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")

const createConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().trim().url().max(2048),
  authType: z.enum(["oauth", "apikey", "none"]),
  apiKey: z.string().trim().min(1).max(4096).optional(),
})

const connectionNotFoundSchema = z.object({
  error: z.literal("connection_not_found"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotFoundError" })

const connectionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  connected: z.boolean(),
  connectedAt: z.string().nullable(),
}).meta({ ref: "ExternalMcpConnectionResponse" })

const connectionListResponseSchema = z.object({
  connections: z.array(connectionResponseSchema),
}).meta({ ref: "ExternalMcpConnectionListResponse" })

const presetResponseSchema = z.object({
  presetId: z.string(),
  displayName: z.string(),
  description: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
}).meta({ ref: "ExternalMcpPresetResponse" })

const presetListResponseSchema = z.object({
  presets: z.array(presetResponseSchema),
}).meta({ ref: "ExternalMcpPresetListResponse" })

const connectStartResponseSchema = z.object({
  status: z.enum(["connected", "needs_auth"]),
  authorizeUrl: z.string().nullable(),
}).meta({ ref: "ExternalMcpConnectStartResponse" })

function toConnectionResponse(row: { id: string; name: string; url: string; authType: "oauth" | "apikey" | "none"; accessToken: string | null; apiKey: string | null; connectedAt: Date | null }) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    connected: Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt)),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
  }
}

function callbackRedirectUri(request: Request, connectionId: string) {
  const url = new URL(request.url)
  return `${url.origin}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

/**
 * "Add any MCP server" — org-level External MCP Connections. Unlike
 * oauth-providers.ts (one registry entry per native provider we implement
 * ourselves), any org admin can register a connection here by URL; the real
 * OAuth dance (RFC 9728 discovery + dynamic client registration + PKCE) is
 * driven by the MCP SDK itself (capability-sources/external-mcp-client.ts),
 * not a fixed registry entry, since third-party MCP servers don't have a
 * pre-shared client id the way Google Workspace does.
 *
 * Mutation and connect/OAuth routes are tagged Authentication (already
 * blocked from the agent-facing MCP surface, same treatment as
 * oauth-providers.ts) — an agent should never create, delete, or drive the
 * OAuth handshake for a connection itself. Read-only list/status/presets are
 * tagged Capability Sources so a harness can at least see what's connected.
 */
export function registerMcpConnectionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-connections/presets",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List predefined External MCP Connection presets",
      description: "Common third-party MCP servers (Notion, Linear, Stripe, ...) an admin can add with one click, prefilled with a real name and URL.",
      responses: {
        200: jsonResponse("Presets.", presetListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      return c.json({ presets: EXTERNAL_MCP_PRESETS })
    },
  )

  app.get(
    "/v1/mcp-connections",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List the org's External MCP Connections",
      responses: {
        200: jsonResponse("Connections.", connectionListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const rows = await listExternalMcpConnections(payload.organization.id)
      return c.json({ connections: rows.map(toConnectionResponse) })
    },
  )

  app.post(
    "/v1/mcp-connections",
    describeRoute({
      tags: ["Authentication"],
      summary: "Register a new External MCP Connection",
      description: "Admin-only. Registers a third-party MCP server by name + URL. For authType=oauth, call connect/start next. For authType=apikey/none, the connection is validated immediately.",
      responses: {
        200: jsonResponse("Connection created.", connectionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can add MCP connections.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createConnectionBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can add MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const body = c.req.valid("json")
      if (body.authType === "apikey" && !body.apiKey) {
        return c.json({ error: "invalid_request", message: "apiKey is required when authType is apikey." }, 400)
      }

      const created = await createExternalMcpConnection({
        organizationId: payload.organization.id,
        name: body.name,
        url: body.url,
        authType: body.authType,
        apiKey: body.apiKey ?? null,
        createdByOrgMembershipId: payload.currentMember.id,
      })

      if (body.authType !== "oauth") {
        // No OAuth dance needed — validate the server is real and reachable now.
        await connectExternalMcp(created, callbackRedirectUri(c.req.raw, created.id))
      }

      const refreshed = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: created.id })
      return c.json(toConnectionResponse(refreshed ?? created))
    },
  )

  app.delete(
    "/v1/mcp-connections/:connectionId",
    describeRoute({
      tags: ["Authentication"],
      summary: "Remove an External MCP Connection",
      responses: {
        200: emptyResponse("Removed."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can remove MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can remove MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const removed = await deleteExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!removed) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      return c.json({ ok: true })
    },
  )

  app.post(
    "/v1/mcp-connections/:connectionId/disconnect",
    describeRoute({
      tags: ["Authentication"],
      summary: "Disconnect (clear credentials for) an External MCP Connection without removing it",
      responses: {
        200: emptyResponse("Disconnected."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can disconnect MCP connections.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can disconnect MCP connections.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const removed = await disconnectExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!removed) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }
      return c.json({ ok: true })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/connect/start",
    describeRoute({
      tags: ["Authentication"],
      summary: "Begin the OAuth handshake for an External MCP Connection",
      description: "Runs RFC 9728 discovery, dynamic client registration if needed, and returns an authorize URL to redirect the admin's browser to.",
      responses: {
        200: jsonResponse("Authorize URL, or already connected.", connectStartResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      // Our own signed state token identifies which connection this is for
      // once the external server redirects back. It MUST travel as the
      // standard OAuth `state` param — a custom param would simply be
      // dropped, since only `state` is guaranteed to round-trip on any
      // spec-compliant authorization server (see ExternalMcpOAuthProvider.state()).
      const signedState = createOAuthStateToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId: connectionId,
        secret: env.betterAuthSecret,
      })
      const redirectUri = callbackRedirectUri(c.req.raw, connectionId)
      const result = await connectExternalMcp(connection, redirectUri, signedState)
      if (result.status === "connected") {
        return c.json({ status: "connected" as const, authorizeUrl: null })
      }
      return c.json({ status: "needs_auth" as const, authorizeUrl: result.authorizeUrl })
    },
  )

  app.get(
    "/v1/mcp-connections/:connectionId/connect/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "OAuth callback for an External MCP Connection",
      description: "The external MCP server redirects here with code+state after the admin consents. Serves a small static HTML page — the admin's Den tab in the background polls connection status and never needs this response body.",
      responses: {
        200: htmlResponse("Connected — a static success page."),
        400: jsonResponse("Missing or invalid code/state.", invalidRequestSchema),
      },
    }),
    publicRoute,
    paramValidator(connectionParamsSchema),
    async (c) => {
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const url = new URL(c.req.url)
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) {
        return c.json({ error: "invalid_request", message: "Missing code or state." }, 400)
      }

      const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
      if (!statePayload || statePayload.providerId !== connectionId) {
        return c.json({ error: "invalid_request", message: "Invalid or expired state." }, 400)
      }

      const connection = await getExternalMcpConnectionById(externalMcpConnectionId)
      if (!connection) {
        return c.json({ error: "invalid_request", message: "Unknown connection." }, 400)
      }

      try {
        await completeExternalMcpAuth(connection, code, callbackRedirectUri(c.req.raw, connectionId))
      } catch (error) {
        return c.html(connectCallbackPage({ ok: false, name: connection.name, message: error instanceof Error ? error.message : String(error) }), 400)
      }
      return c.html(connectCallbackPage({ ok: true, name: connection.name }))
    },
  )
}

function connectCallbackPage(input: { ok: true; name: string } | { ok: false; name: string; message: string }): string {
  const title = input.ok ? "Connected" : "Connection failed"
  const body = input.ok
    ? `<p>${escapeHtml(input.name)} is connected. You can close this tab and return to Den.</p>`
    : `<p>Couldn't connect ${escapeHtml(input.name)}: ${escapeHtml(input.message)}</p>`
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title} — OpenWork</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; text-align: center; color: #0f172a;">
    <h1 style="font-size: 20px;">${title}</h1>
    ${body}
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
