import assert from "node:assert/strict"
import { test } from "node:test"
import { genericProviderAuthError } from "../src/gateway.js"

const requestId = "req_01j-gateway-auth"

for (const status of [401, 403] as const) {
  for (const credentialMode of ["org", "member"] as const) {
    test(`${status} from a generic provider returns actionable ${credentialMode}-credential guidance`, async () => {
      const { response, errorCode } = genericProviderAuthError({
        status,
        providerId: "ipr_fixture",
        providerName: "Acme",
        credentialMode,
        requestId,
      })
      const body: unknown = await response.json()
      assert.equal(response.status, status)
      assert.equal(response.headers.get("x-openwork-request-id"), requestId)
      assert.equal(errorCode, status === 401 ? "provider_authentication_failed" : "provider_permission_denied")
      assert.deepEqual(body, { error: {
        source: "openwork_gateway",
        message: credentialMode === "org"
          ? status === 401
            ? "Acme rejected your organization's API credential. Ask your administrator to check the Acme connection in AI Gateway."
            : "Acme denied access for your organization's provider credential. Ask your administrator to check the Acme connection in AI Gateway."
          : status === 401
            ? "Acme rejected your credential. Sign in again or replace your credential in AI Gateway."
            : "Acme denied access for your credential. Ask your administrator to check provider permissions, or replace your credential if it has changed.",
        type: "invalid_request_error",
        code: errorCode,
        provider_id: "ipr_fixture",
      } })
      assert.doesNotMatch(JSON.stringify(body), /secret|raw upstream|invalid key text/i)
    })
  }
}
