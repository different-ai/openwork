import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv(): void {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

seedRequiredEnv()

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let store: typeof import("../src/routes/org/plugin-system/store.js")

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const marketplaceId = createDenTypeId("marketplace")
const pluginId = createDenTypeId("plugin")
const legacyPluginId = createDenTypeId("plugin")
const oldestLegacyPluginId = createDenTypeId("plugin")
const marketplacePluginId = createDenTypeId("marketplacePlugin")

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/routes/org/plugin-system/store.js"),
  ])
  db = modules[0].db
  schema = modules[1]
  drizzle = modules[2]
  store = modules[3]

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "GitHub import publication fence user",
    email: `github-import-fence+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "GitHub import publication fence org",
    slug: `github-import-fence-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "admin",
  })
  await db.insert(schema.MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "GitHub import publication fence marketplace",
    createdByOrgMembershipId: memberId,
  })
})

afterAll(async () => {
  await db.delete(schema.MarketplacePluginTable).where(drizzle.eq(schema.MarketplacePluginTable.organizationId, organizationId))
  await db.delete(schema.PluginImportSourceTable).where(drizzle.eq(schema.PluginImportSourceTable.organizationId, organizationId))
  await db.delete(schema.PluginTable).where(drizzle.eq(schema.PluginTable.organizationId, organizationId))
  await db.delete(schema.MarketplaceTable).where(drizzle.eq(schema.MarketplaceTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
})

describe("GitHub import publication fence", () => {
  test("serializes final publication and rejects a concurrent duplicate canonical source", async () => {
    const canonicalGithubUrl = "https://github.com/example/marketplace/tree/main/support"
    let markFirstReady = () => {}
    let releaseFirst = () => {}
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve
    })
    const firstCanCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const firstPublication = db.transaction(async (tx) => {
      await store.assertGithubImportPublicationAvailable({
        canonicalGithubUrl,
        organizationId,
        tx,
      })
      await tx.insert(schema.PluginTable).values({
        id: pluginId,
        organizationId,
        name: "Support",
        description: store.githubImportedPluginDescription(canonicalGithubUrl),
        status: "active",
        createdByOrgMembershipId: memberId,
      })
      await tx.insert(schema.PluginImportSourceTable).values({
        pluginId,
        organizationId,
        provider: "github",
        canonicalSourceKey: store.githubPluginImportSourceKey(canonicalGithubUrl),
        canonicalSourceUrl: canonicalGithubUrl,
        sourceRevisionRef: "0123456789abcdef0123456789abcdef01234567",
        createdByOrgMembershipId: memberId,
      })
      await tx.insert(schema.MarketplacePluginTable).values({
        id: marketplacePluginId,
        organizationId,
        marketplaceId,
        pluginId,
        membershipSource: "api",
        createdByOrgMembershipId: memberId,
      })
      markFirstReady()
      await firstCanCommit
    })

    await firstReady
    const competingPublication = db.transaction(async (tx) => {
      await store.assertGithubImportPublicationAvailable({
        canonicalGithubUrl,
        organizationId,
        tx,
      })
    })
    releaseFirst()
    await firstPublication

    try {
      await competingPublication
      throw new Error("expected the duplicate publication to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(store.PluginArchRouteFailure)
      expect((error as InstanceType<typeof store.PluginArchRouteFailure>).error).toBe("github_plugin_already_imported")
    }

    const published = await db
      .select({ id: schema.PluginTable.id })
      .from(schema.PluginTable)
      .where(drizzle.and(
        drizzle.eq(schema.PluginTable.organizationId, organizationId),
        drizzle.eq(schema.PluginTable.description, store.githubImportedPluginDescription(canonicalGithubUrl)),
        drizzle.eq(schema.PluginTable.status, "active"),
      ))
    expect(published).toEqual([{ id: pluginId }])

    // The source claim is immutable and independent from mutable plugin and
    // marketplace state. Archiving, renaming, or detaching must direct the
    // admin back to restoration instead of allowing a second import.
    await db.update(schema.PluginTable).set({
      description: "Renamed after import",
      status: "archived",
    }).where(drizzle.eq(schema.PluginTable.id, pluginId))
    await db.update(schema.MarketplacePluginTable).set({ removedAt: new Date() })
      .where(drizzle.eq(schema.MarketplacePluginTable.id, marketplacePluginId))
    await expect(db.transaction(async (tx) => {
      await store.assertGithubImportPublicationAvailable({ canonicalGithubUrl, organizationId, tx })
    })).rejects.toMatchObject({ error: "github_plugin_already_imported" })

    // GitHub refs and paths are case-sensitive. The identity comparison must
    // not inherit the database's case-insensitive text collation.
    await db.transaction(async (tx) => {
      await store.assertGithubImportPublicationAvailable({
        canonicalGithubUrl: "https://github.com/example/marketplace/tree/main/Support",
        organizationId,
        tx,
      })
    })
  })

  test("adopts pre-provenance imports into the durable source fence", async () => {
    const now = new Date()
    const canonicalGithubUrl = "https://github.com/example/legacy-marketplace/tree/main/support"
    const sourceRevisionRef = "0123456789abcdef0123456789abcdef01234567"
    await db.insert(schema.PluginTable).values({
      createdByOrgMembershipId: memberId,
      description: `Plugin components imported from example/legacy-marketplace/support at immutable GitHub revision ${sourceRevisionRef}.`,
      id: legacyPluginId,
      name: "Legacy support",
      organizationId,
      status: "archived",
    })

    const context = {
      memberTeams: [],
      organizationContext: {
        currentMember: {
          createdAt: now,
          id: memberId,
          isOwner: false,
          joinedAt: now,
          role: "admin",
          userId,
        },
        invitations: [],
        members: [],
        organization: {
          allowedEmailDomains: null,
          createdAt: now,
          id: organizationId,
          logo: null,
          metadata: null,
          name: "GitHub import publication fence org",
          slug: `github-import-fence-${organizationId}`,
          updatedAt: now,
        },
        roles: [],
        teams: [],
      },
      session: { createdAt: now },
    } satisfies Parameters<typeof store.claimLegacyGithubImportSource>[0]["context"]
    const plan = {
      branch: "main",
      classification: "claude_single_plugin_repo",
      marketplace: null,
      plugins: [],
      repositoryFullName: "example/legacy-marketplace",
      rootPath: "support",
      servers: [],
      skills: [],
      sourceRevisionRef,
      warnings: [],
    } satisfies Parameters<typeof store.claimLegacyGithubImportSource>[0]["plan"]

    await expect(store.claimLegacyGithubImportSource({ canonicalGithubUrl, context, plan }))
      .resolves.toBe(legacyPluginId)
    const claims = await db
      .select({
        canonicalSourceUrl: schema.PluginImportSourceTable.canonicalSourceUrl,
        pluginId: schema.PluginImportSourceTable.pluginId,
        sourceRevisionRef: schema.PluginImportSourceTable.sourceRevisionRef,
      })
      .from(schema.PluginImportSourceTable)
      .where(drizzle.eq(schema.PluginImportSourceTable.pluginId, legacyPluginId))
    expect(claims).toEqual([{ canonicalSourceUrl: canonicalGithubUrl, pluginId: legacyPluginId, sourceRevisionRef }])

    // Once adopted, mutable lifecycle fields are no longer part of identity.
    await db.update(schema.PluginTable).set({ description: "Renamed legacy import" })
      .where(drizzle.eq(schema.PluginTable.id, legacyPluginId))
    await expect(store.claimLegacyGithubImportSource({ canonicalGithubUrl, context, plan }))
      .resolves.toBe(legacyPluginId)
    await expect(db.transaction(async (tx) => {
      await store.assertGithubImportPublicationAvailable({ canonicalGithubUrl, organizationId, tx })
    })).rejects.toMatchObject({ error: "github_plugin_already_imported" })

    const oldestCanonicalGithubUrl = "https://github.com/example/oldest-marketplace"
    await db.insert(schema.PluginTable).values({
      createdByOrgMembershipId: memberId,
      description: "Plugin components imported from example/oldest-marketplace.",
      id: oldestLegacyPluginId,
      name: "Oldest marketplace import",
      organizationId,
      status: "inactive",
    })
    const oldestPlan = {
      ...plan,
      repositoryFullName: "example/oldest-marketplace",
      rootPath: "",
    } satisfies Parameters<typeof store.claimLegacyGithubImportSource>[0]["plan"]
    await expect(store.claimLegacyGithubImportSource({
      canonicalGithubUrl: oldestCanonicalGithubUrl,
      context,
      plan: oldestPlan,
    })).resolves.toBe(oldestLegacyPluginId)
    const oldestClaims = await db
      .select({
        canonicalSourceUrl: schema.PluginImportSourceTable.canonicalSourceUrl,
        pluginId: schema.PluginImportSourceTable.pluginId,
        sourceRevisionRef: schema.PluginImportSourceTable.sourceRevisionRef,
      })
      .from(schema.PluginImportSourceTable)
      .where(drizzle.eq(schema.PluginImportSourceTable.pluginId, oldestLegacyPluginId))
    expect(oldestClaims).toEqual([{
      canonicalSourceUrl: oldestCanonicalGithubUrl,
      pluginId: oldestLegacyPluginId,
      sourceRevisionRef: null,
    }])
  })
})
