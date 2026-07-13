import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { describe, expect, test } from "bun:test"
import { revokeAccountsBeforeOAuthClientIdentityChange } from "../src/capability-sources/oauth-client-rotation.js"

describe("OAuth client identity rotation", () => {
  test("immediately revokes connected accounts after tenant or client-id changes", async () => {
    const organizationId = createDenTypeId("organization")
    const revoked: Array<{ organizationId: string; providerId: string }> = []
    const revoke = async (target: { organizationId: typeof organizationId; providerId: string }) => {
      revoked.push(target)
    }

    expect(await revokeAccountsBeforeOAuthClientIdentityChange({
      hadExistingClient: true,
      previousClientId: "client-1",
      nextClientId: "client-1",
      previousTenantId: "old.onmicrosoft.com",
      nextTenantId: "new.onmicrosoft.com",
      organizationId,
      providerId: "microsoft-365",
      revoke,
    })).toBe(true)
    expect(await revokeAccountsBeforeOAuthClientIdentityChange({
      hadExistingClient: true,
      previousClientId: "client-1",
      nextClientId: "client-2",
      previousTenantId: "new.onmicrosoft.com",
      nextTenantId: "new.onmicrosoft.com",
      organizationId,
      providerId: "microsoft-365",
      revoke,
    })).toBe(true)
    expect(revoked).toEqual([
      { organizationId, providerId: "microsoft-365" },
      { organizationId, providerId: "microsoft-365" },
    ])
  })

  test("preserves accounts for initial setup and secret-only rotation", async () => {
    const organizationId = createDenTypeId("organization")
    let revocationCount = 0
    const revoke = async () => {
      revocationCount += 1
    }
    const common = {
      previousClientId: "client-1",
      nextClientId: "client-1",
      previousTenantId: "acme.onmicrosoft.com",
      nextTenantId: "acme.onmicrosoft.com",
      organizationId,
      providerId: "microsoft-365",
      revoke,
    }

    expect(await revokeAccountsBeforeOAuthClientIdentityChange({ ...common, hadExistingClient: false })).toBe(false)
    expect(await revokeAccountsBeforeOAuthClientIdentityChange({ ...common, hadExistingClient: true })).toBe(false)
    expect(revocationCount).toBe(0)
  })
})
