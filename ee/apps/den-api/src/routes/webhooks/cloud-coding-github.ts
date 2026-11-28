import { and, eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingInstallationTable as Installations, CloudCodingPullRequestTable as Pulls } from "@openwork-ee/den-db/schema"
import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { attributeAuditRequest, auditServiceAttribution } from "../../audit/request-capture.js"
import { cloudCodingInstallationAudit } from "../../cloud-coding/audit.js"
import { cloudCodingAppConfig } from "../../cloud-coding/config.js"
import { CloudCodingGithubError, verifyCloudCodingGithubSignature } from "../../cloud-coding/github-api.js"
import { getCloudCodingInstallationByGithubId, removeCloudCodingInstallation, syncCloudCodingInstallation } from "../../cloud-coding/installation.js"
import { removeGithubLinksForGithubUser } from "../../cloud-coding/links.js"
import { db } from "../../db.js"
import { signedWebhookRoute } from "../../middleware/index.js"
import { emptyResponse, jsonResponse } from "../../openapi.js"

const identity = z.object({ id: z.number().int().positive() })
const action = z.object({ action: z.string() })
const installation = action.extend({ installation: identity.extend({ suspended_at: z.string().datetime({ offset: true }).nullish() }) })
const revoke = action.extend({ sender: identity })
const pull = installation.extend({ repository: identity, pull_request: z.object({
  number: z.number().int().positive(), title: z.string(), merged: z.boolean().optional(),
  merged_at: z.string().datetime({ offset: true }).nullish(), closed_at: z.string().datetime({ offset: true }).nullish(),
}) })
const response = z.union([z.object({ ignored: z.literal(true) }), z.object({ ok: z.literal(true) })])

export function registerCloudCodingGithubWebhook<T extends Env>(app: Hono<T>) {
  app.post("/v1/webhooks/cloud-coding/github", describeRoute({ tags: ["Webhooks"], security: [], summary: "Receive Cloud coding GitHub events", description: "Verifies the GitHub App signature and updates the connection, repository list, or pull requests for the affected organization.", responses: {
    200: jsonResponse("GitHub event acknowledged.", response), 401: emptyResponse("Invalid signature."), 503: emptyResponse("GitHub is unavailable."),
  } }), signedWebhookRoute, async c => {
    c.header("Cache-Control", "no-store")
    const secret = cloudCodingAppConfig()?.webhookSecret
    if (!secret) return c.body(null, 503)
    const raw = await c.req.text()
    if (!verifyCloudCodingGithubSignature(raw, c.req.header("x-hub-signature-256") ?? "", secret)) return c.body(null, 401)
    const event = c.req.header("x-github-event")
    const ignored = () => c.json({ ignored: true })
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return ignored() }
    if (event === "github_app_authorization") {
      const parsed = revoke.safeParse(payload)
      if (!parsed.success || parsed.data.action !== "revoked") return ignored()
      await removeGithubLinksForGithubUser(parsed.data.sender.id)
      return c.json({ ok: true })
    }
    const data = installation.safeParse(payload)
    if (!data.success) return ignored()
    const row = await getCloudCodingInstallationByGithubId(data.data.installation.id)
    if (!row) return ignored()
    const operation = data.data.action
    const sync = (event === "installation_repositories" && ["added", "removed"].includes(operation)) || (event === "repository" && ["renamed", "transferred", "deleted", "archived", "unarchived", "edited"].includes(operation))
    const updateInstallation = event === "installation" && ["deleted", "suspend", "unsuspend"].includes(operation)
    const updatePull = event === "pull_request" && ["closed", "reopened", "edited"].includes(operation)
    if (!sync && !updateInstallation && !updatePull) return ignored()
    const attributed = await attributeAuditRequest(c, { organizationId: row.organizationId, ...auditServiceAttribution("github-cloud-coding", null), origin: "webhook" })
    if (!attributed.ok) return attributed.response
    const audit = cloudCodingInstallationAudit(c)
    try {
      if (sync) await syncCloudCodingInstallation(row.organizationId, audit.onDisconnected)
      if (updateInstallation) {
        if (operation === "deleted") await removeCloudCodingInstallation(row, audit.onDisconnected)
        else await db.update(Installations).set({ suspendedAt: operation === "unsuspend" ? null : new Date(data.data.installation.suspended_at ?? Date.now()) }).where(eq(Installations.id, row.id))
      }
      if (updatePull) {
        const parsed = pull.safeParse(payload)
        if (!parsed.success) return ignored()
        const { repository, pull_request: request } = parsed.data
        const closedAt = request.closed_at ? new Date(request.closed_at) : new Date()
        const changes: Partial<typeof Pulls.$inferInsert> = operation === "edited" ? { title: request.title.slice(0, 512) } : operation === "reopened"
          ? { state: "open", closedAt: null, mergedAt: null } : { state: request.merged ? "merged" : "closed", closedAt, mergedAt: request.merged ? new Date(request.merged_at ?? closedAt) : null }
        await db.update(Pulls).set(changes).where(and(eq(Pulls.organizationId, row.organizationId), eq(Pulls.githubRepositoryId, repository.id), eq(Pulls.number, request.number)))
      }
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof CloudCodingGithubError) return c.body(null, 503)
      throw error
    }
  })
}
