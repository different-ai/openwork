import assert from "node:assert/strict"
import { test } from "node:test"
import { googleWorkspaceRevocationTokens } from "../src/organization-deletion-google-tokens.js"

test("only Google Workspace OAuth grants are picked for revocation", () => {
  const account = (providerId: string, refreshToken: string | null, accessToken: string | null, tokenType: string | null = "Bearer") =>
    ({ providerId, refreshToken, accessToken, tokenType })
  assert.deepEqual(googleWorkspaceRevocationTokens([
    account("google-workspace", "legacy-refresh", "legacy-access"),
    account("emc_google", null, "named-access"),
    account("emc_google", "duplicate", null),
    account("google-workspace", "duplicate", null),
    account("emc_other_mcp", "other-refresh", "other-access"),
    account("microsoft-365", "ms-refresh", "ms-access"),
    account("emc_google", null, "personal-api-key", "api_key"),
    account("google-workspace", null, null),
  ], ["emc_google"]), ["legacy-refresh", "named-access", "duplicate"])
})
