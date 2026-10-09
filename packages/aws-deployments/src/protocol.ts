import { createHash } from "node:crypto"
import { XMLParser } from "fast-xml-parser"
import { z } from "zod"
import { awsDeploymentEnrollmentSchema, awsDeploymentRegionSchema, awsDeploymentStepSchema, type AwsDeploymentEventInput } from "./schema.js"

export function hashRunnerToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}
export function deploymentStackName(deploymentId: string) {
  return `openwork-${deploymentId.replaceAll("-", "")}`
}
export function deploymentRunnerRole(deploymentId: string) {
  return `${deploymentStackName(deploymentId)}-runner`
}
export function validateEventTransition(input: AwsDeploymentEventInput, lastSequence: number) {
  if (input.sequence !== lastSequence + 1) return false
  if (awsDeploymentStepSchema.options[lastSequence] !== input.step) return false
  return input.outcome === "failed" ? Boolean(input.errorCode) : !input.errorCode
}

const identitySchema = z.object({
  GetCallerIdentityResponse: z.object({ GetCallerIdentityResult: z.object({
    Account: z.string().regex(/^\d{12}$/), Arn: z.string(),
  }) }),
})

// Replay a tightly constrained, signed STS POST, not a caller-supplied URL.
// AWS verifies both the credentials and our run-specific signed challenge.
export async function verifyRunnerIdentity(input: {
  enrollment: z.infer<typeof awsDeploymentEnrollmentSchema>
  accountId: string
  region: string
  deploymentId: string
  runId: string
  challenge: string
  fetcher?: typeof fetch
  now?: Date
}) {
  const region = awsDeploymentRegionSchema.parse(input.region)
  const headers = input.enrollment.headers
  const challenge = `${input.runId}:${input.challenge}`
  if (headers["x-openwork-run"] !== challenge) throw new Error("runner_identity_invalid")
  const date = headers["x-amz-date"]
  const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
  if (Math.abs((input.now ?? new Date()).getTime() - signedAt) > 60_000) throw new Error("runner_identity_expired")
  const signedHeadersMatch = /SignedHeaders=([^, ]+)/.exec(headers.authorization)
  const signedHeaders = signedHeadersMatch?.[1]?.split(";") ?? []
  const expectedHeaders = ["content-type", "host", "x-amz-date", "x-amz-security-token", "x-openwork-run"]
  if (!headers.authorization.startsWith("AWS4-HMAC-SHA256 ") || signedHeaders.join(";") !== expectedHeaders.join(";")) {
    throw new Error("runner_identity_invalid")
  }
  const response = await (input.fetcher ?? fetch)(`https://sts.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "Action=GetCallerIdentity&Version=2011-06-15",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("runner_identity_invalid")
  const text = await response.text()
  if (text.length > 16_384) throw new Error("runner_identity_invalid")
  const xml: unknown = new XMLParser({ parseTagValue: false }).parse(text)
  const identity = identitySchema.parse(xml).GetCallerIdentityResponse.GetCallerIdentityResult
  const expectedArn = `arn:aws:sts::${input.accountId}:assumed-role/${deploymentRunnerRole(input.deploymentId)}/`
  if (identity.Account !== input.accountId || !identity.Arn.startsWith(expectedArn)) throw new Error("runner_identity_invalid")
}

export function cloudFormationLaunchUrl(input: {
  region: string
  deploymentId: string
  runId: string
  challenge: string
  templateUrl: string
  apiOrigin: string
  bundleUrl: string
  bundleSha256: string
  version: string
  domainName: string
  route53ZoneId: string
  ownerEmail: string
  accountId: string
}) {
  const params = new URLSearchParams({
    templateURL: input.templateUrl,
    stackName: deploymentStackName(input.deploymentId),
    param_DeploymentId: input.deploymentId,
    param_RunId: input.runId,
    param_Challenge: input.challenge,
    param_ControlPlaneOrigin: input.apiOrigin,
    param_BundleUrl: input.bundleUrl,
    param_BundleSha256: input.bundleSha256,
    param_OpenWorkVersion: input.version,
    param_DomainName: input.domainName,
    param_Route53ZoneId: input.route53ZoneId,
    param_OwnerEmail: input.ownerEmail,
    param_ExpectedAccountId: input.accountId,
  })
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks/quickcreate?${params}`
}
