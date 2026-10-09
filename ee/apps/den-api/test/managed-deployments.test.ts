import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  amzDateToDate, enrollmentProof, healthRoleName, heartbeatProof, quickCreateUrl, runnerRoleName, stackName, updateStackCommand, verifyAwsIdentity, type AwsLaunch,
} from "@openwork/managed-deployments/aws"
import { compareVersions, hashToken, HEALTH_STALE_AFTER_MS, summarizeHealth, tokenMatches, validateEventTransition } from "@openwork/managed-deployments/lifecycle"
import { deploymentEventInputSchema, healthReportSchema, managedDeploymentInputSchema } from "@openwork/managed-deployments/schema"

const deploymentId = "00000000-0000-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"
const challenge = "a".repeat(64)
const now = new Date("2026-10-08T12:00:00Z")
const target = { accountId: "123456789012", region: "us-east-1" as const, route53ZoneId: "ZTEST123" }
const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof"
function identity(proof: string, headers = signedHeaders) {
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=test, SignedHeaders=${headers}, Signature=test`,
    "x-amz-date": "20261008T120000Z", "x-amz-security-token": "session-token", "x-openwork-proof": proof,
  }
}
function stsResponse(arn: string, account = "123456789012") {
  return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${account}</Account><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`)
}
const runnerArn = `arn:aws:sts::123456789012:assumed-role/${runnerRoleName(deploymentId)}/build`
const launch: AwsLaunch = {
  deploymentId, runId, challenge, target, domainName: "openwork.example.com", ownerEmail: "o'connor@example.com", size: "small",
  release: { templateUrl: "https://releases.example.com/aws/template.json", bundleUrl: "https://releases.example.com/aws/bundle.tar.gz", bundleSha256: "b".repeat(64), version: "0.18.57", apiOrigin: "https://api.example.com" },
}

test("deployment input is provider-tagged and validates the AWS target", () => {
  const input = { name: "Production", provider: "aws", domainName: "openwork.example.com", ownerEmail: "admin@example.com", target }
  assert.equal(managedDeploymentInputSchema.safeParse(input).success, true)
  assert.equal(managedDeploymentInputSchema.parse(input).size, "small")
  for (const change of [{ provider: "azure" }, { target: { ...target, accountId: "1234" } }, { target: { ...target, region: "mars-1" } }, { domainName: "https://openwork.example.com" }, { target: { ...target, extra: true } }]) {
    assert.equal(managedDeploymentInputSchema.safeParse({ ...input, ...change }).success, false)
  }
})

test("milestones must arrive in order and failures carry an allowlisted code", () => {
  assert.equal(validateEventTransition({ sequence: 1, step: "health_verified", outcome: "succeeded" }, 0), false)
  assert.equal(validateEventTransition({ sequence: 1, step: "runner_connected", outcome: "succeeded" }, 0), true)
  assert.equal(validateEventTransition({ sequence: 6, step: "health_verified", outcome: "succeeded" }, 5), true)
  assert.equal(validateEventTransition({ sequence: 2, step: "release_verified", outcome: "failed" }, 1), false)
  assert.equal(validateEventTransition({ sequence: 2, step: "release_verified", outcome: "failed", errorCode: "release_verification_failed" }, 1), true)
  assert.equal(deploymentEventInputSchema.safeParse({ sequence: 1, step: "runner_connected", outcome: "succeeded", message: "logs" }).success, false)
})

test("health reports accept only bounded, allowlisted facts", () => {
  const ok = { version: "0.18.57", checks: [{ id: "api_health", status: "ok", value: 42 }] }
  assert.equal(healthReportSchema.safeParse(ok).success, true)
  assert.equal(healthReportSchema.safeParse({ checks: [{ id: "api_health", status: "ok", detail: "stack trace" }] }).success, false)
  assert.equal(healthReportSchema.safeParse({ checks: [{ id: "shell", status: "ok" }] }).success, false)
  assert.equal(healthReportSchema.safeParse({ checks: [{ id: "api_health", status: "ok" }, { id: "api_health", status: "ok" }] }).success, false)
  assert.equal(healthReportSchema.safeParse({ version: "latest", checks: [{ id: "api_health", status: "ok" }] }).success, false)
})

test("health state: operational, degraded, down, not reporting", () => {
  const at = new Date(now.getTime() - 60_000)
  const report = (checks: Parameters<typeof summarizeHealth>[0]["checks"]) => summarizeHealth({ checks, reportedAt: at, version: "0.18.57" }, now).state
  assert.equal(summarizeHealth({ checks: [], reportedAt: null, version: null }, now).state, "awaiting_report")
  assert.equal(report([{ id: "api_health", status: "ok" }, { id: "certificate", status: "ok" }]), "operational")
  assert.equal(report([{ id: "api_health", status: "ok" }, { id: "certificate", status: "warning", code: "expiring" }]), "degraded")
  assert.equal(report([{ id: "api_health", status: "ok" }, { id: "database_storage", status: "failing", code: "low_storage" }]), "degraded")
  assert.equal(report([{ id: "services_running", status: "failing", code: "not_running" }]), "down")
  const stale = summarizeHealth({ checks: [{ id: "api_health", status: "ok" }], reportedAt: new Date(now.getTime() - HEALTH_STALE_AFTER_MS - 1), version: null }, now)
  assert.equal(stale.state, "not_reporting")
  assert.equal(stale.checks.length, 1)
})

test("versions compare semantically", () => {
  assert.equal(compareVersions("0.18.56", "0.18.57"), -1)
  assert.equal(compareVersions("0.18.10", "0.18.9"), 1)
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1)
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
  assert.equal(compareVersions("latest", "1.0.0"), null)
})

test("tokens are stored and compared only as hashes", () => {
  const token = "x".repeat(43)
  assert.match(hashToken(token), /^[a-f0-9]{64}$/)
  assert.equal(tokenMatches(hashToken(token), token), true)
  assert.equal(tokenMatches(hashToken(token), "y".repeat(43)), false)
  assert.equal(tokenMatches(null, token), false)
})

test("identity proofs go only to the fixed regional STS endpoint", async () => {
  let calls = 0
  await verifyAwsIdentity({ identity: identity(enrollmentProof(runId, challenge)), expectedProof: enrollmentProof(runId, challenge), target, roleName: runnerRoleName(deploymentId), now, fetcher: async (url, options) => {
    calls += 1
    assert.equal(url, "https://sts.us-east-1.amazonaws.com/")
    assert.equal(options?.redirect, "error")
    assert.equal(options?.body, "Action=GetCallerIdentity&Version=2011-06-15")
    return stsResponse(runnerArn)
  } })
  assert.equal(calls, 1)
})

test("other accounts, other roles and the wrong deployment cannot authenticate", async () => {
  const expectedProof = enrollmentProof(runId, challenge)
  for (const response of [
    () => stsResponse(runnerArn, "999999999999"),
    () => stsResponse("arn:aws:sts::123456789012:assumed-role/AdministratorAccess/someone"),
    () => stsResponse(`arn:aws:sts::123456789012:assumed-role/${healthRoleName(deploymentId)}/fn`),
    () => stsResponse(`arn:aws:sts::123456789012:assumed-role/${runnerRoleName(runId)}/build`),
    () => new Response("denied", { status: 403 }),
  ]) {
    await assert.rejects(verifyAwsIdentity({ identity: identity(expectedProof), expectedProof, target, roleName: runnerRoleName(deploymentId), now, fetcher: async () => response() }))
  }
})

test("a heartbeat signature is bound to its exact body and is not an enrollment", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls += 1; return stsResponse(runnerArn) }
  const body = JSON.stringify({ checks: [{ id: "api_health", status: "ok" }] })
  const digest = createHash("sha256").update(body).digest("hex")
  const signed = identity(heartbeatProof(deploymentId, digest))
  const tampered = createHash("sha256").update(body.replace("ok", "failing")).digest("hex")
  await assert.rejects(verifyAwsIdentity({ identity: signed, expectedProof: heartbeatProof(deploymentId, tampered), target, roleName: healthRoleName(deploymentId), now, fetcher }))
  await assert.rejects(verifyAwsIdentity({ identity: signed, expectedProof: enrollmentProof(runId, challenge), target, roleName: runnerRoleName(deploymentId), now, fetcher }))
  await assert.rejects(verifyAwsIdentity({ identity: identity(heartbeatProof(deploymentId, digest), signedHeaders.replace(";x-openwork-proof", "")), expectedProof: heartbeatProof(deploymentId, digest), target, roleName: healthRoleName(deploymentId), now, fetcher }))
  await assert.rejects(verifyAwsIdentity({ identity: signed, expectedProof: heartbeatProof(deploymentId, digest), target, roleName: healthRoleName(deploymentId), now: new Date(now.getTime() + 61_000), fetcher }))
  assert.equal(calls, 0)
  assert.equal(amzDateToDate("20261008T120000Z").toISOString(), "2026-10-08T12:00:00.000Z")
})

test("install opens CloudFormation with pinned release parameters and no credentials", () => {
  const url = new URL(quickCreateUrl(launch))
  assert.equal(url.hostname, "us-east-1.console.aws.amazon.com")
  const params = new URLSearchParams(url.hash.split("?")[1])
  assert.equal(params.get("stackName"), stackName(deploymentId))
  assert.equal(params.get("param_BundleSha256"), "b".repeat(64))
  assert.equal(params.get("param_OpenWorkVersion"), "0.18.57")
  assert.equal(params.get("param_ExpectedAccountId"), "123456789012")
  assert.equal([...params.keys()].some((key) => /token|secret|password/i.test(key)), false)
})

test("multiple installations have independent stacks, roles and account-bound approval links", () => {
  const inputs = [launch, {
    ...launch, deploymentId: "00000000-0000-4000-8000-000000000003", runId: "00000000-0000-4000-8000-000000000004",
    target: { ...target, accountId: "123456789013" }, domainName: "staging.example.com",
  }, {
    ...launch, deploymentId: "00000000-0000-4000-8000-000000000005", runId: "00000000-0000-4000-8000-000000000006",
    target: { ...target, accountId: "123456789014" }, domainName: "sandbox.example.com",
  }]
  assert.equal(new Set(inputs.map((input) => stackName(input.deploymentId))).size, 3)
  assert.equal(new Set(inputs.map((input) => runnerRoleName(input.deploymentId))).size, 3)
  assert.equal(new Set(inputs.map((input) => healthRoleName(input.deploymentId))).size, 3)
  for (const input of inputs) {
    const params = new URLSearchParams(new URL(quickCreateUrl(input)).hash.split("?")[1])
    assert.equal(params.get("stackName"), stackName(input.deploymentId))
    assert.equal(params.get("param_RunId"), input.runId)
    assert.equal(params.get("param_ExpectedAccountId"), input.target.accountId)
    assert.equal(params.get("param_DomainName"), input.domainName)
    const command = updateStackCommand(input)
    assert.ok(command.includes(`--stack-name '${stackName(input.deploymentId)}'`))
    assert.ok(command.includes(input.target.accountId))
  }
})

test("retry and update commands check the account and only update the named installer", () => {
  const command = updateStackCommand(launch)
  assert.ok(command.startsWith('[ "$(aws sts get-caller-identity --query Account --output text)" = \'123456789012\' ]'))
  assert.ok(command.includes(`--stack-name '${stackName(deploymentId)}'`))
  assert.ok(command.includes("aws cloudformation update-stack"))
  assert.ok(!/delete-stack|terminate|rm -rf/.test(command))
  execFileSync("bash", ["-n"], { input: command })
})
