import { createHash, randomBytes, randomUUID } from "node:crypto"
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentAwsSignInTable, ManagedDeploymentEventTable, ManagedDeploymentHealthTable, ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import {
  awsEnrollmentSchema, awsSignedIdentitySchema, amzDateToDate, cloudShellUrl, consoleUrl, enrollmentProof, healthRoleName,
  heartbeatProof, quickCreateUrl, runnerRoleName, throughAccessPortal, updateStackCommand, verifyAwsIdentity, type AwsLaunch,
} from "@openwork/managed-deployments/aws"
import { cloudShellCommand, consoleUrl as gcpConsoleUrl, enrollmentAudience, gcpEnrollmentSchema, heartbeatAudience, serviceAccountEmail, verifyGcpIdentity, type GcpLaunch } from "@openwork/managed-deployments/gcp"
import { compareVersions, hashToken, summarizeHealth, tokenMatches, validateEventTransition } from "@openwork/managed-deployments/lifecycle"
import {
  assistantsEnabled, awsSignInInputSchema, awsSignInSchema, awsTargetSchema, normalizeAwsTargetForCreate, normalizeAwsTargetForView, gcpTargetSchema, deploymentEventInputSchema, healthCheckSchema, healthReportSchema, managedDeploymentConfigurationSchema,
  managedDeploymentInputSchema, managedDeploymentLaunchInputSchema, managedDeploymentLaunchSchema, managedDeploymentListSchema,
  managedDeploymentSchema, type AwsSignIn, type ManagedDeployment,
} from "@openwork/managed-deployments/schema"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { awsRelease, gcpRelease, releaseReadiness, type ManagedDeploymentRelease } from "../../managed-deployments/config.js"
import { jsonValidator, orgPermissionRoute, paramValidator, tokenRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { checkFixedWindowRateLimit, checkRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"

const PATH = "/v1/managed-deployments"
const RUN_LIFETIME_MS = 3 * 60 * 60 * 1000
const MAX_HEARTBEAT_BYTES = 16_384
const deploymentParam = z.object({ deploymentId: z.string().uuid() })
const runParam = deploymentParam.extend({ runId: z.string().uuid() })
const acceptedSchema = z.object({ ok: z.literal(true) })
const enrollmentResponseSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() })
const errorSchema = z.object({ error: z.string() })

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
  return normalizeAwsTargetForView(row.target)
}

function releaseFor(row: DeploymentRow): ManagedDeploymentRelease | null {
  return row.provider === "aws" ? awsRelease() : row.provider === "gcp" ? gcpRelease() : null
}

function launchDetails(row: DeploymentRow, run: RunRow, signIn: AwsSignIn | null) {
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
  const launch: AwsLaunch = {
    ...common, target: awsTarget(row), includeAssistantParameters: Object.hasOwn(row.target, "assistants"),
    includeRuntimeProfileParameter: Object.hasOwn(row.target, "runtimeProfile"),
  }
  if (run.kind === "install") {
    const url = throughAccessPortal(quickCreateUrl(launch), launch.target.accountId, signIn)
    return {
      approvalUrl: url, command: null,
      handoff: {
        action: "open_link" as const, url, command: null,
        instructions: signIn
          ? `Open the link. It signs you in to AWS account ${launch.target.accountId} through your access portal as ${signIn.roleName}, then opens the installer. Review the installer permissions, acknowledge IAM and choose Create stack. Nothing is created until you do.`
          : `Open the link signed in to AWS account ${launch.target.accountId}, review the installer permissions, acknowledge IAM and choose Create stack. Nothing is created until you do.`,
      },
    }
  }
  const command = updateStackCommand(launch)
  return {
    approvalUrl: null, command,
    handoff: {
      action: "run_in_cloud_shell" as const, url: throughAccessPortal(cloudShellUrl(launch.target.region), launch.target.accountId, signIn), command,
      instructions: `Open AWS CloudShell ${signIn ? `with the link, which signs you in to account ${launch.target.accountId} through your access portal` : `signed in to account ${launch.target.accountId}`}, then paste and run the command. It checks the account and updates only the existing installer; nothing is deleted.`,
    },
  }
}

function gcpCloudShellUrl(projectId: string) {
  return `https://console.cloud.google.com/?project=${encodeURIComponent(projectId)}&cloudshell=true`
}

/** The organization's saved AWS sign-in, or null when none is saved or the guided approval is off for it. */
async function awsSignInFor(org: { organization: { id: DeploymentRow["org_id"] }; currentMember: { userId: string } }, database: typeof db | typeof db.$primary = db): Promise<AwsSignIn | null> {
  if (!await organizationFeatureEnabled(org.organization.id, "managedDeploymentAwsSignIn", { userId: org.currentMember.userId })) return null
  const [row] = await database.select().from(ManagedDeploymentAwsSignInTable).where(eq(ManagedDeploymentAwsSignInTable.org_id, org.organization.id)).limit(1)
  if (!row) return null
  const saved = awsSignInSchema.safeParse({ portalUrl: row.portal_url, roleName: row.role_name })
  return saved.success ? saved.data : null
}

async function deploymentViews(rows: DeploymentRow[], signIn: AwsSignIn | null, now = new Date(), database: typeof db | typeof db.$primary = db): Promise<ManagedDeployment[]> {
  if (!rows.length) return []
  const runIds = rows.flatMap((row) => row.active_run_id ? [row.active_run_id] : [])
  const runs = runIds.length ? await database.select().from(ManagedDeploymentRunTable).where(inArray(ManagedDeploymentRunTable.id, runIds)) : []
  const events = runIds.length ? await database.select().from(ManagedDeploymentEventTable).where(inArray(ManagedDeploymentEventTable.run_id, runIds)).orderBy(asc(ManagedDeploymentEventTable.sequence)) : []
  const health = await database.select().from(ManagedDeploymentHealthTable).where(inArray(ManagedDeploymentHealthTable.deployment_id, rows.map((row) => row.id)))
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
      consoleUrl: row.provider === "gcp" ? gcpConsoleUrl(gcpTargetSchema.parse(row.target).projectId) : throughAccessPortal(consoleUrl(row.id, target.region), awsTarget(row).accountId, signIn), installedVersion: installed, availableVersion: available,
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

/** `primary` when the caller just wrote the deployment's run. */
async function oneView(row: DeploymentRow, signIn: AwsSignIn | null, options: { primary?: boolean } = {}) {
  const [view] = await deploymentViews([row], signIn, new Date(), options.primary ? db.$primary : db)
  if (!view) throw new Error("deployment view missing")
  return view
}

function launchError<S extends 400 | 404 | 409>(error: string, status: S) {
  return { error, status }
}

function bearerToken(header: string | undefined) {
  const token = header?.replace(/^Bearer /, "") ?? ""
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function registerManagedDeploymentRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(`${PATH}/configuration`, operation("Read which clouds can be launched", "Lists the clouds this OpenWork environment can install into and the published installer version for each. Agents call this first: only a provider with available true can be deployed; otherwise relay its reason and missing field names to the person.", managedDeploymentConfigurationSchema, { mcp: true }),
    orgPermissionRoute("deployments.view"), requireFeature("managedDeployments"), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const gcp = releaseReadiness("gcp")
      return c.json(managedDeploymentConfigurationSchema.parse({
        providers: [
          releaseReadiness("aws"),
          { provider: "azure", available: false, version: null, reason: "not_supported" },
          gcp,
        ],
        updateMode: "approval",
        assistantsAvailable: await organizationFeatureEnabled(org.organization.id, "managedDeploymentAssistants", { userId: org.currentMember.userId }),
        awsSignIn: await awsSignInFor(org),
      }))
    })

  app.put(`${PATH}/aws-sign-in`, operation("Save how the organization signs in to AWS", "Saves the organization's AWS access portal URL and the role to open the console with, or removes them with awsSignIn null. While saved, every AWS link (approval link, CloudShell, CloudFormation stack) opens through the portal in the deployment's own account, so an approver lands signed in to the right account. Only AWS-hosted access portal addresses are accepted.", awsSignInInputSchema, { mcp: false }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), requireFeature("managedDeploymentAwsSignIn"), jsonValidator(awsSignInInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const { awsSignIn } = c.req.valid("json")
      if (!awsSignIn) await db.delete(ManagedDeploymentAwsSignInTable).where(eq(ManagedDeploymentAwsSignInTable.org_id, org.organization.id))
      else await db.insert(ManagedDeploymentAwsSignInTable).values({ org_id: org.organization.id, portal_url: awsSignIn.portalUrl, role_name: awsSignIn.roleName })
        .onDuplicateKeyUpdate({ set: { portal_url: awsSignIn.portalUrl, role_name: awsSignIn.roleName } })
      markFeaturesUsed({ organizationId: org.organization.id, memberId: org.currentMember.id, keys: ["managedDeploymentAwsSignIn"] })
      return c.json({ awsSignIn })
    })

  app.get(PATH, operation("List the organization's managed deployments", "Returns each installation in the organization's own cloud accounts with its latest installer run, health checks and available update. Agents poll this after the person approves: report run.events as progress, a failed event's errorCode as the problem, and give the person webUrl only once health.state is operational.", managedDeploymentListSchema, { mcp: true }),
    orgPermissionRoute("deployments.view"), requireFeature("managedDeployments"), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const rows = await db.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.org_id, org.organization.id)).limit(100)
      return c.json({ deployments: await deploymentViews(rows, await awsSignInFor(org)) })
    })

  app.post(PATH, operation("Create a managed deployment", "Records a new installation target; nothing is launched or billed until the owner approves it in their cloud. Confirm the account/project, address and billing first. When configuration.assistantsAvailable is true, new AWS targets default to runtimeProfile gateway: Den, the native model gateway, managed runner, Workbot and Slack/Automations are included. Use that profile for new managed runtimes; explicit legacy preserves the core-only profile. Configure upstream providers and credentials in Models inside the installed Den after first sign-in, and the customer's Slack app in its Connectors. Never request or send a hosted model key, upstream endpoint or raw provider credentials here. Only computers are optional (off by default): Daytona is preferred and needs a computer snapshot; Daytona/Freestyle require the customer's plain-string Secrets Manager key ARN in this account/region and execute outside AWS. GCP retains its existing legacy flow.", managedDeploymentSchema, { mcp: true }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), jsonValidator(managedDeploymentInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const body = c.req.valid("json")
      if (!(body.provider === "aws" ? awsRelease() : gcpRelease())) return c.json({ error: "release_not_configured" }, 503)
      const id = randomUUID()
      const created = await db.transaction(async (tx) => {
        if (!await organizationFeatureEnabled(org.organization.id, "managedDeployments", { database: tx, lock: "share", userId: org.currentMember.userId })) return launchError("feature_disabled", 404)
        let target: Record<string, unknown> = body.target
        if (body.provider === "aws") {
          const available = await organizationFeatureEnabled(org.organization.id, "managedDeploymentAssistants", { database: tx, lock: "share", userId: org.currentMember.userId })
          if (!available && (body.target.runtimeProfile === "gateway" || assistantsEnabled(body.target.assistants))) return launchError("feature_disabled", 404)
          try {
            const normalized = normalizeAwsTargetForCreate(body.target, { gatewayByDefault: available })
            if (normalized.runtimeProfile === "legacy" && assistantsEnabled(normalized.assistants)) return launchError("gateway_profile_required", 400)
            target = normalized.runtimeProfile === "legacy"
              ? { accountId: normalized.accountId, region: normalized.region, route53ZoneId: normalized.route53ZoneId, network: normalized.network, ...(body.target.runtimeProfile ? { runtimeProfile: normalized.runtimeProfile } : {}) }
              : normalized
          } catch {
            return launchError("invalid_runtime_settings", 400)
          }
        }
        await tx.insert(ManagedDeploymentTable).values({
          id, org_id: org.organization.id, provider: body.provider, name: body.name, target,
          domain_name: body.domainName, owner_email: body.ownerEmail, size: body.size,
        })
        return { created: true }
      })
      if ("error" in created) return c.json({ error: created.error }, created.status)
      // Primary: reads back the row inserted above.
      const [row] = await db.$primary.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, id)).limit(1)
      if (!row) return c.json({ error: "deployment_not_found" }, 404)
      if (row.provider === "aws" && awsTarget(row).runtimeProfile === "gateway") markFeaturesUsed({ organizationId: org.organization.id, memberId: org.currentMember.id, keys: ["managedDeploymentAssistants"] })
      return c.json(await oneView(row, await awsSignInFor(org)))
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

  app.post(`${PATH}/:deploymentId/launch`, operation("Prepare an install, retry or approved update", "Creates or reuses an installer run pinned to the published release and returns the customer's cloud approval handoff. OpenWork never executes it. Existing AWS installations remain legacy until an explicit version-increasing Update supplies runtimeProfile gateway; Retry never changes profiles or computer settings. Gateway includes Den, the native model gateway, runner, Workbot and Slack/Automations; no direct model configuration is accepted as a new runtime. Upstream providers/keys and Slack app credentials are configured only inside the installed Den after first sign-in. Optional computers remain off unless selected. Profile and settings freeze atomically with the run: changed pending input returns 409; unchanged input reopens the identical command/run. Gateway-profile launches and reopening are blocked while configuration.assistantsAvailable is false; authenticated progress/health continue. GCP does not accept AWS profile/settings.", managedDeploymentLaunchSchema, { mcp: true }),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments"), paramValidator(deploymentParam), jsonValidator(managedDeploymentLaunchInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const id = c.req.valid("param").deploymentId
      const { kind, assistants, runtimeProfile } = c.req.valid("json")
      const now = new Date()
      const result = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(ManagedDeploymentTable).where(and(eq(ManagedDeploymentTable.id, id), eq(ManagedDeploymentTable.org_id, org.organization.id))).limit(1).for("update")
        if (!row) return { error: "deployment_not_found", status: 404 } as const
        if (!await organizationFeatureEnabled(org.organization.id, "managedDeployments", { database: tx, lock: "share", userId: org.currentMember.userId })) return { error: "feature_disabled", status: 404 } as const
        if ((assistants || runtimeProfile) && row.provider !== "aws") return launchError("assistants_aws_only", 400)
        const storedTarget = row.provider === "aws" ? awsTarget(row) : null
        const changedTarget = storedTarget && (assistants || runtimeProfile) ? awsTargetSchema.safeParse({
          ...storedTarget, ...(runtimeProfile ? { runtimeProfile } : {}), ...(assistants ? { assistants } : {}),
        }) : null
        const target = changedTarget?.success ? changedTarget.data : storedTarget
        const runtimeSettingsChanged = Boolean(changedTarget?.success && storedTarget && target && (storedTarget.runtimeProfile !== target.runtimeProfile || JSON.stringify(storedTarget.assistants) !== JSON.stringify(target.assistants)))
        if (target && (runtimeProfile || assistants || target.runtimeProfile === "gateway" || (storedTarget && assistantsEnabled(storedTarget.assistants)))
          && !await organizationFeatureEnabled(org.organization.id, "managedDeploymentAssistants", { database: tx, lock: "share", userId: org.currentMember.userId })) return launchError("feature_disabled", 404)
        const release = releaseFor(row)
        if (!release) return { error: "release_not_configured", status: 503 } as const
        const [active] = row.active_run_id ? await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, row.active_run_id)).limit(1) : []
        const live = active && active.expires_at > now && (active.state === "awaiting_approval" || active.state === "provisioning")
        if (live && runtimeProfile && storedTarget && runtimeProfile !== storedTarget.runtimeProfile) return launchError("deployment_settings_frozen", 409)
        if (changedTarget && !changedTarget.success) return launchError("invalid_runtime_settings", 400)
        // The target is frozen for the whole live run, including its approval URL.
        if (live && runtimeSettingsChanged) return launchError("deployment_settings_frozen", 409)
        if (runtimeSettingsChanged && target?.runtimeProfile === "legacy") return launchError("gateway_profile_required", 400)
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
        // One row lock and transaction bind the target to this run. No settings-only
        // write can change what an already-issued customer approval will install.
        const nextTarget = runtimeSettingsChanged && changedTarget?.success ? changedTarget.data : row.target
        await tx.update(ManagedDeploymentTable).set({ active_run_id: runId, target: nextTarget }).where(eq(ManagedDeploymentTable.id, id))
        const [run] = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId)).limit(1)
        if (!run) return { error: "deployment_not_found", status: 404 } as const
        return { row: { ...row, active_run_id: runId, target: nextTarget }, run }
      })
      if ("error" in result) return c.json({ error: result.error }, result.status)
      if (runtimeProfile || assistants || (result.row.provider === "aws" && (awsTarget(result.row).runtimeProfile === "gateway" || assistantsEnabled(awsTarget(result.row).assistants)))) markFeaturesUsed({ organizationId: org.organization.id, memberId: org.currentMember.id, keys: ["managedDeploymentAssistants"] })
      // Primary: an admin who just saved the sign-in prepares the approval next.
      const signIn = await awsSignInFor(org, db.$primary)
      return c.json(managedDeploymentLaunchSchema.parse({
        deployment: await oneView(result.row, signIn, { primary: true }), kind: result.run.kind,
        ...launchDetails(result.row, result.run, signIn),
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
      // Primary: the installer reports its first milestone right after enrolling set the token.
      const [row] = await db.$primary.select().from(ManagedDeploymentTable).where(eq(ManagedDeploymentTable.id, deploymentId)).limit(1)
      if (!row || row.active_run_id !== runId) return c.json({ error: "deployment_not_found" }, 404)
      const [credential] = await db.$primary.select().from(ManagedDeploymentRunTable).where(and(eq(ManagedDeploymentRunTable.id, runId), eq(ManagedDeploymentRunTable.deployment_id, deploymentId))).limit(1)
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
      const retryAfter = await checkFixedWindowRateLimit(`managed-heartbeat:${deploymentId}`, 30, 60 * 60_000, Date.now())
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
