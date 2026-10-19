import { createHash, randomBytes, randomUUID } from "node:crypto"
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentEventTable, ManagedDeploymentHealthTable, ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import {
  awsEnrollmentSchema, awsSignedIdentitySchema, amzDateToDate, consoleUrl, enrollmentProof, healthRoleName,
  heartbeatProof, quickCreateUrl, runnerRoleName, updateStackCommand, verifyAwsIdentity, type AwsLaunch,
} from "@openwork/managed-deployments/aws"
import { cloudShellCommand, consoleUrl as gcpConsoleUrl, enrollmentAudience, gcpEnrollmentSchema, heartbeatAudience, serviceAccountEmail, verifyGcpIdentity, type GcpLaunch } from "@openwork/managed-deployments/gcp"
import { compareVersions, hashToken, summarizeHealth, tokenMatches, validateEventTransition } from "@openwork/managed-deployments/lifecycle"
import {
  awsTargetSchema, gcpTargetSchema, deploymentEventInputSchema, healthCheckSchema, healthReportSchema, managedDeploymentConfigurationSchema,
  managedDeploymentInputSchema, managedDeploymentLaunchInputSchema, managedDeploymentLaunchSchema, managedDeploymentListSchema,
  managedDeploymentSchema, managedDeploymentReadinessMessage, type ManagedDeployment,
} from "@openwork/managed-deployments/schema"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { awsRelease, gcpRelease, releaseReadiness, type ManagedDeploymentRelease } from "../../managed-deployments/config.js"
import { jsonValidator, orgPermissionRoute, paramValidator, tokenRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"

const PATH = "/v1/managed-deployments"
const RUN_LIFETIME_MS = 3 * 60 * 60 * 1000
const MAX_HEARTBEAT_BYTES = 16_384
const deploymentParam = z.object({ deploymentId: z.string().uuid() })
const runParam = deploymentParam.extend({ runId: z.string().uuid() })
const acceptedSchema = z.object({ ok: z.literal(true) })
const enrollmentResponseSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() })
const errorSchema = z.object({ error: z.string(), message: z.string().optional() })

function readinessError(provider: "aws" | "gcp", error: "feature_disabled" | "release_not_configured") {
  const reason = error === "feature_disabled" ? "feature_disabled"
    : releaseReadiness(provider).reason === "invalid_configuration" ? "invalid_configuration" : "not_configured"
  return { error, message: managedDeploymentReadinessMessage({ provider, available: false, reason }) }
}

type DeploymentRow = typeof ManagedDeploymentTable.$inferSelect
type RunRow = typeof ManagedDeploymentRunTable.$inferSelect

// Agents may read readiness and status, record a deployment and prepare its
// cloud handoff. They never remove records or call installer/health endpoints.
// Generated operation ids (and SDK method names) are unchanged.
type McpExposure = { mcp: boolean }

type ManagedDeploymentRouteOptions = DescribeRouteOptions & { "x-mcp": boolean }
const describeManagedDeploymentRoute = (options: ManagedDeploymentRouteOptions) => describeRoute(options)

function operation(summary: string, description: string, response: z.ZodType, exposure: McpExposure, security?: Array<Record<string, string[]>>) {
  return describeManagedDeploymentRoute({
    tags: ["Managed deployments"], summary, description, "x-mcp": exposure.mcp, ...(security ? { security } : {}),
    responses: {
      200: jsonResponse(summary, response),
      400: jsonResponse("Invalid input.", errorSchema),
      401: jsonResponse("Authentication required.", errorSchema),
      403: jsonResponse("Owner or super-admin approval required.", errorSchema),
      404: jsonResponse("Deployment or feature unavailable.", errorSchema),
      409: jsonResponse("The deployment cannot accept this operation now.", errorSchema),
      429: jsonResponse("Too many attempts.", errorSchema),
      503: jsonResponse("No installer release is configured.", errorSchema),
    },
  })
}

function awsTarget(row: DeploymentRow) {
  return awsTargetSchema.parse(row.target)
}

function releaseFor(row: DeploymentRow): ManagedDeploymentRelease | null {
  return row.provider === "aws" ? awsRelease() : row.provider === "gcp" ? gcpRelease() : null
}

function launchDetails(row: DeploymentRow, run: RunRow) {
  const common = {
    deploymentId: row.id, runId: run.id, challenge: run.challenge, domainName: row.domain_name,
    ownerEmail: row.owner_email, size: row.size,
    release: { templateUrl: run.template_url, bundleUrl: run.bundle_url, bundleSha256: run.bundle_sha256, version: run.version, apiOrigin: run.api_origin },
  }
  if (row.provider === "gcp") {
    const target = gcpTargetSchema.parse(row.target)
    const command = cloudShellCommand({ ...common, target } satisfies GcpLaunch)
    return {
      approvalUrl: null, command,
      handoff: {
        action: "run_in_cloud_shell" as const, url: gcpCloudShellUrl(target.projectId), command,
        instructions: `Open Google Cloud Shell for project ${target.projectId}, then paste and run the command. It verifies the pinned installer, asks you to type the project ID to approve, and only then creates billable resources.`,
      },
    }
  }
  const launch: AwsLaunch = { ...common, target: awsTarget(row) }
  if (run.kind === "install") {
    const url = quickCreateUrl(launch)
    return {
      approvalUrl: url, command: null,
      handoff: {
        action: "open_link" as const, url, command: null,
        instructions: `Open the link signed in to AWS account ${launch.target.accountId}, review the installer permissions, acknowledge IAM and choose Create stack. Nothing is created until you do.`,
      },
    }
  }
  const command = updateStackCommand(launch)
  return {
    approvalUrl: null, command,
    handoff: {
      action: "run_in_cloud_shell" as const, url: awsCloudShellUrl(launch.target.region), command,
      instructions: `Open AWS CloudShell signed in to account ${launch.target.accountId}, then paste and run the command. It checks the account and updates only the existing installer; nothing is deleted.`,
    },
  }
}

function gcpCloudShellUrl(projectId: string) {
  return `https://console.cloud.google.com/?project=${encodeURIComponent(projectId)}&cloudshell=true`
}

function awsCloudShellUrl(region: string) {
  return `https://${region}.console.aws.amazon.com/cloudshell/home?region=${region}`
}

async function deploymentViews(rows: DeploymentRow[], now = new Date()): Promise<ManagedDeployment[]> {
  if (!rows.length) return []
  const runIds = rows.flatMap((row) => row.active_run_id ? [row.active_run_id] : [])
  const runs = runIds.length ? await db.select().from(ManagedDeploymentRunTable).where(inArray(ManagedDeploymentRunTable.id, runIds)) : []
  const events = runIds.length ? await db.select().from(ManagedDeploymentEventTable).where(inArray(ManagedDeploymentEventTable.run_id, runIds)).orderBy(asc(ManagedDeploymentEventTable.sequence)) : []
  const health = await db.select().from(ManagedDeploymentHealthTable).where(inArray(ManagedDeploymentHealthTable.deployment_id, rows.map((row) => row.id)))
  return rows.map((row) => {
    const run = runs.find((entry) => entry.id === row.active_run_id) ?? null
    const report = health.find((entry) => entry.deployment_id === row.id) ?? null
    const checks = report ? z.array(healthCheckSchema).catch([]).parse(report.checks) : []
    const available = releaseFor(row)?.version ?? null
    const installed = report?.version ?? row.installed_version
    const target = row.provider === "gcp" ? gcpTargetSchema.parse(row.target) : awsTarget(row)
    return managedDeploymentSchema.parse({
      id: row.id, name: row.name, provider: row.provider, target, domainName: row.domain_name, ownerEmail: row.owner_email,
      size: row.size, updateMode: "approval", createdAt: row.created_at.toISOString(), webUrl: `https://${row.domain_name}`,
      consoleUrl: row.provider === "gcp" ? gcpConsoleUrl(gcpTargetSchema.parse(row.target).projectId) : consoleUrl(row.id, target.region), installedVersion: installed, availableVersion: available,
      updateAvailable: Boolean(installed && available && (compareVersions(installed, available) ?? 0) < 0),
      health: summarizeHealth({ checks, reportedAt: report?.reported_at ?? null, version: report?.version ?? null }, now),
      run: run ? {
        id: run.id, kind: run.kind, version: run.version, state: run.state, createdAt: run.created_at.toISOString(),
        lastSeenAt: run.last_seen_at?.toISOString() ?? null, expiresAt: run.expires_at.toISOString(),
        expired: run.expires_at < now && (run.state === "awaiting_approval" || run.state === "provisioning"),
        events: events.filter((event) => event.run_id === run.id).map((event) => ({
          sequence: event.sequence, step: event.step, outcome: event.outcome,
          ...(event.error_code ? { errorCode: event.error_code } : {}), receivedAt: event.received_at.toISOString(),
        })),
      } : null,
    })
  })
}

async function oneView(row: DeploymentRow) {
  const [view] = await deploymentViews([row])
  if (!view) throw new Error("deployment view missing")
  return view
}

function bearerToken(header: string | undefined) {
  const token = header?.replace(/^Bearer /, "") ?? ""
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function registerManagedDeploymentRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(`${PATH}/configuration`, operation("Read which clouds can be launched", "Lists the clouds this OpenWork environment can install into and the published installer version for each. Agents call this first: available true means enabled and configured for preparing approval, not approved, started or healthy. Otherwise relay its message and missing field names to the person's OpenWork operator.", managedDeploymentConfigurationSchema, { mcp: true }),
    orgPermissionRoute("deployments.view"), requireFeature("managedDeployments"), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const enabled = await organizationFeatureEnabled(org.organization.id, "managedDeploymentsGcp")
      const gcp = releaseReadiness("gcp")
      const configuration = managedDeploymentConfigurationSchema.parse({
        providers: [
          releaseReadiness("aws"),
          { provider: "azure", available: false, version: null, reason: "not_supported" },
          enabled ? gcp : { ...gcp, available: false, reason: "feature_disabled" },
        ],
        updateMode: "approval",
      })
      return c.json({ ...configuration, providers: configuration.providers.map((entry) => ({ ...entry, message: managedDeploymentReadinessMessage(entry) })) })
    })

  app.get(PATH, operation("List the organization's managed deployments", "Returns each installation in the organization's own cloud accounts with its latest installer run, health checks and available update. Agents distinguish each observed state: awaiting_approval means approval prepared, not approved; provisioning means the authenticated installer connected after approval; a succeeded services_ready event means services started, not healthy. Only health.state operational is healthy. Report failed events as problems and give the person webUrl only once healthy.", managedDeploymentListSchema, { mcp: true }),
    orgPermissionRoute("deployments.view"), requireFeature("managedDeployments"), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const rows = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.org_id, org.organization.id)).limit(100)
      return c.json({ deployments: await deploymentViews(rows) })
    })

  app.post(PATH, operation("Create a managed deployment", "Records a new installation target (cloud account or project, region, address). Nothing is launched or billed until an owner prepares and approves it in their cloud. Agents confirm the target, address and that the person's cloud account will be billed before calling this.", managedDeploymentSchema, { mcp: true }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), jsonValidator(managedDeploymentInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const body = c.req.valid("json")
      if (body.provider === "gcp" && !await organizationFeatureEnabled(org.organization.id, "managedDeploymentsGcp")) return c.json(readinessError("gcp", "feature_disabled"), 404)
      if (!(body.provider === "aws" ? awsRelease() : gcpRelease())) return c.json(readinessError(body.provider, "release_not_configured"), 503)
      const id = randomUUID()
      await db.insert(ManagedDeploymentTable).values({
        id, org_id: org.organization.id, provider: body.provider, name: body.name, target: body.target,
        domain_name: body.domainName, owner_email: body.ownerEmail, size: body.size,
      })
      const [row] = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, id)).limit(1)
      if (!row) return c.json({ error: "deployment_not_found" }, 404)
      return c.json(await oneView(row))
    })

  app.delete(`${PATH}/:deploymentId`, operation("Remove a deployment that was never installed", "Deletes a deployment record that never reached the customer's cloud. Installed deployments stay tracked and answer 409.", acceptedSchema, { mcp: false }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), paramValidator(deploymentParam), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const id = c.req.valid("param").deploymentId
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(ManagedDeploymentTable).where(and(eq(ManagedDeploymentTable.id, id), eq(ManagedDeploymentTable.org_id, org.organization.id))).limit(1).for("update")
        if (!row) return "missing"
        const runs = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.deployment_id, id))
        // Anything that reached the customer's cloud stays tracked; removing it would hide
        // billable resources. Only never-approved records can be removed.
        if (row.installed_version || runs.some((run) => run.state !== "awaiting_approval")) return "installed"
        await tx.delete(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.deployment_id, id))
        await tx.delete(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, id))
        return "deleted"
      })
      if (outcome === "missing") return c.json({ error: "deployment_not_found" }, 404)
      if (outcome === "installed") return c.json({ error: "deployment_installed" }, 409)
      return c.json({ ok: true })
    })

  app.post(`${PATH}/:deploymentId/launch`, operation("Prepare an install, retry or approved update", "Creates or reuses an installer run pinned to the published release and returns handoff: the one step the person takes in their own cloud. open_link: give them handoff.url to approve. run_in_cloud_shell: give them handoff.url and handoff.command to paste. This only prepares approval: it is not cloud approval, services started or healthy. OpenWork never runs it; repeating this call reopens the same pending run.", managedDeploymentLaunchSchema, { mcp: true }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), paramValidator(deploymentParam), jsonValidator(managedDeploymentLaunchInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const id = c.req.valid("param").deploymentId
      const { kind } = c.req.valid("json")
      const now = new Date()
      const result = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(ManagedDeploymentTable).where(and(eq(ManagedDeploymentTable.id, id), eq(ManagedDeploymentTable.org_id, org.organization.id))).limit(1).for("update")
        if (!row) return { error: "deployment_not_found", status: 404 } as const
        if (row.provider === "gcp" && !await organizationFeatureEnabled(org.organization.id, "managedDeploymentsGcp", { database: tx, lock: "share" })) return { ...readinessError("gcp", "feature_disabled"), status: 404 } as const
        const release = releaseFor(row)
        if (!release) return { ...readinessError(row.provider === "gcp" ? "gcp" : "aws", "release_not_configured"), status: 503 } as const
        const [active] = row.active_run_id ? await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, row.active_run_id)).limit(1) : []
        const live = active && active.expires_at > now && (active.state === "awaiting_approval" || active.state === "provisioning")
        // Reopening a prepared approval returns the same run (no duplicates).
        if (live && active.state === "awaiting_approval" && active.kind === kind) return { row, run: active }
        if (live) return { error: "deployment_run_in_progress", status: 409 } as const
        const everStarted = Boolean(row.installed_version) || Boolean(active && active.state !== "awaiting_approval")
        if (kind === "install" && everStarted) return { error: "installer_exists_use_retry_or_update", status: 409 } as const
        if (kind !== "install" && !everStarted) return { error: "not_installed", status: 409 } as const
        if (kind === "update") {
          const current = row.installed_version
          if (!current || (compareVersions(current, release.version) ?? 0) >= 0) return { error: "already_current", status: 409 } as const
        }
        if (active && active.state !== "failed" && active.state !== "ready") {
          await tx.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, active.id))
        }
        const runId = randomUUID()
        await tx.insert(ManagedDeploymentRunTable).values({
          id: runId, deployment_id: id, kind, version: release.version, template_url: release.templateUrl, bundle_url: release.bundleUrl,
          bundle_sha256: release.bundleSha256, api_origin: release.apiOrigin, challenge: randomBytes(32).toString("hex"),
          state: "awaiting_approval", expires_at: new Date(now.getTime() + RUN_LIFETIME_MS),
        })
        await tx.update(ManagedDeploymentTable).set({ active_run_id: runId }).where(eq(ManagedDeploymentTable.id, id))
        const [run] = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId)).limit(1)
        if (!run) return { error: "deployment_not_found", status: 404 } as const
        return { row: { ...row, active_run_id: runId }, run }
      })
      if ("error" in result) return c.json({ error: result.error, ...("message" in result ? { message: result.message } : {}) }, result.status)
      return c.json(managedDeploymentLaunchSchema.parse({
        deployment: await oneView(result.row), kind: result.run.kind,
        ...launchDetails(result.row, result.run),
        expiresAt: result.run.expires_at.toISOString(),
      }))
    })

  // ---- Customer-side installer and health agent (no user session) ----
  // These accept only identities the cloud verifies for this exact deployment. They
  // keep working when the feature is turned off so in-flight installs finish
  // and existing installations keep reporting; nothing new can be launched.

  app.post(`${PATH}/:deploymentId/runs/:runId/enroll`, operation("Enroll a customer-side installer run", "Called by the installer in the customer's cloud. Verifies its signed cloud identity and run challenge, then issues a single-use run token.", enrollmentResponseSchema, { mcp: false }, []),
    tokenRoute, paramValidator(runParam), jsonValidator(z.union([awsEnrollmentSchema, gcpEnrollmentSchema])), async (c) => {
      const { deploymentId, runId } = c.req.valid("param")
      const [row] = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1)
      const [run] = await db.select().from(ManagedDeploymentRunTable).where(and(eq(ManagedDeploymentRunTable.id, runId), eq(ManagedDeploymentRunTable.deployment_id, deploymentId))).limit(1)
      if (!row || !run || row.active_run_id !== run.id || (row.provider !== "aws" && row.provider !== "gcp")) return c.json({ error: "deployment_not_found" }, 404)
      if (run.state !== "awaiting_approval" || run.expires_at < new Date()) return c.json({ error: "deployment_run_conflict" }, 409)
      const retryAfter = await checkRateLimit(`managed-enroll:${runId}`, 10, 60_000, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited" }, 429)
      }
      try {
        const identity = c.req.valid("json")
        if (row.provider === "gcp") {
          const proof = gcpEnrollmentSchema.parse(identity)
          await verifyGcpIdentity({ idToken: proof.idToken, audience: enrollmentAudience(run.api_origin, deploymentId, runId, run.challenge), email: serviceAccountEmail(deploymentId, gcpTargetSchema.parse(row.target).projectId, "runner") })
        } else {
          const proof = awsEnrollmentSchema.parse(identity)
          await verifyAwsIdentity({ identity: proof.headers, expectedProof: enrollmentProof(runId, run.challenge), target: awsTarget(row), roleName: runnerRoleName(deploymentId) })
        }
      } catch {
        return c.json({ error: "identity_invalid" }, 401)
      }
      const audited = await attributeAuditRequest(c, { organizationId: row.org_id, ...auditServiceAttribution("managed-deployment", deploymentId) })
      if (!audited.ok) return audited.response
      const token = randomBytes(32).toString("base64url")
      const enrolled = await db.transaction(async (tx) => {
        const [deployment] = await tx.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1).for("update")
        if (!deployment || deployment.active_run_id !== runId) return false
        const [current] = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId)).limit(1).for("update")
        if (!current || current.state !== "awaiting_approval" || current.expires_at < new Date()) return false
        await tx.update(ManagedDeploymentRunTable).set({ state: "provisioning", token_hash: hashToken(token), last_seen_at: new Date() }).where(eq(ManagedDeploymentRunTable.id, runId))
        return true
      })
      if (!enrolled) return c.json({ error: "deployment_run_conflict" }, 409)
      c.header("Cache-Control", "no-store")
      return c.json({ token, expiresAt: run.expires_at.toISOString() })
    })

  app.post(`${PATH}/:deploymentId/runs/:runId/events`, operation("Report an installer milestone", "Called by an enrolled installer to report the next ordered milestone with an allowlisted outcome code.", acceptedSchema, { mcp: false }, [{ bearerAuth: [] }]),
    tokenRoute, paramValidator(runParam), jsonValidator(deploymentEventInputSchema), async (c) => {
      const { deploymentId, runId } = c.req.valid("param")
      const token = bearerToken(c.req.header("authorization"))
      if (!token) return c.json({ error: "unauthorized" }, 401)
      const [row] = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1)
      if (!row || row.active_run_id !== runId) return c.json({ error: "deployment_not_found" }, 404)
      const [credential] = await db.select().from(ManagedDeploymentRunTable).where(and(eq(ManagedDeploymentRunTable.id, runId), eq(ManagedDeploymentRunTable.deployment_id, deploymentId))).limit(1)
      if (!credential || !tokenMatches(credential.token_hash, token) || credential.expires_at < new Date()) return c.json({ error: "unauthorized" }, 401)
      const audited = await attributeAuditRequest(c, { organizationId: row.org_id, ...auditServiceAttribution("managed-deployment", deploymentId) })
      if (!audited.ok) return audited.response
      const body = c.req.valid("json")
      const outcome = await db.transaction(async (tx) => {
        const [run] = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId)).limit(1).for("update")
        if (!run || !tokenMatches(run.token_hash, token) || run.expires_at < new Date()) return "unauthorized"
        const [existing] = await tx.select().from(ManagedDeploymentEventTable).where(and(eq(ManagedDeploymentEventTable.run_id, runId), eq(ManagedDeploymentEventTable.sequence, body.sequence))).limit(1)
        if (existing) return existing.step === body.step && existing.outcome === body.outcome && (existing.error_code ?? undefined) === body.errorCode ? "ok" : "conflict"
        if (run.state !== "provisioning" || !validateEventTransition(body, run.last_sequence)) return "conflict"
        const now = new Date()
        const ready = body.outcome === "succeeded" && body.step === "health_verified"
        await tx.insert(ManagedDeploymentEventTable).values({ id: randomUUID(), run_id: runId, sequence: body.sequence, step: body.step, outcome: body.outcome, error_code: body.errorCode ?? null, received_at: now })
        await tx.update(ManagedDeploymentRunTable).set({ last_sequence: body.sequence, last_seen_at: now, state: body.outcome === "failed" ? "failed" : ready ? "ready" : "provisioning" }).where(eq(ManagedDeploymentRunTable.id, runId))
        if (ready) await tx.update(ManagedDeploymentTable).set({ installed_version: run.version }).where(eq(ManagedDeploymentTable.id, deploymentId))
        return "ok"
      })
      if (outcome === "unauthorized") return c.json({ error: "unauthorized" }, 401)
      if (outcome === "conflict") return c.json({ error: "event_sequence_conflict" }, 409)
      return c.json({ ok: true })
    })

  app.post(`${PATH}/:deploymentId/heartbeat`, operation("Report installation health", "Called by the read-only health agent in the customer's cloud every 5 minutes. The signed identity is bound to the exact report body; replays are rejected.", acceptedSchema, { mcp: false }, []),
    tokenRoute, paramValidator(deploymentParam), async (c) => {
      const { deploymentId } = c.req.valid("param")
      const raw = await c.req.text()
      if (Buffer.byteLength(raw, "utf8") > MAX_HEARTBEAT_BYTES) return c.json({ error: "report_too_large" }, 400)
      const identity = awsSignedIdentitySchema.safeParse({
        authorization: c.req.header("x-openwork-aws-authorization"),
        "x-amz-date": c.req.header("x-openwork-aws-date"),
        "x-amz-security-token": c.req.header("x-openwork-aws-security-token"),
        "x-openwork-proof": c.req.header("x-openwork-proof"),
      })
      let parsedBody: unknown
      try { parsedBody = JSON.parse(raw) } catch { return c.json({ error: "invalid_report" }, 400) }
      const report = healthReportSchema.safeParse(parsedBody)
      if (!report.success) return c.json({ error: "invalid_report" }, 400)
      const [row] = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1)
      if (!row || (row.provider !== "aws" && row.provider !== "gcp")) return c.json({ error: "deployment_not_found" }, 404)
      if (row.provider === "gcp" && !report.data.nonce) return c.json({ error: "invalid_report" }, 400)
      const retryAfter = await checkRateLimit(`managed-heartbeat:${deploymentId}`, 30, 60 * 60_000, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited" }, 429)
      }
      const digest = createHash("sha256").update(raw).digest("hex")
      let signedAt: Date
      try {
        // The proof binds the signature to this deployment and this exact body.
        if (row.provider === "gcp") {
          const [run] = row.active_run_id ? await db.select().from(ManagedDeploymentRunTable).where(and(eq(ManagedDeploymentRunTable.id, row.active_run_id), eq(ManagedDeploymentRunTable.deployment_id, deploymentId))).limit(1) : []
          if (!run) throw new Error("identity_invalid")
          const authorization = c.req.header("authorization") ?? ""
          if (!authorization.startsWith("Bearer ")) throw new Error("identity_invalid")
          signedAt = await verifyGcpIdentity({ idToken: authorization.slice(7), audience: heartbeatAudience(run.api_origin, deploymentId, digest), email: serviceAccountEmail(deploymentId, gcpTargetSchema.parse(row.target).projectId, "health") })
        } else {
          if (!identity.success) throw new Error("identity_invalid")
          await verifyAwsIdentity({ identity: identity.data, expectedProof: heartbeatProof(deploymentId, digest), target: awsTarget(row), roleName: healthRoleName(deploymentId) })
          signedAt = amzDateToDate(identity.data["x-amz-date"])
        }
      } catch {
        return c.json({ error: "unauthorized" }, 401)
      }
      const audited = await attributeAuditRequest(c, { organizationId: row.org_id, ...auditServiceAttribution("managed-deployment", deploymentId) })
      if (!audited.ok) return audited.response
      const stored = await db.transaction(async (tx) => {
        // Serialize even the first report: a health row does not exist to lock yet.
        const [deployment] = await tx.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1).for("update")
        if (!deployment) return false
        const [previous] = await tx.select().from(ManagedDeploymentHealthTable).where(eq(ManagedDeploymentHealthTable.deployment_id, deploymentId)).limit(1).for("update")
        // Reject replays and out-of-order reports.
        if (previous && previous.signed_at >= signedAt) return false
        const values = { version: report.data.version ?? null, checks: report.data.checks, reported_at: new Date(), signed_at: signedAt }
        if (previous) await tx.update(ManagedDeploymentHealthTable).set(values).where(eq(ManagedDeploymentHealthTable.deployment_id, deploymentId))
        else await tx.insert(ManagedDeploymentHealthTable).values({ deployment_id: deploymentId, ...values })
        return true
      })
      if (!stored) return c.json({ error: "stale_report" }, 409)
      return c.json({ ok: true })
    })
}
