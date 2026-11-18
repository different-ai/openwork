import { randomBytes, randomUUID } from "node:crypto"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { planDeploymentConfigurationChange } from "@openwork/managed-deployments/configuration"
import {
  deploymentConfigurationChangeInputSchema, deploymentConfigurationChangeRecordSchema, deploymentConfigurationChangeResultSchema,
  deploymentConfigurationErrorSchema, normalizeAwsTargetForView, type DeploymentConfigurationField,
} from "@openwork/managed-deployments/schema"
import type { Hono } from "hono"
import {
  managedDeploymentConfigurationChangeRequestedEvent, managedDeploymentConfigurationChangeWithdrawnEvent, managedDeploymentRenamedEvent,
} from "../../audit/domain/managed-deployments.js"
import { appendDomainChanges } from "../../audit/domain/legacy.js"
import { auditChangeCapture, type AuditChangeEventInput } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { organizationFeatureEnabled, requireFeature, type FeatureKey } from "../../features.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { managedDeploymentApiOrigin } from "../../managed-deployments/config.js"
import {
  canonicalJson, configurationBasis, configurationChangeRecord, configurationRevision, recordedConfiguration, withdrawConfigurationChange,
  type ConfigurationChangeRecord, type DeploymentRow, type RunRow,
} from "../../managed-deployments/configuration.js"
import { effectiveInstallerRelease } from "../../managed-deployments/releases.js"
import { jsonValidator, orgPermissionRoute, paramValidator } from "../../middleware/index.js"
import { RUN_LIFETIME_MS, deploymentParam, launchDetails, oneView, operation } from "./managed-deployments.js"
import type { OrgRouteVariables } from "./shared.js"

// Each refusal carries the sentence the dashboard shows as is.
const MESSAGES = {
  deployment_not_found: "This deployment no longer exists. Reload the page.",
  configuration_aws_only: "Only AWS deployments can be edited after installation.",
  no_changes: "Nothing was changed.",
  not_installed: "This deployment isn't installed yet. Remove it and create it again to use different values.",
  run_in_progress: "An install, update or change is waiting for approval or running in AWS. Finish it first.",
  unfinished_run: "The last install, retry or update didn't finish. Finish it with Retry or Update, then edit the configuration.",
  installer_unknown: "OpenWork can't tell which installer this deployment runs. Update the deployment, then edit the configuration.",
  installer_unavailable: "This deployment's installer can no longer be run as it was installed. Update the deployment, then edit the configuration.",
  gateway_needs_current_installer: "The gateway runtime can be turned on only from the currently published installer. Update the deployment; Update can turn it on in the same step.",
  configuration_changed: "This deployment changed since you opened it. Check the current values and try again.",
  release_not_configured: "OpenWork's installer isn't configured. Ask your OpenWork operator.",
}
const FEATURE_OFF = "Configuration changes aren't turned on for this workspace. Ask your OpenWork contact."
const GATEWAY_FEATURE_OFF = "The gateway runtime isn't enabled for this workspace. Ask your OpenWork operator."

type RefusalStatus = 400 | 404 | 409 | 503
type Refusal = { refused: { status: RefusalStatus; body: { error: string; message: string; field?: DeploymentConfigurationField; feature?: FeatureKey } } }
type Prepared =
  | { outcome: "saved" | "withdrawn"; row: DeploymentRow; assistants: boolean }
  | { outcome: "approval_required"; row: DeploymentRow; run: RunRow; record: ConfigurationChangeRecord; assistants: boolean }

function refuse(status: RefusalStatus, error: keyof typeof MESSAGES): Refusal {
  return { refused: { status, body: { error, message: MESSAGES[error] } } }
}

function featureOff(feature: FeatureKey): Refusal {
  return { refused: { status: 404, body: { error: "feature_disabled", feature, message: feature === "managedDeploymentAssistants" ? GATEWAY_FEATURE_OFF : FEATURE_OFF } } }
}

function auditConfiguration(configuration: ConfigurationChangeRecord["requested"]) {
  return { ownerEmail: configuration.ownerEmail, target: normalizeAwsTargetForView(configuration.target) }
}

export function registerManagedDeploymentConfigurationRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post("/v1/managed-deployments/:deploymentId/configuration-changes", operation("Change an installed deployment's configuration", "Prepares a change to an installed AWS deployment at the installer version it already runs: the first administrator email, turning on the gateway runtime, or its cloud computers. Send the complete configuration with the revision it was read at. The answer is the command the owner runs in AWS CloudShell; the deployment's recorded configuration changes only when that approved run has verified health. A new name is saved at once. Sending the recorded configuration while a change awaits approval withdraws it. The address, AWS account, region, hosted zone and network are fixed at installation, and the gateway runtime cannot be turned off.", deploymentConfigurationChangeResultSchema, { mcp: false }, undefined, deploymentConfigurationErrorSchema),
    orgPermissionRoute("deployments.manage"), requireFeature("managedDeployments", FEATURE_OFF), requireFeature("managedDeploymentConfigUpdates", FEATURE_OFF), paramValidator(deploymentParam), jsonValidator(deploymentConfigurationChangeInputSchema), async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "organization_not_found" }, 404)
      const id = c.req.valid("param").deploymentId
      const body = c.req.valid("json")
      const published = await effectiveInstallerRelease("aws")
      const apiOrigin = managedDeploymentApiOrigin()
      const capture = auditChangeCapture(c)
      const now = new Date()
      const result = await db.transaction(async (tx): Promise<Refusal | Prepared> => {
        const [row] = await tx.select().from(ManagedDeploymentTable).where(and(eq(ManagedDeploymentTable.id, id), eq(ManagedDeploymentTable.org_id, org.organization.id))).limit(1).for("update")
        if (!row) return refuse(404, "deployment_not_found")
        const enabled = (key: FeatureKey) => organizationFeatureEnabled(org.organization.id, key, { database: tx, lock: "share", userId: org.currentMember.userId })
        if (!await enabled("managedDeployments")) return featureOff("managedDeployments")
        if (!await enabled("managedDeploymentConfigUpdates")) return featureOff("managedDeploymentConfigUpdates")
        // The row lock serializes this with launches, enrollment and installer milestones.
        const runs = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.deployment_id, id))
        const basis = configurationBasis(row, runs, published, now)
        if (basis.lock) return basis.lock === "aws_only" ? refuse(400, "configuration_aws_only") : refuse(409, basis.lock)
        const plan = planDeploymentConfigurationChange(recordedConfiguration(row), body.configuration)
        if (!plan.ok) return { refused: { status: 400, body: { error: plan.rejection.code, message: plan.rejection.message, ...(plan.rejection.field ? { field: plan.rejection.field } : {}) } } }
        const assistants = plan.needsAssistantsFeature
        if (assistants && !await enabled("managedDeploymentAssistants")) return featureOff("managedDeploymentAssistants")

        const subject = { organizationId: org.organization.id, deploymentId: id, name: plan.next.name }
        const recorded = { ownerEmail: row.owner_email, target: row.target }
        // Storage form: an unchanged target stays the row's own JSON, so a historical
        // record keeps omitting the parameters its installer template does not have.
        const requested = { ownerEmail: plan.next.ownerEmail, target: plan.targetChanged ? plan.next.target : row.target }
        const renamed = plan.next.name !== row.name
        // A new name is saved with whatever else the request does, and only when it is accepted.
        const save = async (events: (AuditChangeEventInput | null)[]) => {
          if (renamed) await tx.update(ManagedDeploymentTable).set({ name: plan.next.name }).where(eq(ManagedDeploymentTable.id, id))
          await appendDomainChanges(tx, capture, [renamed ? managedDeploymentRenamedEvent(subject, row.name, auditConfiguration(recorded)) : null, ...events])
        }
        const pending = basis.pending ? { run: basis.pending, record: configurationChangeRecord(basis.pending) } : null

        // Asking again for the change that is awaiting approval returns the same run and
        // command, whatever revision the caller read: a lost response is safe to resend.
        if (pending && pending.run.expires_at > now && canonicalJson(pending.record.requested) === canonicalJson(requested)) {
          await save([])
          return { outcome: "approval_required", row: { ...row, name: plan.next.name }, run: pending.run, record: pending.record, assistants }
        }
        if (body.expectedRevision !== configurationRevision(row)) return refuse(409, "configuration_changed")

        if (!plan.requiresApproval) {
          if (!pending && !renamed) return refuse(400, "no_changes")
          if (!pending) {
            await save([])
            return { outcome: "saved", row: { ...row, name: plan.next.name }, assistants }
          }
          // The recorded configuration was asked for again: the prepared change is discarded.
          await withdrawConfigurationChange(tx, row, pending.run)
          await save([managedDeploymentConfigurationChangeWithdrawnEvent(subject, {
            recorded: auditConfiguration(recorded), requested: auditConfiguration(pending.record.requested), changes: pending.record.changes,
            runId: pending.run.id, installerVersion: pending.run.version,
          })])
          return { outcome: "withdrawn", row: { ...row, name: plan.next.name, active_run_id: pending.record.restoresRunId }, assistants }
        }

        if (plan.enablesGateway && !basis.gatewayAvailable) return refuse(409, "gateway_needs_current_installer")
        if (!apiOrigin) return refuse(503, "release_not_configured")
        // An expired run, or the pending change this one replaces.
        if (basis.active && basis.active.state !== "failed" && basis.active.state !== "ready") {
          await tx.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, basis.active.id))
        }
        const runId = randomUUID()
        const record = deploymentConfigurationChangeRecordSchema.parse({
          version: 1, requestedBy: { memberId: org.currentMember.id, userId: org.currentMember.userId }, baseRunId: basis.base.id, restoresRunId: basis.restoresRunId,
          previous: recorded, requested, changes: plan.changes.filter((change) => change.field !== "name"),
        })
        // The installer that last succeeded, re-run with the requested parameters and reporting
        // to this API. The deployment keeps its recorded email and target until the run verifies health.
        await tx.insert(ManagedDeploymentRunTable).values({
          id: runId, deployment_id: id, kind: "configure", version: basis.base.version, template_url: basis.base.template_url, bundle_url: basis.base.bundle_url,
          bundle_sha256: basis.base.bundle_sha256, api_origin: apiOrigin, challenge: randomBytes(32).toString("hex"),
          state: "awaiting_approval", expires_at: new Date(now.getTime() + RUN_LIFETIME_MS), configuration_change: record,
        })
        await tx.update(ManagedDeploymentTable).set({ active_run_id: runId }).where(eq(ManagedDeploymentTable.id, id))
        const [run] = await tx.select().from(ManagedDeploymentRunTable).where(eq(ManagedDeploymentRunTable.id, runId)).limit(1)
        if (!run) return refuse(404, "deployment_not_found")
        await save([managedDeploymentConfigurationChangeRequestedEvent(subject, {
          recorded: auditConfiguration(recorded), requested: auditConfiguration(requested), changes: record.changes,
          runId, installerVersion: run.version, supersedesRunId: pending?.run.id ?? null,
        })])
        return { outcome: "approval_required", row: { ...row, name: plan.next.name, active_run_id: runId }, run, record, assistants }
      })
      if ("refused" in result) return c.json(result.refused.body, result.refused.status)
      if (result.assistants) markFeaturesUsed({ organizationId: org.organization.id, memberId: org.currentMember.id, keys: ["managedDeploymentAssistants"] })
      const deployment = await oneView(result.row, { primary: true, configuration: true })
      if (result.outcome !== "approval_required") return c.json(deploymentConfigurationChangeResultSchema.parse({ outcome: result.outcome, deployment }))
      // The handoff carries the requested configuration; the row keeps the recorded one until the run verifies health.
      const { run, record } = result
      return c.json(deploymentConfigurationChangeResultSchema.parse({
        outcome: "approval_required", deployment, kind: "configure",
        ...launchDetails({ ...result.row, target: record.requested.target, owner_email: record.requested.ownerEmail }, run),
        expiresAt: run.expires_at.toISOString(), changes: record.changes,
      }))
    })
}
