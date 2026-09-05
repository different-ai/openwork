import { expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { contributeMcpGrantClaim } from "../src/mcp/grant-claims.js"
import {
  assertLiveMcpRefreshGrant,
  McpRefreshGrantRevokedError,
  type McpRefreshGrantRow,
} from "../src/mcp/refresh-grant-liveness.js"

const GRANT_CLAIM = "https://openworklabs.com/grant_id"

function refreshGrant(sessionId: string | null): McpRefreshGrantRow {
  return {
    sessionId,
    clientId: "client_mcp_grant_policy",
    userId: createDenTypeId("user"),
    referenceId: createDenTypeId("organization"),
  }
}

test("access-token claims stamp exactly the durable consent id, never the session id", async () => {
  const consentId = createDenTypeId("oauthConsent")
  const sessionId = createDenTypeId("session")
  const claims = await contributeMcpGrantClaim({
    claimName: GRANT_CLAIM,
    clientId: "client_mcp_claim",
    userId: createDenTypeId("user"),
    referenceId: createDenTypeId("organization"),
    findConsent: () => Promise.resolve({ id: consentId }),
  })

  expect(claims).toEqual({ [GRANT_CLAIM]: consentId })
  expect(Object.values(claims)).not.toContain(sessionId)
  expect(JSON.stringify(claims)).not.toContain("session")
})

test("access-token claims omit grant identity when no consent exists", async () => {
  const claims = await contributeMcpGrantClaim({
    claimName: GRANT_CLAIM,
    clientId: "client_mcp_claim",
    userId: createDenTypeId("user"),
    referenceId: createDenTypeId("organization"),
    findConsent: () => Promise.resolve(null),
  })

  expect(claims).toEqual({})
  expect(claims[GRANT_CLAIM]).toBeUndefined()
})

test("refresh survives a dead session while its consent remains live", async () => {
  const deletedFamilies: string[] = []
  let consentChecks = 0
  await assertLiveMcpRefreshGrant({
    grant: refreshGrant(createDenTypeId("session")),
    getSessionLiveness: () => Promise.resolve("missing"),
    findConsent: () => {
      consentChecks += 1
      return Promise.resolve({ id: createDenTypeId("oauthConsent") })
    },
    deleteGrantFamily: (sessionId) => {
      deletedFamilies.push(sessionId)
      return Promise.resolve()
    },
  })

  expect(consentChecks).toBe(1)
  expect(deletedFamilies).toEqual([])
})

test("refresh rejects a dead session after consent deletion and clears its family", async () => {
  const sessionId = createDenTypeId("session")
  const deletedFamilies: string[] = []
  const promise = assertLiveMcpRefreshGrant({
    grant: refreshGrant(sessionId),
    getSessionLiveness: () => Promise.resolve("missing"),
    findConsent: () => Promise.resolve(null),
    deleteGrantFamily: (deletedSessionId) => {
      deletedFamilies.push(deletedSessionId)
      return Promise.resolve()
    },
  })

  await expect(promise).rejects.toBeInstanceOf(McpRefreshGrantRevokedError)
  expect(deletedFamilies).toEqual([sessionId])
})

test("sessionless refresh rows remain exempt from liveness checks", async () => {
  let sessionChecks = 0
  let consentChecks = 0
  let familyDeletes = 0
  await assertLiveMcpRefreshGrant({
    grant: refreshGrant(null),
    getSessionLiveness: () => {
      sessionChecks += 1
      return Promise.resolve("missing")
    },
    findConsent: () => {
      consentChecks += 1
      return Promise.resolve(null)
    },
    deleteGrantFamily: () => {
      familyDeletes += 1
      return Promise.resolve()
    },
  })

  expect(sessionChecks).toBe(0)
  expect(consentChecks).toBe(0)
  expect(familyDeletes).toBe(0)
})

test("refresh liveness check failures fail open without consent checks or cleanup", async () => {
  let consentChecks = 0
  let familyDeletes = 0
  await assertLiveMcpRefreshGrant({
    grant: refreshGrant(createDenTypeId("session")),
    getSessionLiveness: () => Promise.resolve("check_failed"),
    findConsent: () => {
      consentChecks += 1
      return Promise.resolve(null)
    },
    deleteGrantFamily: () => {
      familyDeletes += 1
      return Promise.resolve()
    },
  })

  expect(consentChecks).toBe(0)
  expect(familyDeletes).toBe(0)
})
