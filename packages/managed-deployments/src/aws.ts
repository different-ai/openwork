import { XMLParser } from "fast-xml-parser"
import { z } from "zod"
// Self-reference, not "./schema.js": den-api loads this package's TypeScript
// source at runtime, where only package exports resolve to the .ts files.
import { assistantsEnabled, awsRegionSchema, gatewayAssistants, type AwsSignIn, type AwsTarget } from "@openwork/managed-deployments/schema"

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

export function cloudShellUrl(region: string) {
  return `https://${region}.console.aws.amazon.com/cloudshell/home?region=${region}`
}

/**
 * Opens an AWS console page through the organization's access portal: the
 * portal signs the person in to this account with the saved role, or asks them
 * to choose one, then goes to the page. Without a saved sign-in the console
 * page is returned as it is.
 */
export function throughAccessPortal(destination: string, accountId: string, signIn: AwsSignIn | null) {
  if (!signIn) return destination
  const params = new URLSearchParams({ account_id: accountId, ...(signIn.roleName ? { role_name: signIn.roleName } : {}), destination })
  return `${signIn.portalUrl}/#/console?${params}`
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
  /** Explicitly configured runs also send false/empty values to disable an installed runner. */
  includeAssistantParameters?: boolean
  /** Omit on untouched historical records whose installer template predates runtime profiles. */
  includeRuntimeProfileParameter?: boolean
  /**
   * Default true. False only for a configuration change of a record stored without
   * `network`: it was created before network choice existed, when the installer
   * template had no network parameters. Every template that has them defaults to
   * the dedicated network such a record uses, so omitting them changes nothing.
   */
  includeNetworkParameters?: boolean
  /**
   * The command first asks OpenWork whether this run is still the approval to apply,
   * and stops before `update-stack` when it is not. Configuration changes only.
   */
  approvalCheck?: boolean
  domainName: string
  ownerEmail: string
  size: string
  release: { templateUrl: string; bundleUrl: string; bundleSha256: string; version: string; apiOrigin: string }
}

function networkParameters(network: AwsTarget["network"]) {
  if (network.mode === "dedicated") return { NetworkMode: "dedicated", VpcId: "", ServiceSubnetIds: "", LoadBalancerSubnetIds: "", EcsClusterArn: "" }
  return {
    NetworkMode: "existing", VpcId: network.vpcId, ServiceSubnetIds: network.serviceSubnetIds.join(","),
    LoadBalancerSubnetIds: network.loadBalancerSubnetIds.join(","), EcsClusterArn: network.ecsClusterArn ?? "",
  }
}

function launchParameters(input: AwsLaunch) {
  const gateway = input.target.runtimeProfile === "gateway"
  const assistants = gateway ? gatewayAssistants(input.target.assistants) : input.target.assistants
  return {
    DeploymentId: input.deploymentId, RunId: input.runId, Challenge: input.challenge,
    ExpectedAccountId: input.target.accountId, ControlPlaneOrigin: input.release.apiOrigin,
    BundleUrl: input.release.bundleUrl, BundleSha256: input.release.bundleSha256, OpenWorkVersion: input.release.version,
    DomainName: input.domainName, Route53ZoneId: input.target.route53ZoneId, OwnerEmail: input.ownerEmail, Size: input.size,
    ...((input.includeNetworkParameters ?? true) ? networkParameters(input.target.network) : {}),
    ...((input.includeRuntimeProfileParameter ?? gateway) ? { ManagedRuntimeProfile: input.target.runtimeProfile } : {}),
    ...((gateway || (input.includeAssistantParameters ?? assistantsEnabled(assistants))) ? {
      HeadlessRunnerEnabled: String(assistants.headlessRunnerEnabled),
      WorkbotEnabled: String(assistants.workbotEnabled),
      SlackAssistantEnabled: String(assistants.slackAssistantEnabled),
      HeadlessModelProtocol: assistants.modelProtocol ?? "anthropic",
      HeadlessModelBaseUrl: assistants.modelBaseUrl ?? "",
      HeadlessModel: assistants.model ?? "",
      HeadlessModelSecretArn: assistants.modelSecretArn ?? "",
      HeadlessComputerProvider: assistants.computerProvider,
      HeadlessComputerSecretArn: assistants.computerProvider === "off" ? "" : assistants.computerSecretArn ?? "",
      HeadlessComputerSnapshot: assistants.computerProvider === "daytona" ? assistants.computerSnapshot ?? "" : "",
      DaytonaApiUrl: assistants.daytonaApiUrl ?? "https://app.daytona.io/api",
      DaytonaTarget: assistants.daytonaTarget ?? "us",
    } : {}),
  }
}

/** Defaults unchanged since each parameter's first installer template release. */
export const quickCreateDefaults: ReadonlyMap<string, string> = new Map([
  ["Size", "small"], ["NetworkMode", "dedicated"], ["VpcId", ""],
  ["ServiceSubnetIds", ""], ["LoadBalancerSubnetIds", ""], ["EcsClusterArn", ""],
  ["ManagedRuntimeProfile", "legacy"], ["HeadlessRunnerEnabled", "false"],
  ["WorkbotEnabled", "false"], ["SlackAssistantEnabled", "false"],
  ["HeadlessModelProtocol", "anthropic"], ["HeadlessModelBaseUrl", "https://api.anthropic.com/v1"],
  ["HeadlessModel", ""], ["HeadlessModelSecretArn", ""], ["HeadlessComputerProvider", "off"],
  ["HeadlessComputerSecretArn", ""], ["HeadlessComputerSnapshot", ""],
  ["DaytonaApiUrl", "https://app.daytona.io/api"], ["DaytonaTarget", "us"],
])

/** Opens CloudFormation quick-create, prefilled; the customer reviews and approves. */
export function quickCreateUrl(input: AwsLaunch) {
  const params = new URLSearchParams({ templateURL: input.release.templateUrl, stackName: stackName(input.deploymentId) })
  for (const [key, value] of Object.entries(launchParameters(input))) {
    if (quickCreateDefaults.get(key) !== value) params.set(`param_${key}`, value)
  }
  const region = input.target.region
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${params}`
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Where the approval command confirms a configuration change before it updates the stack. */
export function approvalCheckUrl(apiOrigin: string, deploymentId: string, runId: string) {
  return `${apiOrigin.replace(/\/+$/, "")}/v1/managed-deployments/${deploymentId}/runs/${runId}/approval-check`
}

/**
 * Updates the existing installer stack with a new run (retry, approved version
 * update or configuration change). Refuses to run against any other AWS account.
 * With `approvalCheck`, any answer but OpenWork's own 200 ends the command
 * before `update-stack`. The stack update is always the last step, and its
 * `--parameters` value is the literal JSON.
 */
export function updateStackCommand(input: AwsLaunch) {
  const parameters = Object.entries(launchParameters(input)).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }))
  const check = `[ "$(aws sts get-caller-identity --query Account --output text)" = ${quoteShell(input.target.accountId)} ] || { echo "Switch to AWS account ${input.target.accountId}." >&2; exit 1; }`
  // Only OpenWork's own 200 lets the command continue: a refusal, a redirect, a timeout, a proxy's
  // answer or a missing curl all leave the status something else, and curl follows no redirect.
  const confirm = [
    `_openwork_approval_status=$(curl --silent --show-error --max-time 30 --output /dev/null --write-out '%{http_code}' --request POST --header 'content-type: application/json'`,
    "--data", quoteShell(JSON.stringify({ challenge: input.challenge })), `${quoteShell(approvalCheckUrl(input.release.apiOrigin, input.deploymentId, input.runId))}) && [ "$_openwork_approval_status" = 200 ]`,
  ].join(" ")
  const refused = `{ echo "OpenWork did not confirm this approval, so this command changed nothing. Open the deployment in OpenWork and copy its current command." >&2; false; }`
  const update = [
    "aws cloudformation update-stack", "--region", quoteShell(input.target.region), "--stack-name", quoteShell(stackName(input.deploymentId)),
    "--template-url", quoteShell(input.release.templateUrl), "--capabilities CAPABILITY_NAMED_IAM", "--parameters", quoteShell(JSON.stringify(parameters)),
  ].join(" ")
  return input.approvalCheck ? `${check} && { ${confirm} || ${refused}; } && ${update}` : `${check} && ${update}`
}
