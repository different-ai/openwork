import { z } from "zod"

/**
 * Provider-neutral managed deployment contract. Only the `target` object and
 * the identity/bootstrap adapters differ per cloud; lifecycle, milestones and
 * health reports are identical on every provider.
 */
export const managedDeploymentProviderSchema = z.enum(["aws", "azure", "gcp"])
export const availableProviders = ["aws", "gcp"] as const

export const awsRegionSchema = z.enum(["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-southeast-2"])
const subnetIdsSchema = (label: string) => z.array(z.string().trim().regex(/^subnet-[0-9a-f]{8,17}$/, `Enter ${label} subnet IDs such as subnet-0abc12345.`))
  .min(2, `Choose at least two ${label} subnets in different availability zones.`).max(6)
  .refine((ids) => new Set(ids).size === ids.length, "Each subnet can be listed once.")

/**
 * Where the deployment runs inside the AWS account. `dedicated` creates its own
 * VPC and ECS cluster (the account should hold nothing else). `existing` uses
 * the customer's VPC, subnets and optionally an ECS cluster; the installer then
 * creates only OpenWork's own resources and can change only those.
 */
export const awsNetworkSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("dedicated") }).strict(),
  z.object({
    mode: z.literal("existing"),
    vpcId: z.string().trim().regex(/^vpc-[0-9a-f]{8,17}$/, "Enter a VPC ID such as vpc-0abc12345."),
    /** Private subnets with outbound internet (NAT) for services and the database. */
    serviceSubnetIds: subnetIdsSchema("private"),
    /** Public subnets for the internet-facing load balancer. */
    loadBalancerSubnetIds: subnetIdsSchema("public"),
    /** Empty creates an ECS cluster for this deployment. */
    ecsClusterArn: z.string().trim().max(300).optional(),
  }).strict(),
])
export type AwsNetwork = z.infer<typeof awsNetworkSchema>

const customerSecretArnSchema = z.string().trim().max(2048)
  .regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/, "Enter the complete ARN of a customer-created plain-string Secrets Manager secret, without a JSON field or version suffix.")
const modelBaseUrlSchema = z.string().trim().max(2048).url().refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
}, "Use an HTTPS endpoint without credentials, query parameters or a fragment.")

export const awsAssistantsSchema = z.object({
  headlessRunnerEnabled: z.boolean().default(false),
  workbotEnabled: z.boolean().default(false),
  slackAssistantEnabled: z.boolean().default(false),
  modelProtocol: z.enum(["anthropic", "openai", "openai-responses"]).optional(),
  modelBaseUrl: modelBaseUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/, "Enter a model ID without spaces or control characters.").optional(),
  modelSecretArn: customerSecretArnSchema.optional(),
  computerProvider: z.enum(["off", "daytona", "freestyle"]).default("off"),
  computerSecretArn: customerSecretArnSchema.optional(),
  computerSnapshot: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/, "Enter a computer snapshot ID without spaces or control characters.").optional(),
  daytonaApiUrl: modelBaseUrlSchema.optional(),
  daytonaTarget: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, "Enter a Daytona target such as us or eu.").optional(),
}).strict().superRefine((assistants, context) => {
  if (assistants.computerProvider !== "off" && !assistants.computerSecretArn) {
    context.addIssue({ code: "custom", path: ["computerSecretArn"], message: "Enter the ARN of your plain-string computer provider API key secret." })
  }
  if (assistants.computerProvider === "daytona" && !assistants.computerSnapshot) {
    context.addIssue({ code: "custom", path: ["computerSnapshot"], message: "Choose a Daytona computer snapshot before enabling Daytona computers." })
  }
})
export type AwsAssistants = z.infer<typeof awsAssistantsSchema>
export function assistantsEnabled(assistants: AwsAssistants) {
  return assistants.headlessRunnerEnabled || assistants.workbotEnabled || assistants.slackAssistantEnabled || assistants.computerProvider !== "off"
}

export const awsRuntimeProfileSchema = z.enum(["legacy", "gateway"])
export type AwsRuntimeProfile = z.infer<typeof awsRuntimeProfileSchema>
const awsTargetFields = {
  accountId: z.string().regex(/^\d{12}$/, "Enter the 12-digit AWS account ID."),
  region: awsRegionSchema,
  route53ZoneId: z.string().trim().regex(/^Z[A-Z0-9]{1,31}$/, "Enter the Route 53 hosted zone ID, starting with Z."),
  network: awsNetworkSchema.default({ mode: "dedicated" }),
  assistants: awsAssistantsSchema.default({ headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false, computerProvider: "off" }),
}

/** Request parsing retains an omitted profile so only the create route can choose a rollout-aware default. */
export const awsTargetCreateSchema = z.object({ ...awsTargetFields, runtimeProfile: awsRuntimeProfileSchema.optional() }).strict()
export type AwsTargetCreate = z.infer<typeof awsTargetCreateSchema>

export function gatewayAssistants(assistants: AwsAssistants): AwsAssistants {
  return {
    headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: true,
    computerProvider: assistants.computerProvider,
    ...(assistants.computerProvider !== "off" && assistants.computerSecretArn ? { computerSecretArn: assistants.computerSecretArn } : {}),
    ...(assistants.computerProvider === "daytona" ? {
      ...(assistants.computerSnapshot ? { computerSnapshot: assistants.computerSnapshot } : {}),
      ...(assistants.daytonaApiUrl ? { daytonaApiUrl: assistants.daytonaApiUrl } : {}),
      ...(assistants.daytonaTarget ? { daytonaTarget: assistants.daytonaTarget } : {}),
    } : {}),
  }
}

/** Views always preserve missing-profile historical records as legacy; parsing never upgrades storage. */
export const awsTargetSchema = z.object({ ...awsTargetFields, runtimeProfile: awsRuntimeProfileSchema.default("legacy") }).strict().superRefine((target, context) => {
  if (target.runtimeProfile === "legacy") {
    if (!target.assistants.headlessRunnerEnabled && (target.assistants.workbotEnabled || target.assistants.slackAssistantEnabled || target.assistants.computerProvider !== "off")) {
      context.addIssue({ code: "custom", path: ["assistants", "headlessRunnerEnabled"], message: "Legacy assistant services require their managed runner. Use the gateway profile for a new runtime." })
    }
    if (target.assistants.headlessRunnerEnabled) {
      for (const key of ["modelProtocol", "modelBaseUrl", "model", "modelSecretArn"] satisfies (keyof AwsAssistants)[]) {
        if (!target.assistants[key]) context.addIssue({ code: "custom", path: ["assistants", key], message: "The legacy direct-model configuration is incomplete. Upgrade to the gateway profile to configure providers inside the installed Den." })
      }
    }
  }
  for (const key of ["modelSecretArn", "computerSecretArn"] satisfies (keyof AwsAssistants)[]) {
    const arn = target.assistants[key]
    if (arn && typeof arn === "string" && !arn.startsWith(`arn:aws:secretsmanager:${target.region}:${target.accountId}:secret:`)) {
      context.addIssue({ code: "custom", path: ["assistants", key], message: "Use a Secrets Manager secret in this deployment's AWS account and region." })
    }
  }
  const network = target.network
  if (network.mode !== "existing") return
  if (network.ecsClusterArn && !new RegExp(`^arn:aws:ecs:${target.region}:${target.accountId}:cluster/[A-Za-z0-9_-]{1,255}$`).test(network.ecsClusterArn)) {
    context.addIssue({ code: "custom", path: ["network", "ecsClusterArn"], message: "Enter an ECS cluster ARN in the same AWS account and region, or leave it empty." })
  }
  if (network.serviceSubnetIds.some((id) => network.loadBalancerSubnetIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["network", "loadBalancerSubnetIds"], message: "Use public subnets for the load balancer and private subnets for services." })
  }
}).transform((target) => target.runtimeProfile === "gateway" ? { ...target, assistants: gatewayAssistants(target.assistants) } : target)
export type AwsTarget = z.infer<typeof awsTargetSchema>
export function normalizeAwsTargetForView(input: unknown): AwsTarget {
  return awsTargetSchema.parse(input)
}
export function normalizeAwsTargetForCreate(input: z.input<typeof awsTargetCreateSchema>, options: { gatewayByDefault: boolean }): AwsTarget {
  const target = awsTargetCreateSchema.parse(input)
  return awsTargetSchema.parse({ ...target, runtimeProfile: target.runtimeProfile ?? (options.gatewayByDefault ? "gateway" : "legacy") })
}

/**
 * How the organization's people sign in to AWS: their IAM Identity Center
 * access portal and optional role (permission set) to open the console with. With
 * it, every AWS link opens through the portal in the deployment's own account.
 * Only AWS-hosted portal addresses are accepted, so a saved value can never
 * send an approver anywhere else.
 */
export const awsSignInSchema = z.object({
  portalUrl: z.string().trim().max(300).refine((value) => awsPortalBase(value) !== null, "Enter your AWS access portal URL, such as https://your-company.awsapps.com/start.")
    .overwrite((value) => awsPortalBase(value) ?? value),
  roleName: z.string().trim().regex(/^[\w+=,.@-]{0,64}$/, "Enter the role name as the access portal shows it, such as AdministratorAccess.").nullable().default(null).overwrite((value) => value || null),
}).strict()
export type AwsSignIn = z.infer<typeof awsSignInSchema>

/** The portal address without a trailing slash, or null when it is not an AWS access portal. */
export function awsPortalBase(value: string) {
  const text = value.trim()
  if (!URL.canParse(text)) return null
  const url = new URL(text)
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search) return null
  const classic = /^[a-z0-9][a-z0-9.-]*\.awsapps\.com$/.test(url.hostname)
  const regional = /^[a-z0-9][a-z0-9.-]*\.app\.aws$/.test(url.hostname)
  if (!classic && !regional) return null
  const path = url.pathname.replace(/\/+$/, "")
  if (!/^(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return null
  return `https://${url.hostname}${path || (classic ? "/start" : "")}`
}

export const gcpRegionSchema = z.enum(["us-central1", "us-east1", "us-east4", "us-west1", "us-west2", "europe-west1", "europe-west2", "europe-west3", "asia-southeast1", "australia-southeast1"])
export const gcpTargetSchema = z.object({
  projectId: z.string().trim().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "Enter a Google Cloud project ID."),
  projectNumber: z.string().regex(/^\d{1,20}$/, "Enter the numeric Google Cloud project number."),
  region: gcpRegionSchema,
  dnsZoneName: z.string().trim().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "Enter a Cloud DNS managed zone name."),
}).strict()
export type GcpTarget = z.infer<typeof gcpTargetSchema>

const hostnameSchema = z.string().trim().toLowerCase().max(200)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a hostname such as openwork.example.com.")

const commonInput = {
  name: z.string().trim().min(1).max(80),
  domainName: hostnameSchema,
  ownerEmail: z.string().trim().email().max(254),
  size: z.literal("small").default("small"),
}
export const awsManagedDeploymentInputSchema = z.object({ ...commonInput, provider: z.literal("aws"), target: awsTargetCreateSchema }).strict()
export type AwsManagedDeploymentInput = z.infer<typeof awsManagedDeploymentInputSchema>
export const managedDeploymentInputSchema = z.discriminatedUnion("provider", [
  awsManagedDeploymentInputSchema,
  z.object({ ...commonInput, provider: z.literal("gcp"), target: gcpTargetSchema }).strict(),
])
export type ManagedDeploymentInput = z.infer<typeof managedDeploymentInputSchema>

// ---- Installation milestones (identical for every cloud) ----
export const deploymentStepSchema = z.enum([
  "runner_connected", "release_verified", "account_verified", "infrastructure_applied", "services_ready", "health_verified",
])
export const deploymentRunStateSchema = z.enum(["awaiting_approval", "provisioning", "ready", "failed"])
/** What the launch route prepares. A `configure` run is prepared only by a configuration change. */
export const deploymentLaunchKindSchema = z.enum(["install", "update", "retry"])
export type DeploymentLaunchKind = z.infer<typeof deploymentLaunchKindSchema>
export const deploymentRunKindSchema = z.enum(["install", "update", "retry", "configure"])
export const deploymentEventInputSchema = z.object({
  sequence: z.number().int().min(1).max(100),
  step: deploymentStepSchema,
  outcome: z.enum(["succeeded", "failed"]),
  errorCode: z.enum(["release_verification_failed", "network_check_failed", "infrastructure_failed", "certificate_failed", "service_unhealthy", "health_check_failed", "runner_failed"]).optional(),
}).strict()
export const deploymentEventSchema = deploymentEventInputSchema.extend({ receivedAt: z.string().datetime() })
export type DeploymentEventInput = z.infer<typeof deploymentEventInputSchema>

// ---- Health reports (identical for every cloud) ----
export const healthCheckIdSchema = z.enum([
  "api_health", "database_ready", "web_available", "services_running", "load_balancer_targets",
  "database_instance", "database_storage", "database_backups", "certificate",
  "runner_service", "workbot_available", "runner_storage", "runner_backups", "ai_gateway_available",
])
export const healthCheckStatusSchema = z.enum(["ok", "warning", "failing", "unknown"])
export const healthCheckCodeSchema = z.enum([
  "http_error", "unreachable", "slow", "not_running", "unhealthy", "unavailable", "permission_denied",
  "low_storage", "stale_backup", "backups_disabled", "not_issued", "expiring", "expired",
])
const boundedNumber = z.number().finite().min(0).max(1_000_000_000)
export const healthCheckSchema = z.object({
  id: healthCheckIdSchema,
  status: healthCheckStatusSchema,
  value: boundedNumber.optional(),
  total: boundedNumber.optional(),
  code: healthCheckCodeSchema.optional(),
}).strict()
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(80)
export const healthReportSchema = z.object({
  // A fresh nonce gives Google metadata tokens a unique exact-body audience even
  // when successive health snapshots are identical. AWS reports stay compatible.
  nonce: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  version: versionSchema.optional(),
  checks: z.array(healthCheckSchema).min(1).max(20)
    .refine((checks) => new Set(checks.map((check) => check.id)).size === checks.length, "Duplicate check"),
}).strict()
export type HealthCheck = z.infer<typeof healthCheckSchema>
export type HealthReport = z.infer<typeof healthReportSchema>

export const deploymentHealthStateSchema = z.enum(["operational", "degraded", "down", "not_reporting", "awaiting_report"])
export const deploymentHealthSchema = z.object({
  state: deploymentHealthStateSchema,
  reportedAt: z.string().datetime().nullable(),
  version: versionSchema.nullable(),
  checks: z.array(healthCheckSchema),
})

// ---- Configuration changes after installation (AWS, same installer version) ----
export const deploymentConfigurationFieldSchema = z.enum([
  "name", "domainName", "ownerEmail",
  "target.accountId", "target.region", "target.route53ZoneId", "target.network", "target.runtimeProfile",
  "target.assistants.headlessRunnerEnabled", "target.assistants.workbotEnabled", "target.assistants.slackAssistantEnabled",
  "target.assistants.modelProtocol", "target.assistants.modelBaseUrl", "target.assistants.model", "target.assistants.modelSecretArn",
  "target.assistants.computerProvider", "target.assistants.computerSecretArn", "target.assistants.computerSnapshot",
  "target.assistants.daytonaApiUrl", "target.assistants.daytonaTarget",
])
export type DeploymentConfigurationField = z.infer<typeof deploymentConfigurationFieldSchema>
export const deploymentConfigurationEffectSchema = z.enum(["saved_immediately", "restarts_den", "restarts_runner", "adds_gateway_runtime"])
export const deploymentConfigurationChangeSchema = z.object({
  field: deploymentConfigurationFieldSchema,
  /** Raw values. Secret ARNs are references, never secret values. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  effect: deploymentConfigurationEffectSchema,
}).strict()
export type DeploymentConfigurationChange = z.infer<typeof deploymentConfigurationChangeSchema>
export const deploymentConfigurationChangeInputSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  /** The complete document, so a fixed field is refused by name. An omitted runtimeProfile keeps the recorded one. */
  configuration: awsManagedDeploymentInputSchema,
}).strict()
/** Stored on a configure run. Targets are in storage form. */
export const deploymentConfigurationChangeRecordSchema = z.object({
  version: z.literal(1),
  requestedBy: z.object({ memberId: z.string(), userId: z.string() }).strict(),
  baseRunId: z.string().uuid(),
  /** The active run to return to if the change is withdrawn. */
  restoresRunId: z.string().uuid(),
  previous: z.object({ ownerEmail: z.string(), target: z.record(z.string(), z.unknown()) }).strict(),
  requested: z.object({ ownerEmail: z.string(), target: z.record(z.string(), z.unknown()) }).strict(),
  /** Never contains `name`: a rename is saved at once, without a run. */
  changes: z.array(deploymentConfigurationChangeSchema),
}).strict()
export const deploymentConfigurationLockSchema = z.enum(["aws_only", "not_installed", "run_in_progress", "unfinished_run", "installer_unknown", "installer_unavailable"])
export const deploymentConfigurationViewSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  /** Null when the configuration can be changed now. */
  lock: deploymentConfigurationLockSchema.nullable(),
  /** The installed installer is the published one, so the gateway runtime can be turned on. */
  gatewayAvailable: z.boolean(),
  change: z.object({
    runId: z.string().uuid(),
    /**
     * `applying` from the moment the approval command confirms the change with OpenWork
     * (the run still awaits enrollment and `run.lastSeenAt` is that moment), and for as
     * long as no final report arrives: a passed deadline (`run.expired`) does not end it,
     * because it says nothing about what AWS did.
     */
    state: z.enum(["awaiting_approval", "applying", "failed", "expired"]),
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    changes: z.array(deploymentConfigurationChangeSchema),
    /** A valid request `configuration`, to edit the change or try it again. */
    requested: awsManagedDeploymentInputSchema,
  }).nullable(),
})

// ---- API views ----
export const deploymentRunSchema = z.object({
  id: z.string().uuid(),
  kind: deploymentRunKindSchema,
  version: z.string(),
  state: deploymentRunStateSchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  expired: z.boolean(),
  events: z.array(deploymentEventSchema),
})
const managedDeploymentViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domainName: z.string(),
  ownerEmail: z.string(),
  size: z.literal("small"),
  updateMode: z.literal("approval"),
  createdAt: z.string().datetime(),
  webUrl: z.string().url(),
  consoleUrl: z.string().url(),
  installedVersion: versionSchema.nullable(),
  availableVersion: versionSchema.nullable(),
  updateAvailable: z.boolean(),
  health: deploymentHealthSchema,
  run: deploymentRunSchema.nullable(),
  /** Present only when the caller can change the configuration after installation. */
  configuration: deploymentConfigurationViewSchema.optional(),
})
export const managedDeploymentSchema = z.discriminatedUnion("provider", [
  managedDeploymentViewSchema.extend({ provider: z.literal("aws"), target: awsTargetSchema }),
  managedDeploymentViewSchema.extend({ provider: z.literal("gcp"), target: gcpTargetSchema }),
])
export const managedDeploymentListSchema = z.object({ deployments: z.array(managedDeploymentSchema) })
export const managedDeploymentLaunchInputSchema = z.object({
  kind: deploymentLaunchKindSchema.default("install"),
  /** Reconfigure the AWS runtime only with a newer, customer-approved installer. */
  runtimeProfile: awsRuntimeProfileSchema.optional(),
  assistants: awsAssistantsSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.assistants || input.runtimeProfile) && input.kind !== "update") context.addIssue({ code: "custom", path: ["runtimeProfile"], message: "Change the runtime profile or computers with a version-increasing Update, not Install or Retry." })
})
const cloudShellHandoffSchema = z.object({ action: z.literal("run_in_cloud_shell"), url: z.string().url(), command: z.string(), instructions: z.string() })
export const managedDeploymentLaunchSchema = z.object({
  deployment: managedDeploymentSchema,
  kind: deploymentRunKindSchema,
  /** Opens the provider console to approve a new installer. Null when the customer runs `command`. */
  approvalUrl: z.string().url().nullable(),
  /** Account-checked command for the customer's cloud shell, updating the existing installer. */
  command: z.string().nullable(),
  /**
   * The one step the person takes in their own cloud, for agents and other API
   * clients: approve at `url` (open_link), or open the cloud shell at `url` and
   * run `command` (run_in_cloud_shell). OpenWork never runs it for them.
   * The API always sends it; optional only so a Den web build deployed before
   * the API keeps parsing launches. Make it required once both have shipped.
   */
  handoff: z.discriminatedUnion("action", [
    z.object({ action: z.literal("open_link"), url: z.string().url(), command: z.null(), instructions: z.string() }),
    cloudShellHandoffSchema,
  ]).optional(),
  expiresAt: z.string().datetime(),
})
/** `approval_required` is also a valid launch, so one screen shows either handoff. */
export const deploymentConfigurationChangeResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), deployment: managedDeploymentSchema }),
  z.object({ outcome: z.literal("withdrawn"), deployment: managedDeploymentSchema }),
  z.object({
    outcome: z.literal("approval_required"), deployment: managedDeploymentSchema, kind: z.literal("configure"),
    approvalUrl: z.null(), command: z.string(), handoff: cloudShellHandoffSchema, expiresAt: z.string().datetime(),
    changes: z.array(deploymentConfigurationChangeSchema),
  }),
])
/** Sent by the approval command itself, before it changes anything in the customer's cloud. */
export const deploymentApprovalCheckInputSchema = z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const deploymentApprovalCheckResultSchema = z.object({ ok: z.literal(true), expiresAt: z.string().datetime() })
export const deploymentConfigurationErrorSchema = z.object({ error: z.string(), message: z.string().optional(), field: deploymentConfigurationFieldSchema.optional() })
export const managedDeploymentConfigurationSchema = z.object({
  /** Requires both managed deployment features for this caller. */
  assistantsAvailable: z.boolean().default(false),
  /** The organization's saved AWS sign-in. When set, every AWS link opens through it. */
  awsSignIn: awsSignInSchema.nullable().default(null),
  providers: z.array(z.object({
    provider: managedDeploymentProviderSchema,
    available: z.boolean(),
    version: versionSchema.nullable(),
    reason: z.enum(["ready", "not_configured", "invalid_configuration", "not_supported", "feature_disabled"]).optional(),
    missingFields: z.array(z.string()).optional(),
  })),
  updateMode: z.literal("approval"),
})
export const awsSignInInputSchema = z.object({ awsSignIn: awsSignInSchema.nullable() }).strict()
export type ManagedDeployment = z.infer<typeof managedDeploymentSchema>
export type DeploymentHealth = z.infer<typeof deploymentHealthSchema>
