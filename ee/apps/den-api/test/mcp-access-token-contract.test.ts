import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const API_ORIGIN = "http://127.0.0.1:8790"
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const denApiRoot = path.join(repoRoot, "ee/apps/den-api")

function runContractProbe() {
  const script = `
const crypto = await import("node:crypto")
const { mock } = await import("bun:test")
const schema = await import("@openwork-ee/den-db/schema")
const { createDenTypeId } = await import("@openwork-ee/utils/typeid")

const apiOrigin = process.env.API_ORIGIN
if (!apiOrigin) throw new Error("Missing API_ORIGIN")

const agentResource = apiOrigin + "/mcp/agent"
const parentResource = apiOrigin + "/mcp"
const tokenUseClaim = "https://openworklabs.com/token_use"
const resourceClaim = "https://openworklabs.com/resource"
const orgIdClaim = "https://openworklabs.com/org_id"
const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const sessionId = createDenTypeId("session")
const memberId = createDenTypeId("member")
const firstPartyClientId = "openwork-desktop"
const opaqueSecret = "opaque_mcp_contract_secret"
const opaqueToken = "ow_mcp_at_" + opaqueSecret
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519")
const publicJwk = publicKey.export({ format: "jwk" })
publicJwk.alg = "EdDSA"
publicJwk.use = "sig"
publicJwk.kid = "mcp-contract-key"

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function signJwt(overrides) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: userId,
    aud: agentResource,
    azp: "client_mcp_contract",
    scope: "mcp:read mcp:write",
    sid: sessionId,
    iss: apiOrigin + "/api/auth",
    iat: now,
    exp: now + 900,
    [tokenUseClaim]: "mcp",
    [resourceClaim]: agentResource,
    [orgIdClaim]: organizationId,
    ...overrides,
  }
  const encodedHeader = base64urlJson({ alg: "EdDSA", kid: publicJwk.kid, typ: "JWT" })
  const encodedPayload = base64urlJson(payload)
  const signingInput = encodedHeader + "." + encodedPayload
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")
  return signingInput + "." + signature
}

mock.module("./src/auth.js", () => ({
  auth: {
    handler: () => Promise.resolve(Response.json({ keys: [publicJwk] })),
  },
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: firstPartyClientId,
  DEN_MCP_FIRST_PARTY_RESOURCES: [parentResource, agentResource, parentResource + "/admin"],
  DEN_MCP_ORG_ID_CLAIM: orgIdClaim,
  DEN_MCP_OAUTH_RESOURCE: agentResource,
  DEN_MCP_RESOURCE: parentResource,
  DEN_MCP_RESOURCE_CLAIM: resourceClaim,
  DEN_MCP_RESOURCES: [agentResource, parentResource, parentResource + "/admin"],
  DEN_MCP_TOKEN_USE_CLAIM: tokenUseClaim,
}))

function hashOpaqueMcpSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("base64url")
}

const db = {
  update: () => ({
    set: () => ({
      where: () => Promise.resolve(),
    }),
  }),
  select: () => ({
    from: (table) => ({
      where: () => ({
        limit: () => {
          if (table === schema.OAuthAccessTokenTable) {
            return Promise.resolve([{
              token: hashOpaqueMcpSecret(opaqueSecret),
              clientId: firstPartyClientId,
              userId,
              sessionId,
              referenceId: organizationId,
              expiresAt: new Date(Date.now() + 900_000),
              createdAt: new Date(Date.now() - 1_000),
              scopes: JSON.stringify(["mcp:read"]),
            }])
          }
          if (table === schema.AuthSessionTable) {
            return Promise.resolve([{ id: sessionId }])
          }
          if (table === schema.MemberTable) {
            return Promise.resolve([{ id: memberId }])
          }
          return Promise.resolve([])
        },
      }),
    }),
  }),
}

mock.module("./src/db.js", () => ({ db }))

const { verifyMcpRequest } = await import("./src/mcp/auth.js")

function agentContext(requestId) {
  return {
    route: "agent",
    resourceUrl: agentResource,
    metadataUrl: apiOrigin + "/.well-known/oauth-protected-resource/mcp/agent",
    oauthResources: [agentResource],
    firstPartyResources: [parentResource, agentResource, parentResource + "/admin"],
    requestId,
  }
}

function parentContext(requestId) {
  return {
    route: "mcp",
    resourceUrl: parentResource,
    metadataUrl: apiOrigin + "/.well-known/oauth-protected-resource/mcp",
    oauthResources: [],
    firstPartyResources: [parentResource, agentResource, parentResource + "/admin"],
    requestId,
  }
}

function adminContext(requestId) {
  return {
    route: "admin",
    resourceUrl: parentResource,
    metadataUrl: apiOrigin + "/.well-known/oauth-protected-resource/mcp",
    oauthResources: [],
    firstPartyResources: [parentResource, agentResource, parentResource + "/admin"],
    requestId,
  }
}

async function expectError(name, token, context, expected) {
  const response = await verifyMcpRequest(new Headers({ authorization: "Bearer " + token }), context)
  if (!(response instanceof Response)) throw new Error(name + " unexpectedly succeeded")
  const body = await response.json()
  if (response.status !== expected.status || body.error !== expected.error) {
    throw new Error(name + " got " + JSON.stringify({ status: response.status, body }))
  }
}

async function expectPrincipal(name, token, context) {
  const principal = await verifyMcpRequest(new Headers({ authorization: "Bearer " + token }), context)
  if (principal instanceof Response) {
    throw new Error(name + " failed with " + JSON.stringify(await principal.json()))
  }
}

await expectError("mismatched custom resource claim", signJwt({ [resourceClaim]: parentResource }), agentContext("req_mismatch"), {
  status: 401,
  error: "wrong_mcp_resource",
})

await expectError("parent audience", signJwt({ aud: parentResource, [resourceClaim]: parentResource }), agentContext("req_parent_aud"), {
  status: 401,
  error: "invalid_mcp_token",
})

await expectError("multi audience", signJwt({ aud: [agentResource, parentResource] }), agentContext("req_multi_aud"), {
  status: 401,
  error: "wrong_mcp_resource",
})

await expectPrincipal(
  "OAuth token with standard userinfo audience",
  signJwt({ aud: [agentResource, apiOrigin + "/api/auth/oauth2/userinfo"] }),
  agentContext("req_userinfo_aud"),
)

await expectError("agent JWT on parent route", signJwt({}), parentContext("req_exact_agent_parent"), {
  status: 401,
  error: "wrong_mcp_resource",
})

await expectError("agent JWT on admin route", signJwt({}), adminContext("req_exact_agent_admin"), {
  status: 401,
  error: "wrong_mcp_resource",
})

for (const entry of [
  { name: "agent", context: agentContext("req_opaque_agent") },
  { name: "parent", context: parentContext("req_opaque_parent") },
  { name: "admin", context: adminContext("req_opaque_admin") },
]) {
  const opaquePrincipal = await verifyMcpRequest(new Headers({ authorization: "Bearer " + opaqueToken }), entry.context)
  if (opaquePrincipal instanceof Response) {
    throw new Error("first-party opaque token failed on " + entry.name + " with " + JSON.stringify(await opaquePrincipal.json()))
  }
  if (opaquePrincipal.userId !== userId || opaquePrincipal.organizationId !== organizationId) {
    throw new Error("first-party opaque token returned the wrong principal on " + entry.name)
  }
}

console.log("ok")
`

  const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", script], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: API_ORIGIN,
      DEN_API_PUBLIC_URL: API_ORIGIN,
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      DEN_MCP_RESOURCE_URL: "",
      DEN_MCP_ADDITIONAL_RESOURCES: "",
      DEN_WEB_APP_HOSTS: "",
      API_ORIGIN,
    },
  })

  if (result.status !== 0) {
    throw new Error([
      "MCP access-token contract probe failed",
      `status: ${result.status}`,
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
    ].join("\n"))
  }
  expect(result.stdout).toContain("ok")
}

test("MCP access-token verification enforces JWT audience and first-party opaque compatibility", () => {
  runContractProbe()
})
