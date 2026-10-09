import { z } from "zod"

export const awsDeploymentRegionSchema = z.enum(["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-southeast-2"])
export const awsDeploymentInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  accountId: z.string().regex(/^\d{12}$/),
  region: awsDeploymentRegionSchema,
  domainName: z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  route53ZoneId: z.string().regex(/^Z[A-Z0-9]{1,31}$/),
  ownerEmail: z.string().email().max(254),
}).strict()

export const awsDeploymentStepSchema = z.enum([
  "runner_connected", "release_verified", "account_verified", "infrastructure_applied", "services_ready", "health_verified",
])
export const awsDeploymentStateSchema = z.enum(["awaiting_aws", "provisioning", "ready", "failed"])
export const awsDeploymentEventInputSchema = z.object({
  sequence: z.number().int().min(1).max(100),
  step: awsDeploymentStepSchema,
  outcome: z.enum(["succeeded", "failed"]),
  errorCode: z.enum(["release_verification_failed", "infrastructure_failed", "service_unhealthy", "health_check_failed", "runner_failed"]).optional(),
}).strict()
export const awsDeploymentEventSchema = awsDeploymentEventInputSchema.extend({ receivedAt: z.string().datetime() })
export const awsDeploymentRunSchema = z.object({
  id: z.string().uuid(),
  version: z.string(),
  state: awsDeploymentStateSchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  expired: z.boolean(),
  events: z.array(awsDeploymentEventSchema),
})
export const awsDeploymentSchema = awsDeploymentInputSchema.extend({
  id: z.string().uuid(),
  updateMode: z.literal("manual"),
  createdAt: z.string().datetime(),
  webUrl: z.string().url(),
  stackUrl: z.string().url(),
  run: awsDeploymentRunSchema.nullable(),
})
export const awsDeploymentListSchema = z.object({ deployments: z.array(awsDeploymentSchema) })
export const awsDeploymentLaunchSchema = z.object({
  deployment: awsDeploymentSchema,
  launchUrl: z.string().url(),
  expiresAt: z.string().datetime(),
})
export const awsDeploymentEnrollmentSchema = z.object({
  headers: z.object({
    authorization: z.string().max(2048),
    "x-amz-date": z.string().regex(/^\d{8}T\d{6}Z$/),
    "x-amz-security-token": z.string().max(8192),
    "x-openwork-run": z.string().max(200),
  }).strict(),
}).strict()
export type AwsDeployment = z.infer<typeof awsDeploymentSchema>
export type AwsDeploymentEventInput = z.infer<typeof awsDeploymentEventInputSchema>
export type AwsDeploymentStep = z.infer<typeof awsDeploymentStepSchema>
