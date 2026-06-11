import { expect, test } from "bun:test"
import {
  extractEntraGroupsFromIdToken,
  ensureEntraSsoMembership,
  type EntraSsoMembershipRecord,
  isEntraSsoEnabled,
  mapEntraProfileToUser,
  normalizeEntraTenantId,
  normalizeSsoAssignableRole,
  parseEntraSsoEnv,
  resolveEntraSsoRole,
  validateEntraSsoEnv,
} from "../src/entra-sso.js"

function unsignedJwt(payload: Record<string, unknown>) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url")
  return `eyJhbGciOiJub25lIn0.${encodedPayload}.`
}

test("parses Entra SSO environment into provider and auto-join config", () => {
  const config = parseEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: " 00000000-0000-0000-0000-000000000123 ",
    DEN_ENTRA_CLIENT_ID: " client-123 ",
    DEN_ENTRA_CLIENT_SECRET: " secret-123 ",
    DEN_ENTRA_AUTO_JOIN_ENABLED: "true",
    DEN_ENTRA_AUTO_JOIN_ORG_ID: " organization_123 ",
    DEN_ENTRA_ADMIN_GROUP_IDS: "admin-a, admin-b",
    DEN_ENTRA_MEMBER_GROUP_IDS: "member-a,member-b",
  })

  expect(config).toEqual({
    tenantId: "00000000-0000-0000-0000-000000000123",
    clientId: "client-123",
    clientSecret: "secret-123",
    autoJoinEnabled: true,
    autoJoinOrganizationId: "organization_123",
    autoJoinOrganizationSlug: undefined,
    adminGroupIds: ["admin-a", "admin-b"],
    memberGroupIds: ["member-a", "member-b"],
  })
  expect(isEntraSsoEnabled(config)).toBe(true)
})

test("does not enable provider for multi-tenant aliases, non-GUID, or partial Entra config", () => {
  expect(normalizeEntraTenantId("common")).toBeUndefined()
  expect(normalizeEntraTenantId("organizations")).toBeUndefined()
  expect(normalizeEntraTenantId("consumers")).toBeUndefined()
  expect(normalizeEntraTenantId("tenant-123")).toBeUndefined()
  expect(isEntraSsoEnabled({
    tenantId: normalizeEntraTenantId("common"),
    clientId: "client-123",
    clientSecret: "secret-123",
  })).toBe(false)
  expect(isEntraSsoEnabled({
    tenantId: "00000000-0000-0000-0000-000000000123",
    clientId: "client-123",
  })).toBe(false)
})

test("validates fixed tenant, safe origin, and exact auto-join organization selector", () => {
  expect(validateEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: "organizations",
    DEN_ENTRA_CLIENT_ID: "client-123",
    DEN_ENTRA_CLIENT_SECRET: "secret-123",
    BETTER_AUTH_URL: "http://public.example.com",
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: "*",
    DEN_ENTRA_AUTO_JOIN_ENABLED: "true",
    DEN_ENTRA_AUTO_JOIN_ORG_ID: "organization_123",
    DEN_ENTRA_AUTO_JOIN_ORG_SLUG: "platform",
  }).map((issue) => issue.path)).toEqual([
    "DEN_ENTRA_TENANT_ID",
    "DEN_BETTER_AUTH_TRUSTED_ORIGINS",
    "BETTER_AUTH_URL",
    "DEN_ENTRA_AUTO_JOIN_ORG_ID",
  ])

  expect(validateEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000123",
    DEN_ENTRA_CLIENT_ID: "client-123",
    DEN_ENTRA_CLIENT_SECRET: "secret-123",
    BETTER_AUTH_URL: "http://192.168.1.50:3005",
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: "http://192.168.1.50:3005",
    DEN_ENTRA_AUTO_JOIN_ENABLED: "true",
    DEN_ENTRA_AUTO_JOIN_ORG_SLUG: "platform",
  })).toEqual([])
})

test("rejects public HTTP trusted origins when Entra is enabled", () => {
  expect(validateEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000123",
    DEN_ENTRA_CLIENT_ID: "client-123",
    DEN_ENTRA_CLIENT_SECRET: "secret-123",
    BETTER_AUTH_URL: "https://den.example.com",
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: "http://public.example.com",
  }).map((issue) => issue.path)).toEqual(["DEN_BETTER_AUTH_TRUSTED_ORIGINS"])

  expect(validateEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000123",
    DEN_ENTRA_CLIENT_ID: "client-123",
    DEN_ENTRA_CLIENT_SECRET: "secret-123",
    BETTER_AUTH_URL: "https://den.example.com",
    CORS_ORIGINS: "https://den.example.com,http://public.example.com",
  }).map((issue) => issue.path)).toEqual(["CORS_ORIGINS"])
})

test("allows local and LAN HTTP trusted origins when Entra is enabled", () => {
  expect(validateEntraSsoEnv({
    DEN_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000123",
    DEN_ENTRA_CLIENT_ID: "client-123",
    DEN_ENTRA_CLIENT_SECRET: "secret-123",
    BETTER_AUTH_URL: "http://localhost:3005",
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3005,http://127.0.0.1:3005,http://[::1]:3005,http://192.168.1.50:3005,http://den.company.local:3005",
  })).toEqual([])
})

test("maps Entra role from token groups with admin precedence and no owner assignment", () => {
  expect(resolveEntraSsoRole({
    groups: ["group-admin", "group-member"],
    adminGroupIds: ["group-admin"],
    memberGroupIds: ["group-member"],
  })).toBe("admin")

  expect(resolveEntraSsoRole({
    groups: ["group-member"],
    adminGroupIds: ["group-admin"],
    memberGroupIds: ["group-member"],
  })).toBe("member")

  expect(resolveEntraSsoRole({
    groups: ["unmapped"],
    adminGroupIds: ["group-admin"],
    memberGroupIds: ["group-member"],
  })).toBe("member")

  expect(resolveEntraSsoRole({
    groups: [],
    adminGroupIds: ["group-admin"],
    memberGroupIds: ["group-member"],
  })).toBe("member")

  expect(normalizeSsoAssignableRole("owner")).toBe("member")
})

test("extracts only token groups claim for Entra role mapping", () => {
  const token = unsignedJwt({
    groups: [" group-a ", "group-b", 42, ""],
    roles: ["owner"],
  })

  expect(extractEntraGroupsFromIdToken(token)).toEqual(["group-a", "group-b"])
  expect(extractEntraGroupsFromIdToken(unsignedJwt({ roles: ["admin"] }))).toEqual([])
})

test("maps Entra profile email fallback to preferred username or UPN", () => {
  expect(mapEntraProfileToUser({
    name: "Ada Lovelace",
    preferred_username: "Ada@Example.com",
  })).toEqual({
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
  })

  expect(mapEntraProfileToUser({
    oid: "00000000-0000-0000-0000-000000000001",
  }).email).toBe("00000000-0000-0000-0000-000000000001@entra.local")
})

function createMembershipSeam(existingMember?: EntraSsoMembershipRecord | null) {
  const calls = {
    create: 0,
    update: 0,
    ensureRoles: 0,
    resolveOrganization: 0,
  }
  let member = existingMember ?? null

  return {
    calls,
    get member() {
      return member
    },
    deps: {
      resolveOrganizationId: async () => {
        calls.resolveOrganization += 1
        return "organization_entra"
      },
      getExistingMember: async () => member,
      createMember: async (input: { role: "admin" | "member" }) => {
        calls.create += 1
        member = { id: "member_created", role: input.role }
        return member
      },
      updateMemberRole: async (input: { role: "admin" | "member" }) => {
        calls.update += 1
        member = { id: member?.id ?? "member_updated", role: input.role }
        return member
      },
      ensureDefaultRoles: async () => {
        calls.ensureRoles += 1
      },
      isOwnerRole: (role: string) => role.split(",").includes("owner"),
    },
  }
}

const autoJoinConfig = {
  autoJoinEnabled: true,
  autoJoinOrganizationId: "organization_entra",
  autoJoinOrganizationSlug: undefined,
  adminGroupIds: ["group-admin"],
  memberGroupIds: ["group-member"],
}

test("Microsoft account auto-join creates membership with mapped role", async () => {
  const seam = createMembershipSeam()
  const result = await ensureEntraSsoMembership({
    userId: "user_entra",
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: ["group-admin"] }),
    config: autoJoinConfig,
    deps: seam.deps,
  })

  expect(result.status).toBe("created")
  expect(result.role).toBe("admin")
  expect(seam.member).toEqual({ id: "member_created", role: "admin" })
  expect(seam.calls).toEqual({
    create: 1,
    update: 0,
    ensureRoles: 1,
    resolveOrganization: 1,
  })
})

test("Microsoft account auto-join rejects ambiguous organization selector", async () => {
  const seam = createMembershipSeam()
  const result = await ensureEntraSsoMembership({
    userId: "user_entra",
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: ["group-admin"] }),
    config: {
      ...autoJoinConfig,
      autoJoinOrganizationSlug: "platform",
    },
    deps: seam.deps,
  })

  expect(result.status).toBe("invalid_organization_selector")
  expect(seam.calls).toEqual({
    create: 0,
    update: 0,
    ensureRoles: 0,
    resolveOrganization: 0,
  })
})

test("Microsoft account auto-join updates existing non-owner membership", async () => {
  const seam = createMembershipSeam({ id: "member_existing", role: "member" })
  const result = await ensureEntraSsoMembership({
    userId: "user_entra",
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: ["group-admin"] }),
    config: autoJoinConfig,
    deps: seam.deps,
  })

  expect(result.status).toBe("updated")
  expect(result.role).toBe("admin")
  expect(seam.member).toEqual({ id: "member_existing", role: "admin" })
  expect(seam.calls.create).toBe(0)
  expect(seam.calls.update).toBe(1)
})

test("non-Microsoft provider and email/password paths do not auto-join", async () => {
  const githubSeam = createMembershipSeam()
  const githubResult = await ensureEntraSsoMembership({
    userId: "user_github",
    providerId: "github",
    idToken: unsignedJwt({ groups: ["group-admin"] }),
    config: autoJoinConfig,
    deps: githubSeam.deps,
  })

  const emailPasswordSeam = createMembershipSeam()
  const emailPasswordResult = await ensureEntraSsoMembership({
    userId: "user_password",
    providerId: null,
    idToken: null,
    config: autoJoinConfig,
    deps: emailPasswordSeam.deps,
  })

  expect(githubResult.status).toBe("provider_not_microsoft")
  expect(emailPasswordResult.status).toBe("provider_not_microsoft")
  expect(githubSeam.calls).toEqual({ create: 0, update: 0, ensureRoles: 0, resolveOrganization: 0 })
  expect(emailPasswordSeam.calls).toEqual({ create: 0, update: 0, ensureRoles: 0, resolveOrganization: 0 })
})

test("Microsoft account auto-join preserves existing owner membership", async () => {
  const seam = createMembershipSeam({ id: "member_owner", role: "owner" })
  const result = await ensureEntraSsoMembership({
    userId: "user_owner",
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: ["group-member"] }),
    config: autoJoinConfig,
    deps: seam.deps,
  })

  expect(result.status).toBe("owner_preserved")
  expect(result.role).toBe("owner")
  expect(seam.member).toEqual({ id: "member_owner", role: "owner" })
  expect(seam.calls.create).toBe(0)
  expect(seam.calls.update).toBe(0)
  expect(seam.calls.ensureRoles).toBe(1)
})

test("Microsoft account auto-join preserves existing owner even when admin group matches", async () => {
  const seam = createMembershipSeam({ id: "member_owner", role: "owner,admin" })
  const result = await ensureEntraSsoMembership({
    userId: "user_owner",
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: ["group-admin"] }),
    config: autoJoinConfig,
    deps: seam.deps,
  })

  expect(result.status).toBe("owner_preserved")
  expect(result.role).toBe("owner,admin")
  expect(seam.member).toEqual({ id: "member_owner", role: "owner,admin" })
  expect(seam.calls.create).toBe(0)
  expect(seam.calls.update).toBe(0)
})
