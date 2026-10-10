import { z } from "zod"

/**
 * Provider-neutral managed deployment contract. Only the `target` object and
 * the identity/bootstrap adapters differ per cloud; lifecycle, milestones and
 * health reports are identical on every provider.
 */
export const managedDeploymentProviderSchema = z.enum(["aws", "azure", "gcp"])
export const availableProviders = ["aws"] as const

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

export const awsTargetSchema = z.object({
  accountId: z.string().regex(/^\d{12}$/, "Enter the 12-digit AWS account ID."),
  region: awsRegionSchema,
  route53ZoneId: z.string().trim().regex(/^Z[A-Z0-9]{1,31}$/, "Enter the Route 53 hosted zone ID, starting with Z."),
  // Deployments created before network choice existed are dedicated.
  network: awsNetworkSchema.default({ mode: "dedicated" }),
}).strict().superRefine((target, context) => {
  const network = target.network
  if (network.mode !== "existing") return
  if (network.ecsClusterArn && !new RegExp(`^arn:aws:ecs:${target.region}:${target.accountId}:cluster/[A-Za-z0-9_-]{1,255}$`).test(network.ecsClusterArn)) {
    context.addIssue({ code: "custom", path: ["network", "ecsClusterArn"], message: "Enter an ECS cluster ARN in the same AWS account and region, or leave it empty." })
  }
  if (network.serviceSubnetIds.some((id) => network.loadBalancerSubnetIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["network", "loadBalancerSubnetIds"], message: "Use public subnets for the load balancer and private subnets for services." })
  }
})
export type AwsTarget = z.infer<typeof awsTargetSchema>

const hostnameSchema = z.string().trim().toLowerCase().max(200)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a hostname such as openwork.example.com.")

const commonInput = {
  name: z.string().trim().min(1).max(80),
  domainName: hostnameSchema,
  ownerEmail: z.string().trim().email().max(254),
  size: z.literal("small").default("small"),
}
export const managedDeploymentInputSchema = z.discriminatedUnion("provider", [
  z.object({ ...commonInput, provider: z.literal("aws"), target: awsTargetSchema }).strict(),
])
export type ManagedDeploymentInput = z.infer<typeof managedDeploymentInputSchema>

// ---- Installation milestones (identical for every cloud) ----
export const deploymentStepSchema = z.enum([
  "runner_connected", "release_verified", "account_verified", "infrastructure_applied", "services_ready", "health_verified",
])
export const deploymentRunStateSchema = z.enum(["awaiting_approval", "provisioning", "ready", "failed"])
export const deploymentRunKindSchema = z.enum(["install", "update", "retry"])
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
export const managedDeploymentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: managedDeploymentProviderSchema,
  target: awsTargetSchema,
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
})
export const managedDeploymentListSchema = z.object({ deployments: z.array(managedDeploymentSchema) })
export const managedDeploymentLaunchInputSchema = z.object({ kind: deploymentRunKindSchema.default("install") }).strict()
export const managedDeploymentLaunchSchema = z.object({
  deployment: managedDeploymentSchema,
  kind: deploymentRunKindSchema,
  /** Opens the provider console to approve a new installer. Null when the customer runs `command`. */
  approvalUrl: z.string().url().nullable(),
  /** Account-checked command for the customer's cloud shell, updating the existing installer. */
  command: z.string().nullable(),
  expiresAt: z.string().datetime(),
})
export const managedDeploymentConfigurationSchema = z.object({
  providers: z.array(z.object({ provider: managedDeploymentProviderSchema, available: z.boolean(), version: versionSchema.nullable() })),
  updateMode: z.literal("approval"),
})
export type ManagedDeployment = z.infer<typeof managedDeploymentSchema>
export type DeploymentHealth = z.infer<typeof deploymentHealthSchema>
