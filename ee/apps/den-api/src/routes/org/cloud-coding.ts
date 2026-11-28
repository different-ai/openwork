import { createHash } from "node:crypto"
import { and, eq, lt } from "@openwork-ee/den-db/drizzle"
import { AuthVerificationTable, CloudCodingInstallationTable as Installations } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_CALLBACK_OUTCOMES, cloudCodingGithubCallbackInputSchema, cloudCodingGithubCallbackResultSchema, cloudCodingInstallationChoicesSchema, cloudCodingInstallCompleteInputSchema, cloudCodingInstallStartInputSchema, cloudCodingOverviewSchema, cloudCodingRedirectSchema, cloudCodingSettingsInputSchema, type CloudCodingCallbackErrorReason } from "@openwork/types/den/cloud-coding"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { getCloudCodingReadiness, writeAccess } from "../../cloud-coding/access.js"
import { cloudCodingInstallationAudit, recordCloudCodingEvent } from "../../cloud-coding/audit.js"
import { cloudCodingAppConfig, type CloudCodingAppConfig } from "../../cloud-coding/config.js"
import { buildAuthorizeUrl, buildInstallUrl, CloudCodingGithubError, exchangeOAuthCode, getAuthenticatedUser, listUserInstallations } from "../../cloud-coding/github-api.js"
import { availableCloudCodingInstallations, bindCloudCodingInstallation, duplicateCloudCodingEntry, syncCloudCodingInstallation } from "../../cloud-coding/installation.js"
import { getMemberGithubAccessToken, getMemberGithubLink, removeMemberGithubLink, saveMemberGithubLink, type CloudCodingMemberScope } from "../../cloud-coding/links.js"
import { sendCloudCodingAdminRequest, sendCloudCodingLinkReminder } from "../../cloud-coding/notifications.js"
import { cloudCodingOverview } from "../../cloud-coding/overview.js"
import { createCloudCodingState, verifyCloudCodingState } from "../../cloud-coding/state.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { hasPermission, type OrgRouteVariables } from "./shared.js"

const root = "/v1/cloud-coding"
const callbackPath = "/v1/cloud-coding/github/callback"
const sentSchema = z.object({ sent: z.literal(true) }).meta({ ref: "CloudCodingEmailSent" })
const errorSchema = z.object({ error: z.string(), message: z.string() })
type Outcome = (typeof CLOUD_CODING_CALLBACK_OUTCOMES)[number]

function docs(summary: string, description: string, schema?: z.ZodType) {
  return describeRoute({ tags: ["Organizations"], summary, description, responses: {
    ...(schema ? { 200: jsonResponse(summary, schema) } : { 204: emptyResponse(summary) }),
    400: jsonResponse("Check the information you entered.", invalidRequestSchema),
    401: jsonResponse("Sign in to continue.", unauthorizedSchema),
    403: jsonResponse("You do not have permission.", forbiddenSchema),
    404: jsonResponse("Cloud coding or this person is not available.", errorSchema),
    409: jsonResponse("Cloud coding is not ready for this action.", errorSchema),
    502: jsonResponse("GitHub could not complete the request.", errorSchema),
  } })
}

const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  try { await next() } catch (error) {
    if (!(error instanceof CloudCodingGithubError)) throw error
    return c.json({ error: "github_error", message: "GitHub could not complete the request. Try again in a moment." }, 502)
  }
}

function dashboard(kind: "install" | "link", outcome: Outcome, reason?: CloudCodingCallbackErrorReason) {
  return `${env.webUrl}/dashboard/cloud-coding${kind === "link" ? "/link" : ""}?${new URLSearchParams({ github: outcome, ...(reason ? { reason } : {}) })}`
}

const redirectUri = `${env.webUrl}/dashboard/cloud-coding/github/callback`

async function claimGithubCallbackState(state: NonNullable<ReturnType<typeof verifyCloudCodingState>>): Promise<boolean> {
  const now = new Date()
  if (state.exp <= now.getTime()) return false
  const identifier = `cloud-coding-github-callback:${state.memberId}`
  const id = createHash("sha256").update(`${identifier}:${state.nonce}`).digest("hex")
  await db.delete(AuthVerificationTable).where(and(eq(AuthVerificationTable.identifier, identifier), lt(AuthVerificationTable.expiresAt, now)))
  try {
    await db.insert(AuthVerificationTable).values({ id, identifier, value: "used", expiresAt: new Date(state.exp) })
    return true
  } catch (error) {
    if (duplicateCloudCodingEntry(error)) return false
    throw error
  }
}

const invalidCallbackState = { error: "state_invalid", message: "This GitHub link is invalid, has expired, or has already been used. Start again from Cloud coding." }
const callbackFailures = {
  not_configured: { status: 409, message: "Cloud coding has not been set up yet." },
  not_allowed: { status: 403, message: "You no longer have permission to finish this GitHub connection." },
  not_your_installation: { status: 403, message: "Your GitHub account cannot access this installation." },
  installation_in_use: { status: 409, message: "This GitHub installation is already connected to another organization." },
  account_in_use: { status: 409, message: "This GitHub account is already linked to someone else in this organization." },
} as const

function actor(context: OrgRouteVariables["organizationContext"]) {
  if (!context) throw new Error("Cloud coding requires an active organization.")
  return { organizationId: context.organization.id, memberId: context.currentMember.id, userId: context.currentMember.userId }
}

function notConfigured(c: Context) {
  return c.json({ error: "cloud_coding_not_configured", message: "Cloud coding has not been set up yet." }, 409)
}

async function choices(config: CloudCodingAppConfig, input: CloudCodingMemberScope) {
  const token = await getMemberGithubAccessToken(input)
  if (!token) return null
  return listUserInstallations({ config, token })
}

export function registerCloudCodingRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const manage = requireOrgPermission("connections.manage")
  const feature = requireFeature("cloudCoding")
  app.get(root, docs("View Cloud coding", "Returns the organization’s GitHub connection, access settings, people, repositories, and recent pull requests.", cloudCodingOverviewSchema), noStore, orgMemberRoute(), feature,
    async c => c.json(await cloudCodingOverview({ ...actor(c.get("organizationContext")), canManage: await hasPermission(c, "connections.manage") })))

  app.put("/v1/cloud-coding/settings", docs("Save Cloud coding settings", "Updates whether Cloud coding is on and which people or teams may use it. Requires permission to manage connections.", cloudCodingOverviewSchema), noStore, orgMemberRoute(), feature, manage, jsonValidator(cloudCodingSettingsInputSchema), async c => {
    const input = actor(c.get("organizationContext"))
    const settings = c.req.valid("json")
    const result = await db.transaction(async tx => {
      const [installation] = await tx.select().from(Installations).where(eq(Installations.organizationId, input.organizationId)).for("update")
      if (!installation) return "github_not_connected"
      if (settings.access && !await writeAccess(tx, { ...input, access: settings.access })) return "invalid_access"
      if (settings.enabled !== undefined) await tx.update(Installations).set({ enabled: settings.enabled }).where(eq(Installations.id, installation.id))
      await recordCloudCodingEvent(c, tx, "cloud_coding.settings.updated", input, { enabled: settings.enabled ?? installation.enabled, orgWide: settings.access?.orgWide ?? installation.accessOrgWide })
      return "saved"
    })
    if (result === "github_not_connected") return c.json({ error: result, message: "Connect GitHub before changing these settings." }, 409)
    if (result === "invalid_access") return c.json({ error: result, message: "Choose people and teams in this organization." }, 400)
    return c.json(await cloudCodingOverview({ ...input, canManage: true }))
  })

  app.post("/v1/cloud-coding/github/install/start", docs("Start connecting GitHub", "Connects an existing installation when possible or returns the address of the next GitHub setup step.", cloudCodingRedirectSchema), noStore, orgMemberRoute(), feature, manage, jsonValidator(cloudCodingInstallStartInputSchema), async c => {
    const config = cloudCodingAppConfig()
    if (!config) return notConfigured(c)
    const input = actor(c.get("organizationContext"))
    const reachable = await choices(config, input)
    if (reachable) {
      const available = await availableCloudCodingInstallations(input.organizationId, reachable)
      if (available.length > 1) return c.json({ redirectUrl: dashboard("install", "choose") })
      const [installation] = available
      if (installation) {
        const result = await bindCloudCodingInstallation({ ...input, installation, ...cloudCodingInstallationAudit(c, input.memberId) })
        return c.json({ redirectUrl: result.ok ? dashboard("install", "connected") : dashboard("install", "error", result.error) })
      }
    }
    const state = createCloudCodingState({ ...input, kind: "install" })
    const redirectUrl = !reachable && c.req.valid("json").existing ? buildAuthorizeUrl({ config, state, redirectUri }) : buildInstallUrl({ config, state })
    return c.json({ redirectUrl })
  })

  app.get("/v1/cloud-coding/github/installations", docs("List GitHub installations you can connect", "Returns installations reachable from the signed-in member’s linked GitHub account that are not connected to another organization.", cloudCodingInstallationChoicesSchema), noStore, orgMemberRoute(), feature, manage, async c => {
    const config = cloudCodingAppConfig()
    const input = actor(c.get("organizationContext"))
    const reachable = config ? await choices(config, input) : null
    const available = await availableCloudCodingInstallations(input.organizationId, reachable ?? [])
    return c.json({ installations: available.map(row => ({ installationId: row.id, accountLogin: row.account.login, accountType: row.account.type })) })
  })

  app.post("/v1/cloud-coding/github/install/complete", docs("Connect a GitHub installation", "Connects a GitHub App installation after checking that the signed-in member’s linked account can access it.", cloudCodingOverviewSchema), noStore, orgMemberRoute(), feature, manage, jsonValidator(cloudCodingInstallCompleteInputSchema), async c => {
    const config = cloudCodingAppConfig()
    if (!config) return notConfigured(c)
    const input = actor(c.get("organizationContext"))
    const { installationId } = c.req.valid("json")
    const installation = (await choices(config, input))?.find(row => row.id === installationId)
    if (!installation) return c.json({ error: "not_your_installation", message: "Your GitHub account cannot access this installation." }, 403)
    const result = await bindCloudCodingInstallation({ ...input, installation, ...cloudCodingInstallationAudit(c, input.memberId) })
    if (!result.ok) return result.error === "installation_in_use"
      ? c.json({ error: result.error, message: "This GitHub installation is already connected to another organization." }, 409)
      : c.json({ error: result.error, message: "You no longer have permission to connect GitHub." }, 403)
    return c.json(await cloudCodingOverview({ ...input, canManage: true }))
  })

  app.post("/v1/cloud-coding/github/sync", docs("Refresh GitHub repositories", "Refreshes the organization’s GitHub repository list and removes the connection if the app was uninstalled.", cloudCodingOverviewSchema), noStore, orgMemberRoute(), feature, manage, async c => {
    const input = actor(c.get("organizationContext"))
    await syncCloudCodingInstallation(input.organizationId, cloudCodingInstallationAudit(c, input.memberId).onDisconnected)
    return c.json(await cloudCodingOverview({ ...input, canManage: true }))
  })

  app.post("/v1/cloud-coding/github/link/start", docs("Start linking your GitHub account", "Returns the GitHub authorization page for the signed-in member.", cloudCodingRedirectSchema), noStore, orgMemberRoute(), feature, async c => {
    const input = actor(c.get("organizationContext"))
    const { readiness } = await getCloudCodingReadiness(input)
    const config = cloudCodingAppConfig()
    if (!config || readiness === "not_configured") return c.json({ error: "not_configured", message: "Cloud coding has not been set up yet." }, 409)
    if (readiness === "feature_disabled") return c.json({ error: readiness, message: "Cloud coding is not available." }, 404)
    if (readiness === "github_not_connected") return c.json({ error: readiness, message: "Ask an admin to connect GitHub first." }, 409)
    if (readiness === "turned_off") return c.json({ error: readiness, message: "Cloud coding is turned off in this organization." }, 409)
    if (readiness === "not_allowed") return c.json({ error: readiness, message: "Ask an admin for access to Cloud coding." }, 409)
    return c.json({ redirectUrl: buildAuthorizeUrl({ config, state: createCloudCodingState({ ...input, kind: "link" }), redirectUri }) })
  })

  app.delete("/v1/cloud-coding/github/link", docs("Unlink your GitHub account", "Removes the signed-in member’s link, cancels their open tasks, and tries to revoke access at GitHub."), noStore, orgMemberRoute(), feature, async c => {
    const input = actor(c.get("organizationContext"))
    await removeMemberGithubLink(input, (tx, link) => recordCloudCodingEvent(c, tx, "cloud_coding.account.unlinked", input, { githubLogin: link.githubLogin }))
    return c.body(null, 204)
  })

  app.post(callbackPath, docs("Finish GitHub authorization", "Completes GitHub authorization for the signed-in member and organization that started it.", cloudCodingGithubCallbackResultSchema), noStore, orgMemberRoute(), feature, jsonValidator(cloudCodingGithubCallbackInputSchema), async c => {
    const session = c.get("session")
    if (!session || session.id === "mcp_internal" || c.get("apiKey")) {
      return c.json({ error: "unauthorized", message: "Sign in to OpenWork to finish linking GitHub." }, 401)
    }
    const { code, state: signedState, installationId } = c.req.valid("json")
    const state = verifyCloudCodingState(signedState)
    if (!state) return c.json(invalidCallbackState, 400)
    const input = actor(c.get("organizationContext"))
    if (state.userId !== input.userId || state.memberId !== input.memberId || state.organizationId !== input.organizationId) {
      return c.json({ error: "different_account", message: "This GitHub link was started from a different OpenWork account or organization. Start again from where you began." }, 409)
    }
    const failure = (error: keyof typeof callbackFailures) => {
      const { status, message } = callbackFailures[error]
      return c.json({ error, message }, status)
    }
    const config = cloudCodingAppConfig()
    if (!config) return failure("not_configured")
    if (state.kind === "install" && !(await resolvePermissionsForMember(input)).has("connections.manage")) return failure("not_allowed")
    if (!await claimGithubCallbackState(state)) return c.json(invalidCallbackState, 400)
    try {
      const tokens = await exchangeOAuthCode({ config, code, redirectUri })
      const user = await getAuthenticatedUser({ config, token: tokens.access_token })
      const link = await saveMemberGithubLink({ ...input, user, tokens, onLinked: (tx, linked) => recordCloudCodingEvent(c, tx, "cloud_coding.account.linked", input, { githubLogin: linked.githubLogin }) })
      if (!link.ok) return failure(link.error)
      if (state.kind === "link") return c.json({ outcome: "linked" })
      if (!(await resolvePermissionsForMember(input)).has("connections.manage")) return failure("not_allowed")
      const reachable = await listUserInstallations({ config, token: tokens.access_token })
      const available = installationId === undefined ? await availableCloudCodingInstallations(input.organizationId, reachable) : reachable.filter(row => row.id === installationId)
      if (installationId !== undefined && !available.length) return failure("not_your_installation")
      if (available.length > 1) return c.json({ outcome: "choose" })
      const [installation] = available
      if (!installation) return c.json({ outcome: "install", redirectUrl: buildInstallUrl({ config, state: createCloudCodingState({ ...input, kind: "install" }) }) })
      const bound = await bindCloudCodingInstallation({ ...input, installation, ...cloudCodingInstallationAudit(c, input.memberId) })
      return bound.ok ? c.json({ outcome: "connected" }) : failure(bound.error)
    } catch (error) {
      if (!(error instanceof CloudCodingGithubError)) throw error
      return c.json({ error: "github_error", message: "GitHub could not complete the request. Start again from Cloud coding." }, 502)
    }
  })

  app.post("/v1/cloud-coding/people/:memberId/send-link", docs("Send a GitHub link reminder", "Sends a GitHub account link reminder to an active member who has not linked an account.", sentSchema), noStore, orgMemberRoute(), feature, manage, async c => {
    const input = actor(c.get("organizationContext"))
    const target = c.req.param("memberId")
    if (!isDenTypeId("member", target)) return c.json({ error: "member_not_found", message: "This person is not in your organization." }, 404)
    const recipient = { ...input, memberId: target }
    if (await getMemberGithubLink(recipient)) return c.json({ error: "already_linked", message: "This person has already linked their GitHub account." }, 409)
    if (!await sendCloudCodingLinkReminder({ ...input, targetMemberId: target })) return c.json({ error: "member_not_found", message: "This person is not in your organization." }, 404)
    await db.transaction(tx => recordCloudCodingEvent(c, tx, "cloud_coding.link_reminder.sent", recipient))
    return c.json({ sent: true })
  })

  app.post("/v1/cloud-coding/admin-requests", docs("Ask an admin for Cloud coding access", "Emails the organization’s owners and admins on behalf of the signed-in member.", sentSchema), noStore, orgMemberRoute(), feature, async c => {
    const input = actor(c.get("organizationContext"))
    if (!await sendCloudCodingAdminRequest(input)) return c.json({ error: "admin_not_found", message: "No organization admin is available to receive your request." }, 409)
    await db.transaction(tx => recordCloudCodingEvent(c, tx, "cloud_coding.admin_request.sent", input))
    return c.json({ sent: true })
  })
}
