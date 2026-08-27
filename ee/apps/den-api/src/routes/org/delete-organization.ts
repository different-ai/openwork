import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthApiKeyTable,
  AuthSessionTable,
  AuditEventTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectedAccountTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSourceBindingTable,
  ConnectorSourceTombstoneTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  DaytonaSandboxTable,
  DesktopConnectGrantTable,
  DesktopPolicyMemberTable,
  DesktopPolicyTable,
  ExternalIdentityTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  InferenceKeyTable,
  InferenceOrgLimitPolicyTable,
  InferenceOrgUpstreamProviderKeyTable,
  InferenceOrgUsageBucketTable,
  InferenceUsageLedgerBucketChargeTable,
  InferenceUsageLedgerEntryTable,
  InstallLinkTable,
  InvitationTable,
  LlmProviderAccessTable,
  LlmProviderMemberCredentialTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrgOAuthClientTable,
  OrganizationBrandAssetTable,
  OrganizationDiagnosticCredentialTable,
  OrganizationRoleTable,
  OrganizationTable,
  OrgSubscriptionTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
  ScimGroupMemberTable,
  ScimGroupTable,
  ScimProviderTable,
  ScimSyncEventTable,
  ScimUserTombstoneTable,
  SsoConnectionTable,
  SsoProviderTable,
  TeamMemberTable,
  TeamTable,
  TelemetryEventTable,
  TelemetrySessionDimensionTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { cache } from "../../cache.js"
import { db } from "../../db.js"
import { completeLinearIssue, createLinearIssue, type LinearIssue } from "../../linear.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import { cancelOrganizationSubscriptions } from "../../stripe-billing.js"
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

      await cancelOrganizationSubscriptions({ organizationId })

      let affectedSessions: Array<{ id: typeof AuthSessionTable.$inferSelect.id; token: typeof AuthSessionTable.$inferSelect.token }> = []
      await db.transaction(async (tx) => {
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

        const installLinkIds = (await tx
          .select({ id: InstallLinkTable.id })
          .from(InstallLinkTable)
          .where(eq(InstallLinkTable.organizationId, organizationId)))
          .map((row) => row.id)
        if (installLinkIds.length > 0) {
          await tx.delete(DesktopConnectGrantTable).where(inArray(DesktopConnectGrantTable.installLinkId, installLinkIds))
        }

        const workerIds = (await tx
          .select({ id: WorkerTable.id })
          .from(WorkerTable)
          .where(eq(WorkerTable.org_id, organizationId)))
          .map((row) => row.id)
        if (workerIds.length > 0) {
          await tx.delete(WorkerInstanceTable).where(inArray(WorkerInstanceTable.worker_id, workerIds))
          await tx.delete(DaytonaSandboxTable).where(inArray(DaytonaSandboxTable.worker_id, workerIds))
          await tx.delete(WorkerTokenTable).where(inArray(WorkerTokenTable.worker_id, workerIds))
          await tx.delete(WorkerBundleTable).where(inArray(WorkerBundleTable.worker_id, workerIds))
        }

        const teamIds = (await tx
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(eq(TeamTable.organizationId, organizationId)))
          .map((row) => row.id)
        if (teamIds.length > 0) {
          await tx.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, teamIds))
        }

        const scimGroupIds = (await tx
          .select({ id: ScimGroupTable.id })
          .from(ScimGroupTable)
          .where(eq(ScimGroupTable.organizationId, organizationId)))
          .map((row) => row.id)
        if (scimGroupIds.length > 0) {
          await tx.delete(ScimGroupMemberTable).where(inArray(ScimGroupMemberTable.groupId, scimGroupIds))
        }

        const ledgerEntryIds = (await tx
          .select({ id: InferenceUsageLedgerEntryTable.id })
          .from(InferenceUsageLedgerEntryTable)
          .where(eq(InferenceUsageLedgerEntryTable.organization_id, organizationId)))
          .map((row) => row.id)
        if (ledgerEntryIds.length > 0) {
          await tx.delete(InferenceUsageLedgerBucketChargeTable).where(inArray(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, ledgerEntryIds))
        }

        const llmProviderIds = (await tx
          .select({ id: LlmProviderTable.id })
          .from(LlmProviderTable)
          .where(eq(LlmProviderTable.organizationId, organizationId)))
          .map((row) => row.id)
        if (llmProviderIds.length > 0) {
          await tx.delete(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, llmProviderIds))
          await tx.delete(LlmProviderAccessTable).where(inArray(LlmProviderAccessTable.llmProviderId, llmProviderIds))
        }

        affectedSessions = await tx
          .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
          .from(AuthSessionTable)
          .where(eq(AuthSessionTable.activeOrganizationId, organizationId))
        await tx.update(AuthSessionTable).set({ activeOrganizationId: null }).where(eq(AuthSessionTable.activeOrganizationId, organizationId))

        await tx.delete(OrganizationBrandAssetTable).where(eq(OrganizationBrandAssetTable.organizationId, organizationId))
        await tx.delete(WorkspaceClaimTable).where(eq(WorkspaceClaimTable.organizationId, organizationId))
        await tx.delete(WorkspaceBootstrapTable).where(eq(WorkspaceBootstrapTable.organizationId, organizationId))
        await tx.delete(InstallLinkTable).where(eq(InstallLinkTable.organizationId, organizationId))
        await tx.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.organizationId, organizationId))

        await tx.delete(ScimProviderTable).where(eq(ScimProviderTable.organizationId, organizationId))
        await tx.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.organizationId, organizationId))
        await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.organizationId, organizationId))
        await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.organizationId, organizationId))
        await tx.delete(ExternalIdentityTable).where(eq(ExternalIdentityTable.organizationId, organizationId))

        await tx.delete(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId))
        await tx.delete(WorkerTable).where(eq(WorkerTable.org_id, organizationId))
        await tx.delete(TelemetryEventTable).where(eq(TelemetryEventTable.org_id, organizationId))
        await tx.delete(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, organizationId))
        await tx.delete(TeamTable).where(eq(TeamTable.organizationId, organizationId))

        await tx.delete(OrgSubscriptionTable).where(eq(OrgSubscriptionTable.organization_id, organizationId))
        await tx.delete(ScimUserTombstoneTable).where(eq(ScimUserTombstoneTable.organizationId, organizationId))
        await tx.delete(ScimGroupTable).where(eq(ScimGroupTable.organizationId, organizationId))

        await tx.delete(InferenceUsageLedgerEntryTable).where(eq(InferenceUsageLedgerEntryTable.organization_id, organizationId))
        await tx.delete(InferenceKeyTable).where(eq(InferenceKeyTable.organization_id, organizationId))
        await tx.delete(InferenceOrgLimitPolicyTable).where(eq(InferenceOrgLimitPolicyTable.organization_id, organizationId))
        await tx.delete(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.organization_id, organizationId))
        await tx.delete(InferenceOrgUpstreamProviderKeyTable).where(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId))

        await tx.delete(DesktopPolicyMemberTable).where(eq(DesktopPolicyMemberTable.organizationId, organizationId))
        await tx.delete(DesktopPolicyTable).where(eq(DesktopPolicyTable.organizationId, organizationId))

        await tx.delete(OrganizationDiagnosticCredentialTable).where(eq(OrganizationDiagnosticCredentialTable.organizationId, organizationId))

        await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.organizationId, organizationId))
        await tx.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.organizationId, organizationId))
        await tx.delete(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.organizationId, organizationId))
        await tx.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
        await tx.delete(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.organizationId, organizationId))
        await tx.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.organizationId, organizationId))

        await tx.delete(LlmProviderTable).where(eq(LlmProviderTable.organizationId, organizationId))

        await tx.delete(ConnectorSourceTombstoneTable).where(eq(ConnectorSourceTombstoneTable.organizationId, organizationId))
        await tx.delete(ConnectorSourceBindingTable).where(eq(ConnectorSourceBindingTable.organizationId, organizationId))
        await tx.delete(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.organizationId, organizationId))
        await tx.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
        await tx.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, organizationId))
        await tx.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
        await tx.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
        await tx.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
        await tx.delete(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.organizationId, organizationId))
        await tx.delete(ConnectorMappingTable).where(eq(ConnectorMappingTable.organizationId, organizationId))
        await tx.delete(ConnectorTargetTable).where(eq(ConnectorTargetTable.organizationId, organizationId))
        await tx.delete(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.organizationId, organizationId))
        await tx.delete(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.organizationId, organizationId))
        await tx.delete(ConnectorAccountTable).where(eq(ConnectorAccountTable.organizationId, organizationId))
        await tx.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
        await tx.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
        await tx.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))

        await tx.delete(InvitationTable).where(eq(InvitationTable.organizationId, organizationId))
        await tx.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
        await tx.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
      })

      // Org deletion removes every member row; clear aggregate and per-user membership cache keys.
      await cache.org.deleteMembers(organizationId)
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
