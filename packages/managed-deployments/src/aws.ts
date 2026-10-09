import { XMLParser } from "fast-xml-parser"
import { z } from "zod"
import { awsRegionSchema, type AwsTarget } from "./schema.js"

/**
 * AWS adapter: bootstrap (CloudFormation), naming shared with the Terraform
 * contract, and identity proofs. Other clouds implement the same three pieces.
 */
export function compactDeploymentId(deploymentId: string) {
  return deploymentId.replaceAll("-", "")
}
export function stackName(deploymentId: string) {
  return `openwork-${compactDeploymentId(deploymentId)}`
}
export function runnerRoleName(deploymentId: string) {
  return `openwork-${compactDeploymentId(deploymentId)}-runner`
}
export function healthRoleName(deploymentId: string) {
  return `openwork-${compactDeploymentId(deploymentId)}-health`
}
export function consoleUrl(deploymentId: string, region: string) {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${stackName(deploymentId)}`
}

// ---- Identity proof: a signed, unsent STS GetCallerIdentity request ----
// The runner (enrollment) and health agent (reports) sign the request with
// their own temporary role credentials and an `x-openwork-proof` header. The
// control plane replays it only to the fixed regional STS endpoint; AWS
// verifies the signature and returns the caller's account and role.

export const PROOF_HEADER = "x-openwork-proof"
const SIGNED_HEADERS = ["content-type", "host", PROOF_HEADER, "x-amz-date", "x-amz-security-token"].sort().join(";")
export const awsSignedIdentitySchema = z.object({
  authorization: z.string().max(2048),
  "x-amz-date": z.string().regex(/^\d{8}T\d{6}Z$/),
  "x-amz-security-token": z.string().max(8192),
  [PROOF_HEADER]: z.string().max(300),
}).strict()
export type AwsSignedIdentity = z.infer<typeof awsSignedIdentitySchema>
export const awsEnrollmentSchema = z.object({ headers: awsSignedIdentitySchema }).strict()

const identityResponseSchema = z.object({
  GetCallerIdentityResponse: z.object({ GetCallerIdentityResult: z.object({ Account: z.string().regex(/^\d{12}$/), Arn: z.string() }) }),
})

export function amzDateToDate(value: string) {
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`)
}

export function enrollmentProof(runId: string, challenge: string) {
  return `enroll:${runId}:${challenge}`
}
export function heartbeatProof(deploymentId: string, bodySha256: string) {
  return `heartbeat:${deploymentId}:${bodySha256}`
}

export async function verifyAwsIdentity(input: {
  identity: AwsSignedIdentity
  expectedProof: string
  target: Pick<AwsTarget, "accountId" | "region">
  roleName: string
  fetcher?: typeof fetch
  now?: Date
}) {
  const region = awsRegionSchema.parse(input.target.region)
  const headers = input.identity
  if (headers[PROOF_HEADER] !== input.expectedProof) throw new Error("identity_invalid")
  const signedAt = amzDateToDate(headers["x-amz-date"]).getTime()
  if (!Number.isFinite(signedAt) || Math.abs((input.now ?? new Date()).getTime() - signedAt) > 60_000) throw new Error("identity_expired")
  const signed = /SignedHeaders=([^, ]+)/.exec(headers.authorization)?.[1]
  if (!headers.authorization.startsWith("AWS4-HMAC-SHA256 ") || signed !== SIGNED_HEADERS) throw new Error("identity_invalid")
  const response = await (input.fetcher ?? fetch)(`https://sts.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "Action=GetCallerIdentity&Version=2011-06-15",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("identity_invalid")
  const text = await response.text()
  if (text.length > 16_384) throw new Error("identity_invalid")
  const xml: unknown = new XMLParser({ parseTagValue: false }).parse(text)
  const identity = identityResponseSchema.parse(xml).GetCallerIdentityResponse.GetCallerIdentityResult
  const expectedArn = `arn:aws:sts::${input.target.accountId}:assumed-role/${input.roleName}/`
  if (identity.Account !== input.target.accountId || !identity.Arn.startsWith(expectedArn)) throw new Error("identity_invalid")
}

// ---- Bootstrap: CloudFormation ----

export type AwsLaunch = {
  deploymentId: string
  runId: string
  challenge: string
  target: AwsTarget
  domainName: string
  ownerEmail: string
  size: string
  release: { templateUrl: string; bundleUrl: string; bundleSha256: string; version: string; apiOrigin: string }
}

function launchParameters(input: AwsLaunch) {
  return {
    DeploymentId: input.deploymentId, RunId: input.runId, Challenge: input.challenge,
    ExpectedAccountId: input.target.accountId, ControlPlaneOrigin: input.release.apiOrigin,
    BundleUrl: input.release.bundleUrl, BundleSha256: input.release.bundleSha256, OpenWorkVersion: input.release.version,
    DomainName: input.domainName, Route53ZoneId: input.target.route53ZoneId, OwnerEmail: input.ownerEmail, Size: input.size,
  }
}

/** Opens CloudFormation quick-create, prefilled; the customer reviews and approves. */
export function quickCreateUrl(input: AwsLaunch) {
  const params = new URLSearchParams({ templateURL: input.release.templateUrl, stackName: stackName(input.deploymentId) })
  for (const [key, value] of Object.entries(launchParameters(input))) params.set(`param_${key}`, value)
  const region = input.target.region
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${params}`
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Updates the existing installer stack with a new run (retry or approved
 * version update). Refuses to run against any other AWS account.
 */
export function updateStackCommand(input: AwsLaunch) {
  const parameters = Object.entries(launchParameters(input)).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))
  const check = `[ "$(aws sts get-caller-identity --query Account --output text)" = ${quoteShell(input.target.accountId)} ] || { echo "Switch to AWS account ${input.target.accountId}." >&2; exit 1; }`
  const update = [
    "aws cloudformation update-stack", "--region", quoteShell(input.target.region), "--stack-name", quoteShell(stackName(input.deploymentId)),
    "--template-url", quoteShell(input.release.templateUrl), "--capabilities CAPABILITY_NAMED_IAM", "--parameters", quoteShell(JSON.stringify(parameters)),
  ].join(" ")
  return `${check} && ${update}`
}
