import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const approvedOrigin = "https://web.selfhost.example.test"

// A tiny chainable stand-in for drizzle: every select resolves to the next
// queued result, inserts can be told to fail, and deletes are recorded.
const selectResults: unknown[][] = []
const insertedRows: unknown[] = []
let deleteCount = 0
let insertError: unknown = null

function queuedQuery() {
  const result = selectResults.shift() ?? []
  const query = {
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    limit: () => query,
    orderBy: () => query,
    for: () => query,
    then: <T>(resolve: (value: unknown[]) => T) => Promise.resolve(result).then(resolve),
  }
  return query
}

const fakeDb = {
  select: () => queuedQuery(),
  insert: () => ({
    values: (row: unknown) => {
      if (insertError) return Promise.reject(insertError)
      insertedRows.push(row)
      return Promise.resolve()
    },
  }),
  delete: () => ({
    where: () => {
      deleteCount += 1
      return Promise.resolve()
    },
  }),
  transaction: <T>(run: (tx: typeof fakeDb) => Promise<T>) => run(fakeDb),
}

mock.module("../src/db.js", () => ({ db: fakeDb }))

let webOrigins: typeof import("../src/organization-web-origins.js")
const lookups: Array<{ origin: string; organizationId?: string }> = []
let approved = new Set<string>()
let lookupError: Error | null = null

beforeAll(async () => {
  webOrigins = await import("../src/organization-web-origins.js")
})

beforeEach(() => {
  lookups.length = 0
  approved = new Set([approvedOrigin])
  lookupError = null
  selectResults.length = 0
  insertedRows.length = 0
  deleteCount = 0
  insertError = null
  webOrigins.setWebOriginApprovalLookupForTest(async (input) => {
    lookups.push(input)
    if (lookupError) throw lookupError
    return approved.has(input.origin)
  })
})

afterEach(() => {
  setSystemTime()
})

afterAll(() => {
  webOrigins.setWebOriginApprovalLookupForTest(null)
  mock.restore()
})

describe("exact HTTPS origin normalization", () => {
  test("accepts exact origins and equivalent written forms", async () => {
    const { normalizeExactHttpsOrigin } = await import("@openwork/types/den/organization-web-origins")
    expect(normalizeExactHttpsOrigin(" https://Workspace.Example.test:8787/ ")).toBe("https://workspace.example.test:8787")
    expect(normalizeExactHttpsOrigin("https://workspace.example.test:443")).toBe("https://workspace.example.test")
    expect(normalizeExactHttpsOrigin("https://workspace.example.test")).toBe("https://workspace.example.test")
  })

  test("rejects anything but an exact HTTPS origin", async () => {
    const { normalizeExactHttpsOrigin } = await import("@openwork/types/den/organization-web-origins")
    for (const value of [
      "",
      "workspace.example.test",
      "http://workspace.example.test",
      "https://*.example.test",
      "https://user@workspace.example.test",
      "https://workspace.example.test/signin",
      "https://workspace.example.test/?",
      "https://workspace.example.test?next=1",
      "https://workspace.example.test#top",
      "https://workspace.example.test:443:443",
      `https://${"a".repeat(260)}.example.test`,
    ]) {
      expect(normalizeExactHttpsOrigin(value)).toBeNull()
    }
  })
})

describe("approved web origin CORS cache", () => {
  test("skips the lookup for anything that is not a canonical exact HTTPS origin", async () => {
    for (const origin of [
      "",
      "null",
      "http://web.selfhost.example.test",
      "https://WEB.selfhost.example.test",
      "https://web.selfhost.example.test/",
      "https://web.selfhost.example.test/path",
      "https://web.selfhost.example.test:443",
      "https://*.example.test",
      "https://user@web.selfhost.example.test",
    ]) {
      expect(await webOrigins.isWebOriginApprovedByAnyOrganization(origin)).toBe(false)
      expect(await webOrigins.isWebOriginApprovedForOrganization(organizationId, origin)).toBe(false)
    }
    expect(lookups).toEqual([])
  })

  test("caches positive and negative answers for 30 seconds", async () => {
    setSystemTime(new Date("2026-09-01T00:00:00.000Z"))
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(true)
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")).toBe(false)

    approved = new Set(["https://unknown.example.test"])
    setSystemTime(new Date("2026-09-01T00:00:29.000Z"))
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(true)
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")).toBe(false)
    expect(lookups).toHaveLength(2)

    setSystemTime(new Date("2026-09-01T00:00:31.000Z"))
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(false)
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")).toBe(true)
    expect(lookups).toHaveLength(4)
  })

  test("shares one in-flight lookup between concurrent requests", async () => {
    const results = await Promise.all([1, 2, 3].map(() => webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)))
    expect(results).toEqual([true, true, true])
    expect(lookups).toEqual([{ origin: approvedOrigin }])
  })

  test("does not cache lookup failures", async () => {
    lookupError = new Error("database unavailable")
    await expect(webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).rejects.toThrow("database unavailable")
    lookupError = null
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(true)
    expect(lookups).toHaveLength(2)
  })

  test("invalidation drops one origin or the whole cache", async () => {
    await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)
    await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")
    webOrigins.invalidateWebOriginApprovalCache(approvedOrigin)
    await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)
    await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")
    expect(lookups).toHaveLength(3)

    webOrigins.invalidateWebOriginApprovalCache()
    await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)
    await webOrigins.isWebOriginApprovedByAnyOrganization("https://unknown.example.test")
    expect(lookups).toHaveLength(5)
  })

  test("stays bounded by evicting the oldest entries", async () => {
    for (let index = 0; index <= 2_000; index += 1) {
      await webOrigins.isWebOriginApprovedByAnyOrganization(`https://origin-${index}.example.test`)
    }
    lookups.length = 0
    await webOrigins.isWebOriginApprovedByAnyOrganization("https://origin-2000.example.test")
    expect(lookups).toEqual([])
    await webOrigins.isWebOriginApprovedByAnyOrganization("https://origin-0.example.test")
    expect(lookups).toEqual([{ origin: "https://origin-0.example.test" }])
  })

  test("handoff checks are organization-scoped and never cached", async () => {
    expect(await webOrigins.isWebOriginApprovedForOrganization(organizationId, approvedOrigin)).toBe(true)
    expect(await webOrigins.isWebOriginApprovedForOrganization(organizationId, approvedOrigin)).toBe(true)
    expect(lookups).toEqual([
      { origin: approvedOrigin, organizationId },
      { origin: approvedOrigin, organizationId },
    ])
  })
})

describe("approved web origin storage", () => {
  test("lists origins with the creator name, falling back to email", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z")
    const firstId = createDenTypeId("organizationWebOrigin")
    const secondId = createDenTypeId("organizationWebOrigin")
    const thirdId = createDenTypeId("organizationWebOrigin")
    selectResults.push([
      { id: firstId, origin: approvedOrigin, createdAt, userName: "Owner Example", userEmail: "owner@example.test" },
      { id: secondId, origin: "https://two.example.test", createdAt, userName: " ", userEmail: "admin@example.test" },
      { id: thirdId, origin: "https://three.example.test", createdAt, userName: null, userEmail: null },
    ])
    expect(await webOrigins.listOrganizationWebOrigins(organizationId)).toEqual([
      { id: firstId, origin: approvedOrigin, createdAt, createdByName: "Owner Example" },
      { id: secondId, origin: "https://two.example.test", createdAt, createdByName: "admin@example.test" },
      { id: thirdId, origin: "https://three.example.test", createdAt, createdByName: null },
    ])
  })

  test("approving inserts the origin and clears a cached denial", async () => {
    approved = new Set()
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(false)

    selectResults.push([{ id: organizationId }], [], [{ value: 3 }], [{ name: "Owner Example", email: "owner@example.test" }])
    const result = await webOrigins.approveOrganizationWebOrigin({ organizationId, origin: approvedOrigin, createdByOrgMemberId: memberId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.webOrigin.origin).toBe(approvedOrigin)
    expect(result.webOrigin.id).toStartWith("owo_")
    expect(result.webOrigin.createdByName).toBe("Owner Example")
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toMatchObject({ organizationId, origin: approvedOrigin, createdByOrgMemberId: memberId })

    approved = new Set([approvedOrigin])
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(true)
    expect(lookups).toHaveLength(2)
  })

  test("approving reports duplicates and the per-organization limit", async () => {
    selectResults.push([{ id: organizationId }], [{ id: createDenTypeId("organizationWebOrigin") }])
    expect(await webOrigins.approveOrganizationWebOrigin({ organizationId, origin: approvedOrigin, createdByOrgMemberId: memberId }))
      .toEqual({ ok: false, reason: "already_approved" })

    selectResults.push([{ id: organizationId }], [], [{ value: 20 }])
    expect(await webOrigins.approveOrganizationWebOrigin({ organizationId, origin: approvedOrigin, createdByOrgMemberId: memberId }))
      .toEqual({ ok: false, reason: "limit_reached" })

    selectResults.push([{ id: organizationId }], [], [{ value: 1 }])
    insertError = Object.assign(new Error("insert failed"), { cause: { code: "ER_DUP_ENTRY", errno: 1062 } })
    expect(await webOrigins.approveOrganizationWebOrigin({ organizationId, origin: approvedOrigin, createdByOrgMemberId: memberId }))
      .toEqual({ ok: false, reason: "already_approved" })
    expect(insertedRows).toHaveLength(0)
  })

  test("removing is scoped to the organization and clears the cached approval", async () => {
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(true)

    selectResults.push([])
    expect(await webOrigins.removeOrganizationWebOrigin({ organizationId, id: createDenTypeId("organizationWebOrigin") })).toBeNull()
    expect(deleteCount).toBe(0)

    selectResults.push([{ origin: approvedOrigin }])
    expect(await webOrigins.removeOrganizationWebOrigin({ organizationId, id: createDenTypeId("organizationWebOrigin") })).toBe(approvedOrigin)
    expect(deleteCount).toBe(1)

    approved = new Set()
    expect(await webOrigins.isWebOriginApprovedByAnyOrganization(approvedOrigin)).toBe(false)
    expect(lookups).toHaveLength(2)
  })
})
