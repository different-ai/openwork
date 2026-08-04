import { beforeAll, beforeEach, expect, mock, test } from "bun:test"

type QueryRow = Record<string, unknown>

let queryRows: QueryRow[] = []
let fromTable: unknown = null
let joinedTables: unknown[] = []
let findEnterpriseAuthRequirementForEmailDomain: typeof import("../src/enterprise-auth-requirement.js").findEnterpriseAuthRequirementForEmailDomain
let resolveNonSsoSignInMethodForEmail: typeof import("../src/enterprise-auth-requirement.js").resolveNonSsoSignInMethodForEmail
let schema: typeof import("@openwork-ee/den-db/schema")

function createQueryBuilder() {
  const builder = {
    from(table: unknown) {
      fromTable = table
      return builder
    },
    innerJoin(table: unknown) {
      joinedTables.push(table)
      return builder
    },
    where() {
      return Promise.resolve(queryRows)
    },
    then<TResult1 = QueryRow[], TResult2 = never>(
      onfulfilled?: ((value: QueryRow[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(queryRows).then(onfulfilled, onrejected)
    },
  }
  return builder
}

mock.module("../src/db.js", () => ({
  db: {
    select: () => createQueryBuilder(),
  },
}))

beforeAll(async () => {
  const [schemaModule, requirementModule] = await Promise.all([
    import("@openwork-ee/den-db/schema"),
    import("../src/enterprise-auth-requirement.js"),
  ])
  schema = schemaModule
  findEnterpriseAuthRequirementForEmailDomain = requirementModule.findEnterpriseAuthRequirementForEmailDomain
  resolveNonSsoSignInMethodForEmail = requirementModule.resolveNonSsoSignInMethodForEmail
})

beforeEach(() => {
  queryRows = []
  fromTable = null
  joinedTables = []
})

test("domain-based SSO resolution does not query through users or members", async () => {
  queryRows = [{
    organizationId: "organization_sso_domain",
    organizationSlug: "verified-sso",
    signInPath: "/sso/verified-sso",
    ssoProviderId: "openwork-sso-organization_sso_domain",
  }]

  const realMember = await findEnterpriseAuthRequirementForEmailDomain("real-user@verified.example.test")
  const fakeMember = await findEnterpriseAuthRequirementForEmailDomain("fake-user@verified.example.test")

  expect(realMember).toEqual(fakeMember)
  expect(realMember).toEqual({
    organizationId: "organization_sso_domain",
    organizationSlug: "verified-sso",
    signInPath: "/sso/verified-sso",
    ssoProviderId: "openwork-sso-organization_sso_domain",
    hasSso: true,
  })
  expect(fromTable).toBe(schema.OrganizationTable)
  expect(joinedTables).toContain(schema.SsoConnectionTable)
  expect(joinedTables).toContain(schema.SsoProviderTable)
  expect(joinedTables).not.toContain(schema.AuthUserTable)
  expect(joinedTables).not.toContain(schema.MemberTable)
})

test("domain-based SSO resolution ignores invalid email domains", async () => {
  const requirement = await findEnterpriseAuthRequirementForEmailDomain("not-an-email")

  expect(requirement).toBeNull()
  expect(fromTable).toBeNull()
})

test("non-SSO sign-in method routing returns only google, password, or signup", async () => {
  queryRows = [{ providerId: "google", password: null }]
  await expect(resolveNonSsoSignInMethodForEmail("google@example.test")).resolves.toBe("google")

  queryRows = [{ providerId: "credential", password: "hash" }]
  await expect(resolveNonSsoSignInMethodForEmail("password@example.test")).resolves.toBe("password")

  queryRows = []
  await expect(resolveNonSsoSignInMethodForEmail("unknown@example.test")).resolves.toBe("signup")
})
