import assert from "node:assert/strict"
import test from "node:test"
import { parseInferenceProviderSecret } from "@openwork/types/den/inference"

test("api_key returns the trimmed raw value", () => {
  assert.deepEqual(parseInferenceProviderSecret("api_key", "  sk-test \n"), {
    kind: "api_key",
    apiKey: "sk-test",
  })
})

test("api_key_map requires a non-empty string map", () => {
  assert.deepEqual(
    parseInferenceProviderSecret("api_key_map", JSON.stringify({ A: "1", B: "2" })),
    { kind: "api_key_map", apiKeys: { A: "1", B: "2" } },
  )
  assert.throws(() => parseInferenceProviderSecret("api_key_map", "{}"))
  assert.throws(() => parseInferenceProviderSecret("api_key_map", JSON.stringify({ A: 1 })))
})

test("aws_keys parses required and optional fields", () => {
  const parsed = parseInferenceProviderSecret(
    "aws_keys",
    JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" }),
  )
  assert.equal(parsed.kind, "aws_keys")
  if (parsed.kind !== "aws_keys") return
  assert.equal(parsed.awsKeys.region, "us-east-1")
  assert.equal(parsed.awsKeys.sessionToken, undefined)
  assert.throws(() =>
    parseInferenceProviderSecret("aws_keys", JSON.stringify({ accessKeyId: "AKIA" })),
  )
})

test("gcp_service_account keeps extra fields", () => {
  const parsed = parseInferenceProviderSecret(
    "gcp_service_account",
    JSON.stringify({
      type: "service_account",
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----",
      token_uri: "https://oauth2.googleapis.com/token",
      project_id: "proj",
    }),
  )
  assert.equal(parsed.kind, "gcp_service_account")
  if (parsed.kind !== "gcp_service_account") return
  assert.equal(parsed.serviceAccount.project_id, "proj")
  assert.throws(() =>
    parseInferenceProviderSecret("gcp_service_account", JSON.stringify({ client_email: "x" })),
  )
})

test("oauth kinds parse token payloads", () => {
  for (const kind of ["oauth_google", "oauth_azure"] as const) {
    const parsed = parseInferenceProviderSecret(
      kind,
      JSON.stringify({ accessToken: "at", refreshToken: "rt", tokenType: "Bearer" }),
    )
    assert.equal(parsed.kind, kind)
    if (parsed.kind !== kind) return
    assert.deepEqual(parsed.token, { accessToken: "at", refreshToken: "rt", tokenType: "Bearer" })
    assert.throws(() => parseInferenceProviderSecret(kind, JSON.stringify({ refreshToken: "rt" })))
  }
})

test("malformed JSON is rejected for structured kinds", () => {
  assert.throws(
    () => parseInferenceProviderSecret("aws_keys", "not json"),
    /not valid JSON/,
  )
})
