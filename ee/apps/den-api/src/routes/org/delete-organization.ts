import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthApiKeyTable,
  AuthSessionTable,
  DeviceCodeTable,
  InvitationTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  TempFileTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { cache } from "../../cache.js"
import { coreHooks } from "../../core/hooks/index.js"
import { db } from "../../db.js"
import { completeLinearIssue, createLinearIssue, type LinearIssue } from "../../linear.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import { ensureOwner, orgAccessFailureStatus, type OrgRouteVariables } from "./shared.js"

type OrganizationMemberId = typeof MemberTable.$inferSelect.id
type OrganizationId = typeof OrganizationTable.$inferSelect.id
type UserId = typeof MemberTable.$inferSelect.userId

type ParsedApiKeyMetadata = {
  organizationId: string
  orgMembershipId: string
}

type DeletionRequestSnapshot = {
  memberCount: number | null
  organizationCreatedAt: string | null
}

const logger = appLogger.child({ component: "delete_organization" })

const deleteOrganizationResponseSchema = z.object({
  ok: z.literal(true),
  organization: z.object({
    id: denTypeIdSchema("organization"),
    name: z.string(),
  }),
}).meta({ ref: "DeleteOrganizationResponse" })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseApiKeyMetadata(value: unknown): ParsedApiKeyMetadata | null {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          const parsed: unknown = JSON.parse(value)
          return parsed
        } catch {
          return null
        }
      })()
    : value

  if (!isRecord(parsed)) {
    return null
  }

  const organizationId = typeof parsed.organizationId === "string" ? parsed.organizationId : null
  const orgMembershipId = typeof parsed.orgMembershipId === "string" ? parsed.orgMembershipId : null
  if (!organizationId || !orgMembershipId) {
    return null
  }

  return { organizationId, orgMembershipId }
}

function optionalHeader(headers: Headers, name: string) {
  const value = headers.get(name)?.trim()
  return value ? value : undefined
}

function collectLocationHeaders(headers: Headers) {
  const country = optionalHeader(headers, "cf-ipcountry")
    ?? optionalHeader(headers, "x-vercel-ip-country")
    ?? optionalHeader(headers, "x-country-code")
  const entries = [
    { label: "x-forwarded-for", value: optionalHeader(headers, "x-forwarded-for") },
    { label: "cf-connecting-ip", value: optionalHeader(headers, "cf-connecting-ip") },
    { label: "x-real-ip", value: optionalHeader(headers, "x-real-ip") },
    { label: "country", value: country },
  ]

  const lines: string[] = []
  for (const entry of entries) {
    if (entry.value) {
      lines.push(`${entry.label}: ${entry.value}`)
    }
  }

  return lines.length > 0 ? lines.join("\n") : "not provided"
}

function confirmationStringFromBody(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  if (!isRecord(value)) {
    return null
  }

  for (const key of ["confirmation", "confirmationString", "confirmationText", "confirm", "organizationName"]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }

  return null
}

async function readConfirmationString(request: Request) {
  if (!request.body) {
    return "not provided by endpoint"
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return "request body present but could not be read"
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return "request body present but no confirmation string found"
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    return trimmed
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return confirmationStringFromBody(parsed) ?? "request body present but no confirmation string found"
  } catch {
    return "request body present but JSON could not be parsed"
  }
}

function dateToAuditString(value: Date | string | null | undefined) {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return typeof value === "string" && value.trim() ? value : null
}

async function readDeletionRequestSnapshot(organizationId: OrganizationId): Promise<DeletionRequestSnapshot> {
  try {
    const memberRows = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(eq(MemberTable.organizationId, organizationId))
    const organizationRows = await db
      .select({ createdAt: OrganizationTable.createdAt })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))

    return {
      memberCount: memberRows.length,
      organizationCreatedAt: dateToAuditString(organizationRows[0]?.createdAt),
    }
  } catch (error) {
    logger.warn("failed to read organization deletion snapshot", { error, organization_id: organizationId })
    return { memberCount: null, organizationCreatedAt: null }
  }
}

function formatNullable(value: string | null | undefined) {
  return value?.trim() ? value : "not available"
}

function buildAccountDeletionIssueDescription(input: {
  timestamp: string
  requestId: string
  requesterUserId: string | null | undefined
  requesterEmail: string | null | undefined
  requesterName: string | null | undefined
  orgId: string
  orgName: string
  memberCount: number | null
  organizationCreatedAt: string | null
  databaseUserId: string | null | undefined
  confirmationString: string
  locationHeaders: string
}) {
  return [
    "Account deletion request",
    "",
    "Request source: self serve request",
    `Timestamp: ${input.timestamp}`,
    `Request ID: ${input.requestId}`,
    `Requester user ID: ${formatNullable(input.requesterUserId)}`,
    `Requester email: ${formatNullable(input.requesterEmail)}`,
    `Requester name: ${formatNullable(input.requesterName)}`,
    `Database user id: ${formatNullable(input.databaseUserId)}`,
    `Organization ID: ${input.orgId}`,
    `Organization name: ${input.orgName}`,
    `Number of members: ${input.memberCount ?? "not available"}`,
    `Organization creation date: ${input.organizationCreatedAt ?? "not available"}`,
    `Confirmation string: ${input.confirmationString}`,
    "",
    "Location headers:",
    input.locationHeaders,
  ].join("\n")
}

async function createAccountDeletionIssue(input: {
  request: Request
  orgId: OrganizationId
  orgName: string
  requesterUserId: string | null | undefined
  requesterEmail: string | null | undefined
  requesterName: string | null | undefined
  databaseUserId: string | null | undefined
}) {
  const requestId = createDenTypeId("request")
  const timestamp = new Date().toISOString()
  const [confirmationString, snapshot] = await Promise.all([
    readConfirmationString(input.request),
    readDeletionRequestSnapshot(input.orgId),
  ])
  const issue = await createLinearIssue({
    title: `[ACCOUNT DELETION]: ${input.orgId}`,
    description: buildAccountDeletionIssueDescription({
      timestamp,
      requestId,
      requesterUserId: input.requesterUserId,
      requesterEmail: input.requesterEmail,
      requesterName: input.requesterName,
      orgId: input.orgId,
      orgName: input.orgName,
      memberCount: snapshot.memberCount,
      organizationCreatedAt: snapshot.organizationCreatedAt,
      databaseUserId: input.databaseUserId,
      confirmationString,
      locationHeaders: collectLocationHeaders(input.request.headers),
    }),
  })
  return { issue, requestId }
}

async function completeAccountDeletionIssue(issue: LinearIssue | null) {
  if (!issue) {
    return
  }

  await completeLinearIssue({ issueId: issue.id })
}

export function registerDeleteOrganizationRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.delete(
    "/v1/org",
    orgRoleRoute(["owner"]),
    describeRoute({
      tags: ["Organizations"],
      summary: "Delete organization",
      description: "Permanently deletes the active organization and its organization-scoped data. Owners must have a fresh privileged session.",
      responses: {
        200: jsonResponse("Organization deleted successfully.", deleteOrganizationResponseSchema),
        401: jsonResponse("The caller must be signed in to delete an organization.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners with a fresh privileged session can delete organizations.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const payload = c.get("organizationContext")
      const organization = payload.organization
      const organizationId = organization.id
      const user = c.get("user")
      const accountDeletionIssue = await createAccountDeletionIssue({
        request: c.req.raw,
        orgId: organizationId,
        orgName: organization.name,
        requesterUserId: user?.id,
        requesterEmail: user?.email,
        requesterName: user?.name,
        databaseUserId: user?.id ?? payload.currentMember.userId,
      })

      // Modules may refuse or prepare deletion before anything is deleted
      // (billing cancels Stripe subscriptions here; a failure aborts).
      const refusal = await coreHooks.runGuards("org.deletion.pre", { organizationId })
      if (refusal) {
        return c.json({ error: refusal.code, message: refusal.message }, 403)
      }

      let affectedSessions: Array<{ id: typeof AuthSessionTable.$inferSelect.id; token: typeof AuthSessionTable.$inferSelect.token }> = []
      await db.transaction(async (tx) => {
        await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
          .where(eq(OrganizationTable.id, organizationId)).for("update")

        // Every module purges its organization-scoped rows (core/hooks/legacy
        // until each module plan registers from its manifest).
        await coreHooks.runTx("org.deletion.purge", { tx, organizationId })

        const memberRows = await tx
          .select({ id: MemberTable.id, userId: MemberTable.userId })
          .from(MemberTable)
          .where(eq(MemberTable.organizationId, organizationId))

        const memberUserIds: Exclude<UserId, null>[] = []
        const memberByUserId = new Map<string, OrganizationMemberId>()
        for (const member of memberRows) {
          if (member.userId) {
            memberUserIds.push(member.userId)
            memberByUserId.set(member.userId, member.id)
          }
        }

        if (memberUserIds.length > 0) {
          const apiKeyRows = await tx
            .select({ id: AuthApiKeyTable.id, metadata: AuthApiKeyTable.metadata, referenceId: AuthApiKeyTable.referenceId })
            .from(AuthApiKeyTable)
            .where(inArray(AuthApiKeyTable.referenceId, memberUserIds))
          const apiKeyIds = apiKeyRows
            .filter((apiKey) => {
              const ownerMemberId = memberByUserId.get(apiKey.referenceId)
              const metadata = parseApiKeyMetadata(apiKey.metadata)
              return Boolean(ownerMemberId && metadata && metadata.organizationId === organizationId && metadata.orgMembershipId === ownerMemberId)
            })
            .map((apiKey) => apiKey.id)

          if (apiKeyIds.length > 0) {
            await tx.delete(AuthApiKeyTable).where(inArray(AuthApiKeyTable.id, apiKeyIds))
          }
        }

        affectedSessions = await tx
          .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
          .from(AuthSessionTable)
          .where(eq(AuthSessionTable.activeOrganizationId, organizationId))
        await tx.update(AuthSessionTable).set({ activeOrganizationId: null }).where(eq(AuthSessionTable.activeOrganizationId, organizationId))
        // Previously orphaned (W0-05): pending device logins and temp files bound to this organization.
        await tx.delete(DeviceCodeTable).where(eq(DeviceCodeTable.organizationId, organizationId))
        await tx.delete(TempFileTable).where(eq(TempFileTable.organization_id, organizationId))

        await tx.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.organizationId, organizationId))
        await tx.delete(InvitationTable).where(eq(InvitationTable.organizationId, organizationId))
        await tx.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
        await tx.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
      })

      // Org deletion removes every member row; clear aggregate and per-user membership cache keys.
      await cache.org.deleteMembers(organizationId)
      await coreHooks.runPostCommit("org.deletion.post", { organizationId })
      await Promise.all(affectedSessions.flatMap((session) => [
        cache.auth.revokeSession(session.token),
        cache.auth.revokeSessionId(session.id),
      ]))

      logger.info("organization deleted", {
        organization_id: organizationId,
        organization_name: organization.name,
        actor_org_membership_id: payload.currentMember.id,
        actor_user_id: payload.currentMember.userId,
        account_deletion_request_id: accountDeletionIssue.requestId,
        account_deletion_request_type: "self serve request",
        linear_issue_created: Boolean(accountDeletionIssue.issue),
        linear_issue_id: accountDeletionIssue.issue?.id,
      })

      await completeAccountDeletionIssue(accountDeletionIssue.issue)

      return c.json({ ok: true, organization: { id: organizationId, name: organization.name } })
    },
  )
}
