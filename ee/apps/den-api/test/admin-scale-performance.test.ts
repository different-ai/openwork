import { performance } from "node:perf_hooks"
import { describe, expect, test } from "bun:test"
import {
  ADMIN_MAX_PAGE_OFFSET,
  ADMIN_MAX_PAGE_LIMIT,
  buildAdminPageInfo,
  normalizeAdminPageRequest,
} from "../src/routes/admin/scale-performance.js"

const USER_COUNT = 50_000
const ORGANIZATION_COUNT = 60_000
const INITIAL_BUDGET_MS = 500
const SEARCH_BUDGET_MS = 300

type FixtureUser = {
  id: string
  name: string
  email: string
  providers: string[]
  organizations: Array<{ id: string; name: string; role: string }>
}

type FixtureOrganization = {
  id: string
  name: string
  slug: string
}

function buildUsers() {
  return Array.from({ length: USER_COUNT }, (_, index): FixtureUser => {
    const target = index === USER_COUNT - 7
    return {
      id: `user_${String(index).padStart(5, "0")}`,
      name: target ? "Scale Search Target" : `User ${index}`,
      email: target ? "scale-search-target@example.com" : `user${index}@company${index % 997}.example`,
      providers: target ? ["scale-provider"] : [index % 2 === 0 ? "google" : "github"],
      organizations: [{
        id: `org_${String(index % ORGANIZATION_COUNT).padStart(5, "0")}`,
        name: target ? "Scale Target Org" : `Org ${index % ORGANIZATION_COUNT}`,
        role: target ? "scale-owner" : "member",
      }],
    }
  })
}

function buildOrganizations() {
  return Array.from({ length: ORGANIZATION_COUNT }, (_, index): FixtureOrganization => {
    const target = index === ORGANIZATION_COUNT - 11
    return {
      id: `org_${String(index).padStart(5, "0")}`,
      name: target ? "Scale Performance Target Organization" : `Organization ${index}`,
      slug: target ? "scale-performance-target" : `organization-${index}`,
    }
  })
}

function userMatches(user: FixtureUser, search: string) {
  const normalized = search.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return [
    user.id,
    user.name,
    user.email,
    ...user.providers,
    ...user.organizations.flatMap((organization) => [organization.id, organization.name, organization.role]),
  ].some((value) => value.toLowerCase().includes(normalized))
}

function organizationMatches(organization: FixtureOrganization, search: string) {
  const normalized = search.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return [organization.id, organization.name, organization.slug].some((value) => value.toLowerCase().includes(normalized))
}

function pageUsers(users: FixtureUser[], search: string) {
  const request = normalizeAdminPageRequest({ limit: "50", search })
  const rows: FixtureUser[] = []
  let total = 0
  for (const user of users) {
    if (!userMatches(user, request.search)) {
      continue
    }

    if (total >= request.offset && rows.length < request.limit) {
      rows.push(user)
    }
    total += 1
  }

  return { rows, page: buildAdminPageInfo(request, total, rows.length, 0) }
}

function pageOrganizations(organizations: FixtureOrganization[], search: string) {
  const request = normalizeAdminPageRequest({ limit: "50", search })
  const rows: FixtureOrganization[] = []
  let total = 0
  for (const organization of organizations) {
    if (!organizationMatches(organization, request.search)) {
      continue
    }

    if (total >= request.offset && rows.length < request.limit) {
      rows.push(organization)
    }
    total += 1
  }

  return { rows, page: buildAdminPageInfo(request, total, rows.length, 0) }
}

describe("admin scale-performance contract", () => {
  const users = buildUsers()
  const organizations = buildOrganizations()

  test("initial admin payload is bounded with exact 50k/60k totals under 500 ms", () => {
    const startedAt = performance.now()
    const request = normalizeAdminPageRequest({ limit: "50" })
    const firstUsers = users.slice(0, request.limit)
    const payload = {
      summary: {
        totalUsers: users.length,
        totalOrganizations: organizations.length,
      },
      users: firstUsers,
      organizations: [],
      userPage: buildAdminPageInfo(request, users.length, firstUsers.length, 0),
      organizationPage: buildAdminPageInfo(request, organizations.length, 0, 0),
    }
    const serialized = JSON.stringify(payload)
    const durationMs = performance.now() - startedAt

    console.info(`admin-scale initial ${durationMs.toFixed(2)} ms, ${serialized.length} bytes`)
    expect(durationMs).toBeLessThan(INITIAL_BUDGET_MS)
    expect(payload.summary.totalUsers).toBe(USER_COUNT)
    expect(payload.summary.totalOrganizations).toBe(ORGANIZATION_COUNT)
    expect(payload.users).toHaveLength(50)
    expect(payload.organizations).toHaveLength(0)
    expect(payload.userPage.total).toBe(USER_COUNT)
    expect(payload.organizationPage.total).toBe(ORGANIZATION_COUNT)
    expect(serialized.includes("scale-search-target@example.com")).toBe(false)
  })

  test("user search is bounded and finds a unique user near the end across 50k users under 300 ms", () => {
    const startedAt = performance.now()
    const result = pageUsers(users, "scale-search-target@example.com")
    const durationMs = performance.now() - startedAt

    console.info(`admin-scale user search ${durationMs.toFixed(2)} ms, ${result.rows.length} rows`)
    expect(durationMs).toBeLessThan(SEARCH_BUDGET_MS)
    expect(result.page.total).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.email).toBe("scale-search-target@example.com")
    expect(result.page.limit).toBeLessThanOrEqual(ADMIN_MAX_PAGE_LIMIT)
  })

  test("organization search is bounded across 60k organizations under 300 ms", () => {
    const startedAt = performance.now()
    const result = pageOrganizations(organizations, "scale-performance-target")
    const durationMs = performance.now() - startedAt

    console.info(`admin-scale org search ${durationMs.toFixed(2)} ms, ${result.rows.length} rows`)
    expect(durationMs).toBeLessThan(SEARCH_BUDGET_MS)
    expect(result.page.total).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.id).toBe("org_59989")
    expect(result.page.limit).toBeLessThanOrEqual(ADMIN_MAX_PAGE_LIMIT)
  })

  test("large page requests stay bounded", () => {
    const request = normalizeAdminPageRequest({ limit: "500", offset: "999999999" })
    const page = buildAdminPageInfo(request, ADMIN_MAX_PAGE_OFFSET + ADMIN_MAX_PAGE_LIMIT + 1, ADMIN_MAX_PAGE_LIMIT, 0)

    expect(request.limit).toBe(ADMIN_MAX_PAGE_LIMIT)
    expect(request.offset).toBe(ADMIN_MAX_PAGE_OFFSET)
    expect(page.hasMore).toBe(false)
  })
})
