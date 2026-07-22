import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

// MySQL integration coverage for the multi-replica trust boundary. Run after
// pushing the current schema to the dedicated test database.
process.env.DATABASE_URL = process.env.DESKTOP_CONNECT_TEST_DATABASE_URL
  ?? "mysql://root:password@127.0.0.1:3306/openwork_test_connect"
process.env.DB_MODE = "mysql"
process.env.DEN_DB_ENCRYPTION_KEY = "connect-grant-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET = "connect-grant-test-auth-secret-1234567890"
process.env.BETTER_AUTH_URL = "https://den.example.test"
process.env.DEN_API_PUBLIC_URL = "https://api.den.example.test"

const organizationId = createDenTypeId("organization")
const installLinkId = createDenTypeId("installLink")
const createdByUserId = createDenTypeId("user")

let db: typeof import("../src/db.js").db
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let schema: typeof import("@openwork-ee/den-db/schema")
let grants: typeof import("../src/desktop-connect-grants.js")

async function clearRows() {
  await db.delete(schema.DesktopConnectGrantTable)
    .where(drizzle.eq(schema.DesktopConnectGrantTable.installLinkId, installLinkId))
  await db.delete(schema.InstallLinkTable)
    .where(drizzle.eq(schema.InstallLinkTable.id, installLinkId))
  await db.delete(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../src/desktop-connect-grants.js"),
  ])
  db = modules[0].db
  drizzle = modules[1]
  schema = modules[2]
  grants = modules[3]

  await clearRows()
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Replica Test Org",
    slug: `replica-test-${organizationId}`,
    desktopAppRestrictions: {},
  })
  await db.insert(schema.InstallLinkTable).values({
    id: installLinkId,
    organizationId,
    tokenHash: "a".repeat(64),
    createdByUserId,
  })
})

afterAll(clearRows)

function mintGrant() {
  return grants.mintDesktopConnectGrant({
    installLinkId,
    organizationName: "Replica Test Org",
    appName: "OpenWork",
    logoUrl: null,
    iconUrl: null,
    webUrl: "https://den.example.test",
    apiUrl: "https://api.den.example.test",
  })
}

function codeFrom(connectUrl: string) {
  const code = new URL(connectUrl).searchParams.get("code")
  if (!code) throw new Error("minted exchange link did not contain a code")
  return code
}

test("MySQL grants preview across pods and allow exactly one concurrent consumer", async () => {
  const minted = await mintGrant()
  const code = codeFrom(minted.connectUrl)
  const [firstPreview, secondPreview] = await Promise.all([
    grants.previewDesktopConnectGrant(code),
    grants.previewDesktopConnectGrant(code),
  ])

  expect(firstPreview.ok).toBe(true)
  expect(secondPreview.ok).toBe(true)

  const attempts = await Promise.all([
    grants.consumeDesktopConnectGrant(code),
    grants.consumeDesktopConnectGrant(code),
    grants.consumeDesktopConnectGrant(code),
  ])
  expect(attempts.filter((result) => result.ok)).toHaveLength(1)
  expect(attempts.filter((result) => !result.ok && result.code === "replayed")).toHaveLength(2)
  await expect(grants.previewDesktopConnectGrant(code)).resolves.toEqual({ ok: false, code: "replayed" })

  const [stored] = await db.select({
    claims: schema.DesktopConnectGrantTable.claims,
    codeHash: schema.DesktopConnectGrantTable.codeHash,
  })
    .from(schema.DesktopConnectGrantTable)
    .where(drizzle.eq(schema.DesktopConnectGrantTable.installLinkId, installLinkId))
    .limit(1)
  expect(stored?.codeHash).toHaveLength(64)
  expect(JSON.stringify(stored)).not.toContain(code)

  await db.update(schema.DesktopConnectGrantTable)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(drizzle.eq(schema.DesktopConnectGrantTable.installLinkId, installLinkId))
  const replacement = await mintGrant()
  const remaining = await db.select({ codeHash: schema.DesktopConnectGrantTable.codeHash })
    .from(schema.DesktopConnectGrantTable)
    .where(drizzle.eq(schema.DesktopConnectGrantTable.installLinkId, installLinkId))
  expect(remaining).toHaveLength(1)

  await db.update(schema.InstallLinkTable)
    .set({ revokedAt: new Date() })
    .where(drizzle.eq(schema.InstallLinkTable.id, installLinkId))
  await expect(grants.previewDesktopConnectGrant(codeFrom(replacement.connectUrl))).resolves.toEqual({
    ok: false,
    code: "invalid_token",
  })
})
