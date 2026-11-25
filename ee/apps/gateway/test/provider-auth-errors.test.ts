import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyLiteLlmAuthError } from "@openwork-ee/gateway-catalog"
import { genericProviderAuthError, liteLlmProviderAuthError } from "../src/gateway.js"

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

test("classifyLiteLlmAuthError maps upstream 401/403 bodies into safe categories without echoing secrets", () => {
  assert.equal(
    classifyLiteLlmAuthError(JSON.stringify({ error: { message: "The requested model 'gpt-6-luna' is not available for this API key, or the model name is invalid." } })),
    "model_denied",
  )
  assert.equal(
    classifyLiteLlmAuthError(JSON.stringify({ error: { message: "Authentication Error, Invalid issuer in JWT Bearer secret-token-123" } })),
    "jwt_mismatch",
  )
  assert.equal(
    classifyLiteLlmAuthError(JSON.stringify({ detail: "Audience doesn't match configured client_id" })),
    "jwt_mismatch",
  )
  assert.equal(
    classifyLiteLlmAuthError(JSON.stringify({ error: { message: "User not found in DB for oid 1234" } })),
    "user_not_found",
  )
  assert.equal(
    classifyLiteLlmAuthError(JSON.stringify({ error: { message: "Budget has been exceeded! Current cost: 2.01, Max budget: 2.0" } })),
    "budget_exceeded",
  )
  assert.equal(classifyLiteLlmAuthError("Forbidden"), "other")
  assert.equal(classifyLiteLlmAuthError(""), "other")
})

async function readErrorMessage(response: Response): Promise<{ message: string; code: string }> {
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null && "error" in body)
  const error = body.error
  assert.ok(typeof error === "object" && error !== null && "message" in error && "code" in error)
  assert.equal(typeof error.message, "string")
  assert.equal(typeof error.code, "string")
  return { message: String(error.message), code: String(error.code) }
}

test("liteLlmProviderAuthError returns mode-specific LiteLLM guidance without misdirected credential copy", async () => {
  const entraModelDenied = liteLlmProviderAuthError({
    status: 403,
    providerId: "ipr_litellm",
    credentialMode: "member",
    keySource: "entra",
    modelId: "gpt-6.1-terra",
    reason: "model_denied",
    requestId,
  })
  assert.equal(entraModelDenied.errorCode, "provider_permission_denied")
  const entraDeniedBody = await readErrorMessage(entraModelDenied.response)
  assert.equal(entraModelDenied.response.status, 403)
  assert.equal(entraModelDenied.response.headers.get("x-openwork-request-id"), requestId)
  assert.match(entraDeniedBody.message, /^LiteLLM denied access to gpt-6\.1-terra for your Microsoft account\./)
  assert.doesNotMatch(entraDeniedBody.message, /Litellm/)
  assert.doesNotMatch(entraDeniedBody.message, /replace your credential/i)

  const entraJwt = liteLlmProviderAuthError({
    status: 401,
    providerId: "ipr_litellm",
    credentialMode: "member",
    keySource: "entra",
    modelId: "gpt-6.1-terra",
    reason: "jwt_mismatch",
    requestId,
  })
  assert.equal(entraJwt.errorCode, "provider_authentication_failed")
  const entraJwtBody = await readErrorMessage(entraJwt.response)
  assert.match(entraJwtBody.message, /LiteLLM JWT issuer, audience, and v2 access token settings/)

  const entraMissingUser = liteLlmProviderAuthError({
    status: 401,
    providerId: "ipr_litellm",
    credentialMode: "member",
    keySource: "entra",
    modelId: "gpt-6.1-terra",
    reason: "user_not_found",
    requestId,
  })
  const entraMissingUserBody = await readErrorMessage(entraMissingUser.response)
  assert.match(entraMissingUserBody.message, /user_id_upsert/)

  const orgDenied = liteLlmProviderAuthError({
    status: 403,
    providerId: "ipr_litellm",
    credentialMode: "org",
    keySource: null,
    modelId: "gpt-6.1-terra",
    reason: "model_denied",
    requestId,
  })
  const orgDeniedBody = await readErrorMessage(orgDenied.response)
  assert.match(orgDeniedBody.message, /organization's key.*sync LiteLLM in AI Gateway/)

  const issuedRejected = liteLlmProviderAuthError({
    status: 401,
    providerId: "ipr_litellm",
    credentialMode: "member",
    keySource: "issued",
    modelId: "gpt-6.1-terra",
    reason: "other",
    requestId,
  })
  const issuedBody = await readErrorMessage(issuedRejected.response)
  assert.match(issuedBody.message, /OpenWork-managed LiteLLM key.*sync LiteLLM/)

  const personalRejected = liteLlmProviderAuthError({
    status: 401,
    providerId: "ipr_litellm",
    credentialMode: "member",
    keySource: "personal",
    modelId: "gpt-6.1-terra",
    reason: "other",
    requestId,
  })
  const personalBody = await readErrorMessage(personalRejected.response)
  assert.match(personalBody.message, /Reconnect your LiteLLM key/)
})
