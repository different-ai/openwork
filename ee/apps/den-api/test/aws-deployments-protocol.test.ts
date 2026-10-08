import assert from "node:assert/strict"
import { test } from "node:test"
import { awsDeploymentInputSchema, awsDeploymentEventInputSchema } from "@openwork/types/den/aws-deployments"
import { cloudFormationLaunchUrl, deploymentRunnerRole, hashRunnerToken, validateEventTransition, verifyRunnerIdentity } from "../src/aws-deployments/protocol.js"

const deploymentId = "00000000-0000-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"
const challenge = "a".repeat(64)
const now = new Date("2026-10-08T12:00:00Z")
const enrollment = { headers: {
  authorization: "AWS4-HMAC-SHA256 Credential=test, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-run, Signature=test",
  "x-amz-date": "20261008T120000Z",
  "x-amz-security-token": "test-session-token",
  "x-openwork-run": `${runId}:${challenge}`,
} }
const identity = { enrollment, deploymentId, runId, challenge, region: "us-east-1", accountId: "123456789012", now }
const validArn = `arn:aws:sts::123456789012:assumed-role/${deploymentRunnerRole(deploymentId)}/test-build`
function xmlIdentity(arn = validArn, account = "123456789012") {
  return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${account}</Account><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`)
}

test("requires AWS account, allowed region and a DNS hostname", () => {
  const input = { name: "Production", accountId: "123456789012", region: "us-east-1", domainName: "den.example.com", route53ZoneId: "ZTEST123", ownerEmail: "admin@example.com" }
  assert.equal(awsDeploymentInputSchema.safeParse(input).success, true)
  for (const changes of [{ accountId: "123" }, { region: "invalid" }, { domainName: "https://den.example.com" }, { domainName: "den.example.com/" }, { ownerEmail: "bad" }]) {
    assert.equal(awsDeploymentInputSchema.safeParse({ ...input, ...changes }).success, false)
  }
})
test("ready requires every ordered provisioning milestone", () => {
  assert.equal(validateEventTransition({ sequence: 1, step: "health_verified", outcome: "succeeded" }, 0), false)
  assert.equal(validateEventTransition({ sequence: 1, step: "runner_connected", outcome: "succeeded" }, 0), true)
  assert.equal(validateEventTransition({ sequence: 6, step: "health_verified", outcome: "succeeded" }, 5), true)
  assert.equal(validateEventTransition({ sequence: 2, step: "release_verified", outcome: "failed" }, 1), false)
  assert.equal(validateEventTransition({ sequence: 2, step: "release_verified", outcome: "failed", errorCode: "release_verification_failed" }, 1), true)
  assert.equal(validateEventTransition({ sequence: 7, step: "health_verified", outcome: "succeeded" }, 6), false)
})
test("progress accepts only bounded codes, not arbitrary logs or secrets", () => {
  assert.equal(awsDeploymentEventInputSchema.safeParse({ sequence: 1, step: "runner_connected", outcome: "succeeded", message: "sensitive logs" }).success, false)
  assert.equal(awsDeploymentEventInputSchema.safeParse({ sequence: 101, step: "runner_connected", outcome: "succeeded" }).success, false)
  assert.equal(awsDeploymentEventInputSchema.safeParse({ sequence: 1, step: "runner_connected", outcome: "failed", errorCode: "arbitrary text" }).success, false)
})
test("launch is pinned to the operator's bundle and contains no bearer token", () => {
  const url = cloudFormationLaunchUrl({ region: "us-east-1", deploymentId, runId, challenge, templateUrl: "https://release.example.com/template.json", apiOrigin: "https://api.example.com", bundleUrl: "https://release.example.com/v1.tar.gz", bundleSha256: "b".repeat(64), version: "0.18.54", domainName: "den.example.com", route53ZoneId: "ZTEST123", ownerEmail: "admin@example.com", accountId: "123456789012" })
  assert.equal(new URL(url).hostname, "us-east-1.console.aws.amazon.com")
  const params = new URLSearchParams(new URL(url).hash.split("?")[1])
  assert.equal(params.get("param_BundleSha256"), "b".repeat(64))
  assert.equal(params.get("param_RunId"), runId)
  assert.equal(params.get("param_ExpectedAccountId"), "123456789012")
  assert.equal(params.has("param_Token"), false)
})
test("STS request goes only to the fixed regional AWS endpoint", async () => {
  let calls = 0
  await verifyRunnerIdentity({ ...identity, fetcher: async (url, options) => {
    calls++
    assert.equal(url, "https://sts.us-east-1.amazonaws.com/")
    assert.equal(options?.method, "POST")
    assert.equal(options?.redirect, "error")
    assert.equal(options?.body, "Action=GetCallerIdentity&Version=2011-06-15")
    return xmlIdentity()
  } })
  assert.equal(calls, 1)
})
test("different accounts, roles and deployment identities cannot enroll", async () => {
  for (const response of [
    () => xmlIdentity(validArn, "999999999999"),
    () => xmlIdentity("arn:aws:sts::123456789012:assumed-role/administrator/test"),
    () => xmlIdentity(`arn:aws:sts::123456789012:assumed-role/${deploymentRunnerRole(runId)}/test`),
    () => new Response("denied", { status: 403 }),
  ]) {
    await assert.rejects(verifyRunnerIdentity({ ...identity, fetcher: async () => response() }))
  }
})
test("stale identity and unsigned or mismatched challenges fail before AWS", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return xmlIdentity() }
  await assert.rejects(verifyRunnerIdentity({ ...identity, fetcher, now: new Date(now.getTime() + 61_000) }))
  await assert.rejects(verifyRunnerIdentity({ ...identity, fetcher, challenge: "other-run" }))
  await assert.rejects(verifyRunnerIdentity({ ...identity, fetcher, enrollment: { headers: { ...enrollment.headers, authorization: enrollment.headers.authorization.replace(";x-openwork-run", "") } } }))
  assert.equal(calls, 0)
})
test("only a token hash is stored", () => {
  const token = "test-runner-token"
  assert.match(hashRunnerToken(token), /^[a-f0-9]{64}$/)
  assert.notEqual(hashRunnerToken(token), token)
  assert.notEqual(hashRunnerToken(token), hashRunnerToken("different-token"))
})
