import { expect, test } from "bun:test"

const sourcePath = new URL("../src/orgs.ts", import.meta.url)
const authSourcePath = new URL("../src/auth.ts", import.meta.url)
const credentialsSourcePath = new URL("../src/capability-sources/oauth-credentials.ts", import.meta.url)
const callbackSourcePath = new URL("../src/routes/org/oauth-providers.ts", import.meta.url)
const adminSourcePath = new URL("../src/routes/admin/index.ts", import.meta.url)

test("member removal deletes every per-member connected account before anonymizing the membership", async () => {
  const source = await Bun.file(sourcePath).text()
  const removeMemberSource = source.slice(source.indexOf("export async function removeOrganizationMember"))

  const deleteConnectedAccountsAt = removeMemberSource.indexOf(".delete(ConnectedAccountTable)")
  const lockMembershipAt = removeMemberSource.indexOf('.for("update")')
  const scopeToOrganizationAt = removeMemberSource.indexOf("eq(ConnectedAccountTable.organizationId, input.organizationId)")
  const scopeToMembershipAt = removeMemberSource.indexOf("eq(ConnectedAccountTable.orgMembershipId, member.id)")
  const anonymizeMembershipAt = removeMemberSource.indexOf(".update(MemberTable)")

  expect(deleteConnectedAccountsAt).toBeGreaterThan(-1)
  expect(lockMembershipAt).toBeGreaterThan(-1)
  expect(deleteConnectedAccountsAt).toBeGreaterThan(lockMembershipAt)
  expect(scopeToOrganizationAt).toBeGreaterThan(deleteConnectedAccountsAt)
  expect(scopeToMembershipAt).toBeGreaterThan(scopeToOrganizationAt)
  expect(anonymizeMembershipAt).toBeGreaterThan(scopeToMembershipAt)
})

test("Better Auth member deletion removes connected accounts without disconnecting role changes", async () => {
  const source = await Bun.file(authSourcePath).text()
  const databaseDeleteHook = source.slice(
    source.indexOf("databaseHooks:"),
    source.indexOf("session:", source.indexOf("databaseHooks:")),
  )
  const roleChangeHook = source.slice(
    source.indexOf("beforeUpdateMemberRole:"),
    source.indexOf("oauthProvider("),
  )

  expect(databaseDeleteHook).toContain("deleteOrganizationMemberConnectedAccounts({")
  expect(databaseDeleteHook).toContain("organizationId: member.organizationId")
  expect(databaseDeleteHook).toContain("orgMembershipId: member.id")
  expect(roleChangeHook).not.toContain("deleteOrganizationMemberConnectedAccounts({")
})

test("platform-admin user deletion erases connected accounts before removing memberships", async () => {
  const source = await Bun.file(adminSourcePath).text()
  const deleteUserRoute = source.slice(
    source.indexOf('"/v1/admin/users/:userId"'),
    source.indexOf('app.patch(', source.indexOf('"/v1/admin/users/:userId"')),
  )
  const deleteAccountsAt = deleteUserRoute.indexOf("tx.delete(ConnectedAccountTable)")
  const removeMembershipsAt = deleteUserRoute.indexOf("tx.update(MemberTable).set({ removedAt })")

  expect(deleteAccountsAt).toBeGreaterThan(-1)
  expect(deleteUserRoute).toContain("ConnectedAccountTable.orgMembershipId")
  expect(removeMembershipsAt).toBeGreaterThan(deleteAccountsAt)
})

test("OAuth callback token persistence locks and requires an active membership", async () => {
  const credentialsSource = await Bun.file(credentialsSourcePath).text()
  const fencedUpsert = credentialsSource.slice(credentialsSource.indexOf("async function updateExistingConnectedAccountForActiveMember"))
  const activeMembershipAt = fencedUpsert.indexOf("isNull(MemberTable.removedAt)")
  const lockMembershipAt = fencedUpsert.indexOf('.for("update")')
  const writeTokenAt = Math.min(
    ...[fencedUpsert.indexOf(".update(ConnectedAccountTable)"), fencedUpsert.indexOf("tx.insert(ConnectedAccountTable)")]
      .filter((index) => index >= 0),
  )

  expect(activeMembershipAt).toBeGreaterThan(-1)
  expect(lockMembershipAt).toBeGreaterThan(activeMembershipAt)
  expect(writeTokenAt).toBeGreaterThan(lockMembershipAt)
  expect(fencedUpsert).toContain("existing.id !== input.expectedAccountId")
  expect(fencedUpsert).toContain("existing.pendingCodeVerifier !== input.expectedPendingCodeVerifier")
  expect(fencedUpsert).not.toContain("tx.insert(ConnectedAccountTable)")

  const callbackSource = await Bun.file(callbackSourcePath).text()
  expect(callbackSource).toContain("completeConnectedAccountForActiveMember({")
  expect(callbackSource).toContain("expectedAccountId: pending.id")
  expect(callbackSource).toContain("expectedPendingCodeVerifier: pending.pendingCodeVerifier")
  expect(callbackSource).toContain("This OpenWork connection request is no longer active.")
})

test("OAuth refresh persistence is update-only and tied to the exact active grant", async () => {
  const credentialsSource = await Bun.file(credentialsSourcePath).text()
  const refreshFence = credentialsSource.slice(credentialsSource.indexOf("export async function refreshConnectedAccountForActiveMember"))
  expect(refreshFence).toContain("updateExistingConnectedAccountForActiveMember(input)")

  const implementation = credentialsSource.slice(credentialsSource.indexOf("async function updateExistingConnectedAccountForActiveMember"))
  expect(implementation).toContain("existing.id !== input.expectedAccountId")
  expect(implementation).toContain("existing.accessToken !== input.expectedAccessToken")
  expect(implementation).toContain("existing.refreshToken !== input.expectedRefreshToken")
  expect(implementation).not.toContain("tx.insert(ConnectedAccountTable)")

  const oauthSource = await Bun.file(new URL("../src/capability-sources/generic-oauth.ts", import.meta.url)).text()
  expect(oauthSource).toContain("refreshConnectedAccountForActiveMember({")
  expect(oauthSource).toContain("expectedAccountId: account.id")
  expect(oauthSource).toContain('return { error: "not_connected" }')
})
