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
  LlmProviderModelTable,
  LlmProviderTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  MemoryContextTable,
  MemoryTable,
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
  TelegramChatBindingTable,
  TelegramConnectionTable,
  TelegramPairingTable,
  TelegramUpdateTable,
  TelemetryEventTable,
  TelemetrySessionDimensionTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimTable,
} from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import { cancelOrganizationSubscriptions } from "../../stripe-billing.js"
import { ensureOwner, orgAccessFailureStatus, type OrgRouteVariables } from "./shared.js"

type OrganizationMemberId = typeof MemberTable.$inferSelect.id
type UserId = typeof MemberTable.$inferSelect.userId

type ParsedApiKeyMetadata = {
  organizationId: string
  orgMembershipId: string
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

      await cancelOrganizationSubscriptions({ organizationId })

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

        const telegramConnectionIds = (await tx
          .select({ id: TelegramConnectionTable.id })
          .from(TelegramConnectionTable)
          .where(eq(TelegramConnectionTable.organizationId, organizationId)))
          .map((row) => row.id)
        if (telegramConnectionIds.length > 0) {
          await tx.delete(TelegramPairingTable).where(inArray(TelegramPairingTable.connectionId, telegramConnectionIds))
          await tx.delete(TelegramChatBindingTable).where(inArray(TelegramChatBindingTable.connectionId, telegramConnectionIds))
          await tx.delete(TelegramUpdateTable).where(inArray(TelegramUpdateTable.connectionId, telegramConnectionIds))
        }

        const memoryIds = (await tx
          .select({ id: MemoryTable.id })
          .from(MemoryTable)
          .where(eq(MemoryTable.org_id, organizationId)))
          .map((row) => row.id)
        if (memoryIds.length > 0) {
          await tx.delete(MemoryContextTable).where(inArray(MemoryContextTable.memory_id, memoryIds))
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

        await tx.delete(TelegramConnectionTable).where(eq(TelegramConnectionTable.organizationId, organizationId))
        await tx.delete(OrganizationDiagnosticCredentialTable).where(eq(OrganizationDiagnosticCredentialTable.organizationId, organizationId))
        await tx.delete(MemoryTable).where(eq(MemoryTable.org_id, organizationId))

        await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.organizationId, organizationId))
        await tx.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.organizationId, organizationId))
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

      logger.info("organization deleted", {
        organization_id: organizationId,
        organization_name: organization.name,
        actor_org_membership_id: payload.currentMember.id,
        actor_user_id: payload.currentMember.userId,
      })

      return c.json({ ok: true, organization: { id: organizationId, name: organization.name } })
    },
  )
}
