/**
 * A sign-in that comes back to Den but does not connect is recorded for the
 * person who tried, so the apps can say why instead of waiting for a
 * connection that will not appear. Only server-written copy is kept, no
 * credential is stored, and the next working sign-in replaces it.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { bootDen, field, list, startFakeOAuthMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen()
const service = await startFakeOAuthMcpServer()
after(async () => {
  await service.close()
  await den.close()
})

const PROVIDER_PROSE = "Workspace integration disabled for fixture tenant"
const TOOLS_UNREADABLE = "The service answered but its tools couldn't be read. Check the connection address and settings."

let orgId = ""
let owner: Member
let sam: Member

before(async () => {
  const created = await den.createOrg(await den.signUp("Olivia Owner"), "Connect failures org")
  orgId = created.orgId
  owner = created.owner
  sam = await den.newMember(owner, orgId, "Sam Member")
})

async function saveOAuthConnection(name: string, credentialMode: "shared" | "per_member"): Promise<string> {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name, url: service.mcpUrl, authType: "oauth", credentialMode, access: { orgWide: true } })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

/** The member clicks Sign in; the browser follows the provider's authorize redirect back toward Den. */
async function providerReply(member: Member, connectionId: string): Promise<URL> {
  const started = await den.as(member, orgId)("GET", `/v1/mcp-connections/${connectionId}/connect/start`)
  assert.equal(started.status, 200, summary(started))
  const redirect = await fetch(text(field(started.body, "authorizeUrl"), "authorize URL"), { redirect: "manual" })
  assert.equal(redirect.status, 302)
  return new URL(text(redirect.headers.get("location"), "provider redirect"))
}

async function land(callback: URL): Promise<number> {
  return (await den.request(null, "GET", `${callback.pathname}${callback.search}`)).status
}

async function rowFor(member: Member, connectionId: string, scope = "") {
  const listed = await den.as(member, orgId)("GET", `/v1/mcp-connections${scope}`)
  assert.equal(listed.status, 200, summary(listed))
  const row = list(field(listed.body, "connections")).find((entry) => entry.id === connectionId)
  assert.ok(row, `connection ${connectionId} missing`)
  return row
}

async function storedCredentials(connectionId: string) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("storedCredentials needs MySQL mode")
  const [rows] = await client.execute(
    "SELECT access_token IS NOT NULL AS has_access, refresh_token IS NOT NULL AS has_refresh FROM connected_account WHERE provider_id = ?",
    [connectionId],
  )
  return JSON.parse(JSON.stringify(rows))
}

test("a sign-in the service refuses after authorization is recorded for that member, with a fixed reason and no credential", async () => {
  const id = await saveOAuthConnection("Refusing Notes", "per_member")
  service.refuseMcp({ status: 400, body: { error_code: -32000, error_message: PROVIDER_PROSE } })
  assert.equal(await land(await providerReply(sam, id)), 400)

  const row = await rowFor(sam, id)
  assert.equal(row.connectedForMe, false)
  const readiness = field(row, "readiness")
  assert.equal(field(readiness, "status"), "could_not_verify")
  assert.equal(field(readiness, "failure"), "tools_unreadable")
  assert.equal(field(readiness, "reason"), TOOLS_UNREADABLE)
  assert.equal(typeof field(readiness, "referenceId"), "string")
  assert.equal(field(readiness, "providerSettingsUrl"), undefined)
  assert.ok(!JSON.stringify(row).includes(PROVIDER_PROSE), "provider prose never reaches the list")
  assert.deepEqual(await storedCredentials(id), [{ has_access: 0, has_refresh: 0 }])

  // Nobody else inherits one member's failed sign-in.
  assert.equal(field(await rowFor(owner, id), "readiness"), null)

  // The next working sign-in replaces it.
  service.refuseMcp(null)
  assert.equal(await land(await providerReply(sam, id)), 200)
  const connected = await rowFor(sam, id)
  assert.equal(connected.connectedForMe, true)
  assert.equal(field(connected, "readiness", "status"), "ready")
  assert.equal(field(connected, "readiness", "failure"), null)
})

test("declining consent at the provider is recorded as a sign-in the person can retry", async () => {
  const id = await saveOAuthConnection("Declined Notes", "per_member")
  const reply = await providerReply(sam, id)
  reply.searchParams.delete("code")
  reply.searchParams.set("error", "access_denied")
  assert.equal(await land(reply), 400)

  const row = await rowFor(sam, id)
  assert.equal(row.connectedForMe, false)
  assert.equal(field(row, "readiness", "failure"), "sign_in_rejected")
  assert.equal(field(row, "readiness", "reason"), "The service rejected the sign-in. Sign in again.")
})

test("a failed re-sign-in does not hide a connection that still works", async () => {
  const id = await saveOAuthConnection("Working Notes", "per_member")
  // Two sign-ins started from two windows; the second one finishes first.
  const reply = await providerReply(sam, id)
  assert.equal(await land(await providerReply(sam, id)), 200)
  reply.searchParams.delete("code")
  reply.searchParams.set("error", "access_denied")
  assert.equal(await land(reply), 400)

  const row = await rowFor(sam, id)
  assert.equal(row.connectedForMe, true)
  assert.equal(field(row, "readiness", "status"), "ready")
})

test("an admin's refused shared sign-in is recorded on the connection", async () => {
  const id = await saveOAuthConnection("Shared Refusing Notes", "shared")
  service.refuseMcp({ status: 400, body: { error_code: -32000, error_message: PROVIDER_PROSE } })
  try {
    assert.equal(await land(await providerReply(owner, id)), 400)
  } finally {
    service.refuseMcp(null)
  }
  const row = await rowFor(owner, id, "?scope=manageable")
  assert.equal(row.connected, false)
  assert.equal(field(row, "organizationReadiness", "failure"), "tools_unreadable")
  assert.equal(field(row, "organizationReadiness", "reason"), TOOLS_UNREADABLE)
})

test("Slack's MCP-access refusal is recorded with its own direction and a validated settings link", async () => {
  const { ExternalMcpDiagnosticTracker, createExternalMcpDiagnosticFetch } = await import("../../src/capability-sources/external-mcp-diagnostics.js")
  const { recordFailedConnectAttempt } = await import("../../src/capability-sources/external-mcp-readiness.js")
  const { getExternalMcpConnection } = await import("../../src/capability-sources/external-mcp-connections.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")

  // Slack's refusal, produced by the real MCP SDK against Slack's endpoint. The app id is synthetic.
  const endpoint = "https://mcp.slack.com/mcp"
  const settingsUrl = "https://api.slack.com/apps/AFIXTURE123/app-assistant"
  const tracker = new ExternalMcpDiagnosticTracker("ref-slack-fixture")
  const client = new Client({ name: "den-api-test", version: "1" })
  tracker.begin("MCP_INITIALIZE")
  const failure = await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: createExternalMcpDiagnosticFetch({
      endpoint,
      tracker,
      fetch: async () => new Response(JSON.stringify({
        error_code: -32600,
        error_message: `App is not enabled for Slack MCP server access. Please enable it here: ${settingsUrl}`,
      }), { status: 400, headers: { "content-type": "application/json" } }),
    }),
  })).then(() => null, (error: unknown) => error)
  await client.close().catch(() => undefined)
  const diagnostic = tracker.error(failure, "MCP_INITIALIZE").diagnostic

  const id = await saveOAuthConnection("Slack Fixture", "per_member")
  const connection = await getExternalMcpConnection({ organizationId: normalizeDenTypeId("organization", orgId), connectionId: normalizeDenTypeId("externalMcpConnection", id) })
  assert.ok(connection)
  assert.equal(await recordFailedConnectAttempt({ connection, memberId: normalizeDenTypeId("member", sam.memberId), diagnostic }), true)

  const row = await rowFor(sam, id)
  assert.equal(row.connectedForMe, false)
  assert.equal(field(row, "readiness", "status"), "could_not_verify")
  assert.equal(field(row, "readiness", "failure"), "provider_setup_required")
  assert.equal(
    field(row, "readiness", "reason"),
    "The Slack app for this connection doesn't have MCP access turned on. In the Slack app's settings, open Agents and turn on MCP, then connect again.",
  )
  assert.equal(field(row, "readiness", "providerSettingsUrl"), settingsUrl)
  assert.equal(field(row, "readiness", "referenceId"), "ref-slack-fixture")
  assert.deepEqual(await storedCredentials(id), [{ has_access: 0, has_refresh: 0 }])
})
