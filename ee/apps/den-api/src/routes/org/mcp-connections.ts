import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  publicRoute,
  queryValidator,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, htmlResponse, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { createOAuthStateToken, resolvePublicOrigin, verifyOAuthStateToken } from "../../capability-sources/generic-oauth.js"
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
  listExternalMcpConnectionAccess,
  listExternalMcpConnections,
  listUsableExternalMcpConnections,
  memberCanUseExternalMcpConnection,
  replaceExternalMcpConnectionAccess,
  type ExternalMcpConnectionRow,
} from "../../capability-sources/external-mcp-connections.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { getConnectedAccount } from "../../capability-sources/oauth-credentials.js"
import { assertPublicUrl } from "../../capability-sources/url-guard.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { EXTERNAL_MCP_PRESETS } from "../../capability-sources/external-mcp-presets.js"
import { ensureOrganizationAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const connectionParamsSchema = idParamSchema("connectionId", "externalMcpConnection")

const accessInputSchema = z.object({
  orgWide: z.boolean().optional().default(false),
  memberIds: z.array(z.string().trim().min(1)).max(200).optional().default([]),
  teamIds: z.array(z.string().trim().min(1)).max(200).optional().default([]),
}).meta({ ref: "ExternalMcpConnectionAccessInput" })

const createConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().trim().url().max(2048),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]).optional().default("shared"),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  /** Who can USE the connection. Defaults to org-wide so the naive quick-add path matches expectations, but it's an explicit, editable choice. */
  access: accessInputSchema.optional().default({ orgWide: true, memberIds: [], teamIds: [] }),
})

const replaceAccessBodySchema = z.object({
  access: accessInputSchema,
})

const connectionNotFoundSchema = z.object({
  error: z.literal("connection_not_found"),
  message: z.string(),
}).meta({ ref: "ExternalMcpConnectionNotFoundError" })

const accessSummarySchema = z.object({
  orgWide: z.boolean(),
  memberIds: z.array(z.string()),
  teamIds: z.array(z.string()),
}).meta({ ref: "ExternalMcpConnectionAccessSummary" })

const connectionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  connected: z.boolean(),
  connectedAt: z.string().nullable(),
  /** For per_member connections: whether the CALLING member has connected their own account. Always true for connected shared connections. */
  connectedForMe: z.boolean(),
  /** Present only for scope=manageable (admin) listings. */
  access: accessSummarySchema.nullable(),
}).meta({ ref: "ExternalMcpConnectionResponse" })

const connectionListResponseSchema = z.object({
  connections: z.array(connectionResponseSchema),
}).meta({ ref: "ExternalMcpConnectionListResponse" })

const listConnectionsQuerySchema = z.object({
  /** usable (default): connections the calling member has been granted. manageable: every org connection, admin-only. */
  scope: z.enum(["usable", "manageable"]).optional().default("usable"),
})

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

function isConnectionConnected(row: ExternalMcpConnectionRow): boolean {
  if (row.credentialMode === "per_member") {
    // A per_member connection is "published" once created; individual
    // members connect their own accounts (connectedForMe).
    return true
  }
  return Boolean(row.accessToken || row.apiKey || (row.authType === "none" && row.connectedAt))
}

async function toConnectionResponse(
  row: ExternalMcpConnectionRow,
  options: {
    callerOrgMembershipId: DenTypeId<"member">
    includeAccess: boolean
  },
) {
  let connectedForMe = isConnectionConnected(row) && row.credentialMode === "shared"
  if (row.credentialMode === "per_member") {
    const account = await getConnectedAccount({
      organizationId: row.organizationId,
      orgMembershipId: options.callerOrgMembershipId,
      providerId: row.id,
    })
    connectedForMe = Boolean(account?.accessToken)
  }

  let access: { orgWide: boolean; memberIds: string[]; teamIds: string[] } | null = null
  if (options.includeAccess) {
    const grants = await listExternalMcpConnectionAccess(row.id)
    access = {
      orgWide: grants.some((grant) => grant.orgWide),
      memberIds: grants.flatMap((grant) => (grant.orgMembershipId ? [grant.orgMembershipId] : [])),
      teamIds: grants.flatMap((grant) => (grant.teamId ? [grant.teamId] : [])),
    }
  }

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    credentialMode: row.credentialMode,
    connected: isConnectionConnected(row),
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    connectedForMe,
    access,
  }
}

function callbackRedirectUri(request: Request, connectionId: string) {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
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
      summary: "List External MCP Connections",
      description: "scope=usable (default): connections the calling member has been granted (org-wide, direct, or via a team), with per-member connection status. scope=manageable: every org connection with access summaries — workspace owners and admins only.",
      responses: {
        200: jsonResponse("Connections.", connectionListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("scope=manageable requires a workspace owner or admin.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    queryValidator(listConnectionsQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { scope } = c.req.valid("query")

      if (scope === "manageable") {
        const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can list all MCP connections.")
        if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
        const rows = await listExternalMcpConnections(payload.organization.id)
        const connections = await Promise.all(rows.map((row) =>
          toConnectionResponse(row, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true })))
        return c.json({ connections })
      }

      // Staged rollout: gated deployments return an empty list for
      // non-opted-in orgs — indistinguishable from "nothing published", on
      // every desktop version in the field (see external-mcp-rollout.ts).
      if (!memberFacingMcpConnectionsEnabled(payload.organization.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })) {
        return c.json({ connections: [] })
      }

      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const rows = await listUsableExternalMcpConnections({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        teamIds: memberTeams.map((team) => team.id),
      })
      const connections = await Promise.all(rows.map((row) =>
        toConnectionResponse(row, { callerOrgMembershipId: payload.currentMember.id, includeAccess: false })))
      return c.json({ connections })
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
      if (body.credentialMode === "per_member" && body.authType !== "oauth") {
        return c.json({ error: "invalid_request", message: "credentialMode per_member requires authType oauth — API keys and no-auth servers have no per-person identity to connect." }, 400)
      }
      if (!env.allowPrivateMcpUrls) {
        // Fail fast with a clear message; the guarded fetch inside the MCP
        // client re-checks at request time anyway (DNS can change later).
        try {
          await assertPublicUrl(body.url)
        } catch (error) {
          return c.json({ error: "invalid_request", message: error instanceof Error ? error.message : "URL not allowed." }, 400)
        }
      }

      const created = await createExternalMcpConnection({
        organizationId: payload.organization.id,
        name: body.name,
        url: body.url,
        authType: body.authType,
        credentialMode: body.credentialMode,
        apiKey: body.apiKey ?? null,
        createdByOrgMembershipId: payload.currentMember.id,
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
      })

      if (body.authType !== "oauth") {
        // No OAuth dance needed — validate the server is real and reachable now.
        await connectExternalMcp(created, callbackRedirectUri(c.req.raw, created.id))
      }

      const refreshed = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: created.id })
      return c.json(await toConnectionResponse(refreshed ?? created, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true }))
    },
  )

  app.put(
    "/v1/mcp-connections/:connectionId/access",
    describeRoute({
      tags: ["Authentication"],
      summary: "Replace who can use an External MCP Connection",
      description: "Admin-only. Full-replace semantics: send the complete desired access set (orgWide, or memberIds + teamIds).",
      responses: {
        200: jsonResponse("Access updated.", connectionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can change connection access.", forbiddenSchema),
        404: jsonResponse("Unknown connection.", connectionNotFoundSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(connectionParamsSchema),
    jsonValidator(replaceAccessBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can change connection access.")
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      const body = c.req.valid("json")
      await replaceExternalMcpConnectionAccess({
        organizationId: payload.organization.id,
        connectionId: externalMcpConnectionId,
        access: {
          orgWide: body.access.orgWide,
          memberIds: body.access.memberIds.map((id) => normalizeDenTypeId("member", id)),
          teamIds: body.access.teamIds.map((id) => normalizeDenTypeId("team", id)),
        },
        createdByOrgMembershipId: payload.currentMember.id,
      })
      return c.json(await toConnectionResponse(connection, { callerOrgMembershipId: payload.currentMember.id, includeAccess: true }))
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
    resolveMemberTeamsMiddleware,
    paramValidator(connectionParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { connectionId } = c.req.valid("param")
      const externalMcpConnectionId = normalizeDenTypeId("externalMcpConnection", connectionId)
      const connection = await getExternalMcpConnection({ organizationId: payload.organization.id, connectionId: externalMcpConnectionId })
      if (!connection) {
        return c.json({ error: "connection_not_found", message: "Unknown connection." }, 404)
      }

      if (connection.credentialMode === "shared") {
        // Connecting a shared credential IS the org-level integration setup —
        // admin-only, like creating the connection itself.
        const admin = ensureOrganizationAdmin(c, "Only workspace owners and admins can connect a shared-credential connection.")
        if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      } else {
        // Per-member: any member GRANTED the connection may connect their own
        // account (that is the whole point); admins may too.
        const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
        const isAdmin = ensureOrganizationAdmin(c, "").ok
        const canUse = await memberCanUseExternalMcpConnection({
          connectionId: externalMcpConnectionId,
          orgMembershipId: payload.currentMember.id,
          teamIds: memberTeams.map((team) => team.id),
        })
        if (!canUse && !isAdmin) {
          return c.json({ error: "forbidden", message: "You have not been granted access to this connection." }, 403)
        }
      }

      // Our own signed state token identifies which connection AND which
      // member this is for once the external server redirects back. It MUST
      // travel as the standard OAuth `state` param — a custom param would
      // simply be dropped, since only `state` is guaranteed to round-trip on
      // any spec-compliant authorization server (see ExternalMcpOAuthProvider.state()).
      const signedState = createOAuthStateToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        providerId: connectionId,
        secret: env.betterAuthSecret,
      })
      const redirectUri = callbackRedirectUri(c.req.raw, connectionId)
      const member = connection.credentialMode === "per_member"
        ? { orgMembershipId: payload.currentMember.id }
        : undefined
      const result = await connectExternalMcp(connection, redirectUri, signedState, member)
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
        // For per-member connections, the signed state token (minted at
        // connect/start for the member who initiated) decides whose account
        // the exchanged tokens are saved against.
        const member = connection.credentialMode === "per_member"
          ? { orgMembershipId: statePayload.orgMembershipId }
          : undefined
        await completeExternalMcpAuth(connection, code, callbackRedirectUri(c.req.raw, connectionId), member)
      } catch (error) {
        return c.html(connectCallbackPage({ ok: false, name: connection.name, message: error instanceof Error ? error.message : String(error) }), 400)
      }
      return c.html(connectCallbackPage({ ok: true, name: connection.name }))
    },
  )
}

function connectCallbackPage(input: { ok: true; name: string } | { ok: false; name: string; message: string }): string {
  const title = input.ok ? "Connected" : "Connection failed"
  const openWorkUrl = "openwork://settings/extensions"
  const body = input.ok
    ? `<p>${escapeHtml(input.name)} is connected. You can return to OpenWork now.</p>
      <p><a href="${openWorkUrl}" style="display:inline-block; margin-top:16px; border-radius:10px; background:#0f172a; color:white; padding:10px 14px; text-decoration:none; font-weight:600;">Open OpenWork</a></p>
      <script>setTimeout(() => { window.location.href = "${openWorkUrl}" }, 500)</script>`
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
