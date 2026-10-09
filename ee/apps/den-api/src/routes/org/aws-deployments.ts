import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { and, asc, eq } from "@openwork-ee/den-db/drizzle"
import { AwsDeploymentTable, AwsDeploymentRunTable, AwsDeploymentEventTable } from "@openwork-ee/den-db/schema"
import { awsDeploymentInputSchema, awsDeploymentListSchema, awsDeploymentLaunchSchema, awsDeploymentEventInputSchema, awsDeploymentEnrollmentSchema, awsDeploymentSchema } from "@openwork/types/den/aws-deployments"
import { z } from "zod"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgRoleRoute, paramValidator, tokenRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { awsDeploymentReleaseConfiguration } from "../../aws-deployments/config.js"
import { cloudFormationLaunchUrl, deploymentStackName, hashRunnerToken, validateEventTransition, verifyRunnerIdentity } from "../../aws-deployments/protocol.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationSuperAdmin, orgAccessFailureStatus } from "./shared.js"
import { checkRateLimit } from "../../utils/rate-limit.js"

function runnerTokenMatches(storedHash: string | null, token: string) {
  if (!storedHash || storedHash.length !== 64) return false
  return timingSafeEqual(new Uint8Array(Buffer.from(storedHash, "hex")), new Uint8Array(Buffer.from(hashRunnerToken(token), "hex")))
}

const deploymentParam = z.object({ deploymentId: z.string().uuid() })
const runParam = deploymentParam.extend({ runId: z.string().uuid() })
const acceptedSchema = z.object({ ok: z.literal(true) })
const enrollmentResponseSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() })
const configurationSchema = z.object({ available: z.boolean(), updateMode: z.literal("manual") })
const errorSchema = z.object({ error: z.string() })
function operation(summary: string, response: z.ZodType, security?: Array<Record<string, string[]>>) {
  return describeRoute({ tags: ["AWS deployments"], summary, ...(security ? { security } : {}), responses: {
    200: jsonResponse(summary, response),
    400: jsonResponse("Invalid input.", errorSchema),
    401: jsonResponse("Authentication required.", errorSchema),
    403: jsonResponse("Administrator approval required.", errorSchema),
    404: jsonResponse("Deployment or feature unavailable.", errorSchema),
    409: jsonResponse("Run cannot accept this operation.", errorSchema),
    503: jsonResponse("Release is not configured.", errorSchema),
  } })
}
async function deploymentView(deployment: typeof AwsDeploymentTable.$inferSelect) {
  const run = deployment.active_run_id ? (await db.select().from(AwsDeploymentRunTable).where(eq(AwsDeploymentRunTable.id, deployment.active_run_id)).limit(1))[0] : null
  const events = run ? await db.select().from(AwsDeploymentEventTable).where(eq(AwsDeploymentEventTable.run_id, run.id)).orderBy(asc(AwsDeploymentEventTable.sequence)) : []
  return awsDeploymentSchema.parse({
    id: deployment.id, name: deployment.name, accountId: deployment.account_id, region: deployment.region,
    domainName: deployment.domain_name, route53ZoneId: deployment.route53_zone_id, ownerEmail: deployment.owner_email,
    updateMode: "manual", createdAt: deployment.created_at.toISOString(), webUrl: `https://${deployment.domain_name}`,
    stackUrl: `https://${deployment.region}.console.aws.amazon.com/cloudformation/home?region=${deployment.region}#/stacks?filteringText=${deploymentStackName(deployment.id)}`,
    run: run ? {
      id: run.id, version: run.version, state: run.state, createdAt: run.created_at.toISOString(), lastSeenAt: run.last_seen_at?.toISOString() ?? null,
      expiresAt: run.expires_at.toISOString(), expired: run.expires_at < new Date() && run.state !== "ready" && run.state !== "failed",
      events: events.map((event) => ({ sequence: event.sequence, step: event.step, outcome: event.outcome, ...(event.error_code ? { errorCode: event.error_code } : {}), receivedAt: event.received_at.toISOString() })),
    } : null,
  })
}

export function registerAwsDeploymentRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const path = "/v1/aws-deployments"
  app.get(`${path}/configuration`, operation("Read AWS deployment availability", configurationSchema), orgRoleRoute(["admin"]), requireFeature("awsManagedDeployments"), (c) => c.json({ available: Boolean(awsDeploymentReleaseConfiguration()), updateMode: "manual" }))
  app.get(path, operation("List organization AWS deployments", awsDeploymentListSchema), orgRoleRoute(["admin"]), requireFeature("awsManagedDeployments"), async (c) => {
    const org = c.get("organizationContext")
    if (!org) return c.json({ error: "organization_not_found" }, 404)
    const rows = await db.select().from(AwsDeploymentTable).where(eq(AwsDeploymentTable.org_id, org.organization.id)).limit(100)
    return c.json({ deployments: await Promise.all(rows.map(deploymentView)) })
  })
  app.post(path, operation("Create an AWS deployment", awsDeploymentSchema), orgRoleRoute(["super-admin"]), requireFeature("awsManagedDeployments"), jsonValidator(awsDeploymentInputSchema), async (c) => {
    const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can launch AWS deployments.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const org = c.get("organizationContext")
    if (!org) return c.json({ error: "organization_not_found" }, 404)
    if (!awsDeploymentReleaseConfiguration()) return c.json({ error: "aws_release_not_configured" }, 503)
    const body = c.req.valid("json")
    const id = randomUUID()
    await db.insert(AwsDeploymentTable).values({ id, org_id: org.organization.id, name: body.name, account_id: body.accountId, region: body.region, domain_name: body.domainName, route53_zone_id: body.route53ZoneId, owner_email: body.ownerEmail })
    const row = (await db.select().from(AwsDeploymentTable).where(eq(AwsDeploymentTable.id, id)))[0]
    if (!row) return c.json({ error: "deployment_not_found" }, 404)
    return c.json(await deploymentView(row))
  })
  app.post(`${path}/:deploymentId/launch`, operation("Prepare an approved AWS deployment launch", awsDeploymentLaunchSchema), orgRoleRoute(["super-admin"]), requireFeature("awsManagedDeployments"), paramValidator(deploymentParam), async (c) => {
    const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can launch AWS deployments.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const org = c.get("organizationContext")
    if (!org) return c.json({ error: "organization_not_found" }, 404)
    const release = awsDeploymentReleaseConfiguration()
    if (!release) return c.json({ error: "aws_release_not_configured" }, 503)
    const id = c.req.valid("param").deploymentId
    const runId = randomUUID()
    const challenge = randomBytes(32).toString("hex")
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const result = await db.transaction(async (tx) => {
      const row = (await tx.select().from(AwsDeploymentTable).where(and(eq(AwsDeploymentTable.id, id), eq(AwsDeploymentTable.org_id, org.organization.id))).limit(1).for("update"))[0]
      if (!row) return null
      const active = row.active_run_id ? (await tx.select().from(AwsDeploymentRunTable).where(eq(AwsDeploymentRunTable.id, row.active_run_id)).limit(1))[0] : null
      // Initial install only. Updating an existing environment requires a
      // reviewed infrastructure plan and its own explicit approval flow.
      if (active?.state === "awaiting_aws" && active.expires_at > new Date()) return { deployment: row, run: active }
      if (active?.state === "ready" || (active?.state === "provisioning" && active.expires_at > new Date())) return "conflict"
      if (active && active.state !== "failed") await tx.update(AwsDeploymentRunTable).set({ state: "failed" }).where(eq(AwsDeploymentRunTable.id, active.id))
      const values = { id: runId, deployment_id: id, challenge, version: release.version, template_url: release.templateUrl, bundle_url: release.bundleUrl, bundle_sha256: release.bundleSha256, api_origin: release.apiOrigin, state: "awaiting_aws", expires_at: expiresAt }
      await tx.insert(AwsDeploymentRunTable).values({ ...values, state: "awaiting_aws" })
      await tx.update(AwsDeploymentTable).set({ active_run_id: runId }).where(eq(AwsDeploymentTable.id, id))
      const run = (await tx.select().from(AwsDeploymentRunTable).where(eq(AwsDeploymentRunTable.id, runId)).limit(1))[0]
      if (!run) return null
      return { deployment: { ...row, active_run_id: runId }, run }
    })
    if (!result) return c.json({ error: "deployment_not_found" }, 404)
    if (result === "conflict") return c.json({ error: "deployment_run_conflict" }, 409)
    const { deployment, run } = result
    const launchUrl = cloudFormationLaunchUrl({ templateUrl: run.template_url, bundleUrl: run.bundle_url, bundleSha256: run.bundle_sha256, apiOrigin: run.api_origin, version: run.version, region: deployment.region, deploymentId: id, runId: run.id, challenge: run.challenge, domainName: deployment.domain_name, route53ZoneId: deployment.route53_zone_id, ownerEmail: deployment.owner_email, accountId: deployment.account_id })
    return c.json({ deployment: await deploymentView(deployment), launchUrl, expiresAt: run.expires_at.toISOString() })
  })

  // These accept only an existing, bounded run. They deliberately drain after
  // the feature is killed; no new deployment or run can be created then.
  app.post(`${path}/:deploymentId/runs/:runId/enroll`, operation("Enroll an AWS provisioning runner", enrollmentResponseSchema, []), tokenRoute, paramValidator(runParam), jsonValidator(awsDeploymentEnrollmentSchema), async (c) => {
    const { deploymentId, runId } = c.req.valid("param")
    const deployment = (await db.select().from(AwsDeploymentTable).where(eq(AwsDeploymentTable.id, deploymentId)).limit(1))[0]
    const run = (await db.select().from(AwsDeploymentRunTable).where(and(eq(AwsDeploymentRunTable.id, runId), eq(AwsDeploymentRunTable.deployment_id, deploymentId))).limit(1))[0]
    if (!deployment || !run || deployment.active_run_id !== run.id) return c.json({ error: "deployment_not_found" }, 404)
    if (run.state !== "awaiting_aws" || run.expires_at < new Date()) return c.json({ error: "deployment_run_conflict" }, 409)
    const retryAfter = await checkRateLimit(`aws-enroll:${runId}`, 10, 60_000, Date.now())
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter))
      return c.json({ error: "rate_limited" }, 429)
    }
    try {
      await verifyRunnerIdentity({ enrollment: c.req.valid("json"), deploymentId, runId, challenge: run.challenge, region: deployment.region, accountId: deployment.account_id })
    } catch {
      return c.json({ error: "runner_identity_invalid" }, 401)
    }
    const audited = await attributeAuditRequest(c, { organizationId: deployment.org_id, ...auditServiceAttribution("aws-deployment", deploymentId) })
    if (!audited.ok) return audited.response
    const token = randomBytes(32).toString("base64url")
    const enrolled = await db.transaction(async (tx) => {
      const current = (await tx.select().from(AwsDeploymentRunTable).where(eq(AwsDeploymentRunTable.id, runId)).limit(1).for("update"))[0]
      if (!current || current.state !== "awaiting_aws" || current.expires_at < new Date()) return false
      await tx.update(AwsDeploymentRunTable).set({ state: "provisioning", token_hash: hashRunnerToken(token), last_seen_at: new Date() }).where(eq(AwsDeploymentRunTable.id, runId))
      return true
    })
    if (!enrolled) return c.json({ error: "deployment_run_conflict" }, 409)
    c.header("Cache-Control", "no-store")
    return c.json({ token, expiresAt: run.expires_at.toISOString() })
  })
  app.post(`${path}/:deploymentId/runs/:runId/events`, operation("Report sanitized AWS provisioning progress", acceptedSchema, [{ bearerAuth: [] }]), tokenRoute, paramValidator(runParam), jsonValidator(awsDeploymentEventInputSchema), async (c) => {
    const { deploymentId, runId } = c.req.valid("param")
    const token = c.req.header("authorization")?.replace(/^Bearer /, "")
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return c.json({ error: "unauthorized" }, 401)
    const deployment = (await db.select().from(AwsDeploymentTable).where(eq(AwsDeploymentTable.id, deploymentId)).limit(1))[0]
    if (!deployment || deployment.active_run_id !== runId) return c.json({ error: "deployment_not_found" }, 404)
    const credential = (await db.select().from(AwsDeploymentRunTable).where(and(eq(AwsDeploymentRunTable.id, runId), eq(AwsDeploymentRunTable.deployment_id, deploymentId))).limit(1))[0]
    if (!credential || !runnerTokenMatches(credential.token_hash, token) || credential.expires_at < new Date()) return c.json({ error: "unauthorized" }, 401)
    const body = c.req.valid("json")
    const audited = await attributeAuditRequest(c, { organizationId: deployment.org_id, ...auditServiceAttribution("aws-deployment", deploymentId) })
    if (!audited.ok) return audited.response
    const outcome = await db.transaction(async (tx) => {
      const run = (await tx.select().from(AwsDeploymentRunTable).where(and(eq(AwsDeploymentRunTable.id, runId), eq(AwsDeploymentRunTable.deployment_id, deploymentId))).limit(1).for("update"))[0]
      if (!run || !runnerTokenMatches(run.token_hash, token) || run.expires_at < new Date()) return "unauthorized"
      const existing = (await tx.select().from(AwsDeploymentEventTable).where(and(eq(AwsDeploymentEventTable.run_id, runId), eq(AwsDeploymentEventTable.sequence, body.sequence))).limit(1))[0]
      if (existing) return existing.step === body.step && existing.outcome === body.outcome && (existing.error_code ?? undefined) === body.errorCode ? "ok" : "conflict"
      if (run.state !== "provisioning" || !validateEventTransition(body, run.last_sequence)) return "conflict"
      const now = new Date()
      await tx.insert(AwsDeploymentEventTable).values({ id: randomUUID(), run_id: runId, sequence: body.sequence, step: body.step, outcome: body.outcome, error_code: body.errorCode ?? null, received_at: now })
      await tx.update(AwsDeploymentRunTable).set({ last_sequence: body.sequence, last_seen_at: now, state: body.outcome === "failed" ? "failed" : body.step === "health_verified" ? "ready" : "provisioning" }).where(eq(AwsDeploymentRunTable.id, runId))
      return "ok"
    })
    if (outcome === "unauthorized") return c.json({ error: "unauthorized" }, 401)
    if (outcome === "conflict") return c.json({ error: "event_sequence_conflict" }, 409)
    return c.json({ ok: true })
  })
}
