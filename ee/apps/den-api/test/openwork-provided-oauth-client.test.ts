import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, mock, test } from "bun:test"

/**
 * resolveOAuthClient: an org's own saved client always wins; without one, the
 * OpenWork-provided client from DEN_CONNECTOR_* is used for the literal native
 * provider key only. No database is needed — the select chain is mocked.
 */

const selectBatches: Record<string, unknown>[][] = []

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_unused"
  process.env.DB_MODE = "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.DEN_BASE_URL = process.env.DEN_BASE_URL ?? "http://127.0.0.1:8790"
  process.env.OPENWORK_DEV_MODE = "0"
  process.env.PROVISIONER_MODE = "stub"
  process.env.DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_ID = "openwork-google-client.apps.googleusercontent.com"
  process.env.DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_SECRET = "openwork-google-secret"
}

let credentials: typeof import("../src/capability-sources/oauth-credentials.js")
const organizationId = createDenTypeId("organization")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(selectBatches.shift() ?? []),
          }),
        }),
      }),
    },
  }))
  credentials = await import("../src/capability-sources/oauth-credentials.js")
})

describe("resolveOAuthClient", () => {
  test("uses the OpenWork-provided client when the org saved none", async () => {
    selectBatches.push([])
    const client = await credentials.resolveOAuthClient(organizationId, "google-workspace")
    expect(client).toEqual({
      clientId: "openwork-google-client.apps.googleusercontent.com",
      clientSecret: "openwork-google-secret",
      extra: null,
      source: "openwork",
    })
  })

  test("prefers the org's own client, with its features and secret", async () => {
    selectBatches.push([{
      id: createDenTypeId("orgOAuthClient"),
      organizationId,
      providerId: "google-workspace",
      clientId: "org-own-client.apps.googleusercontent.com",
      clientSecret: "org-own-secret",
      extra: JSON.stringify({ features: ["gmailRead"] }),
      createdByOrgMembershipId: createDenTypeId("member"),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }])
    const client = await credentials.resolveOAuthClient(organizationId, "google-workspace")
    expect(client).toEqual({
      clientId: "org-own-client.apps.googleusercontent.com",
      clientSecret: "org-own-secret",
      extra: { features: ["gmailRead"] },
      source: "org",
    })
  })

  test("never falls back for connector rows, other providers, or prototype names", async () => {
    for (const providerId of [createDenTypeId("externalMcpConnection"), "microsoft-365", "constructor", "__proto__"]) {
      selectBatches.push([])
      expect(await credentials.resolveOAuthClient(organizationId, providerId)).toBeNull()
    }
  })

  test("openWorkProvidedOAuthClient exposes only configured providers", () => {
    expect(credentials.openWorkProvidedOAuthClient("google-workspace")?.clientId).toBe("openwork-google-client.apps.googleusercontent.com")
    expect(credentials.openWorkProvidedOAuthClient("microsoft-365")).toBeNull()
    expect(credentials.openWorkProvidedOAuthClient("toString")).toBeNull()
  })
})
