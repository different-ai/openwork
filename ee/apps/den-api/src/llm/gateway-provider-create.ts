import { eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayAccessGrantWrite, GatewayProviderCredentialKind, GatewayProviderCredentialMode, GatewayProviderStatus } from "@openwork/types/den/gateway"
import { GatewayWriteError, gatewayCatalog, validateGatewaySettings, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, writeGatewaySet, type GatewayMemberId, type GatewayProvider, type GatewayTx } from "./gateway-matrix.js"

export type GatewayProviderCreateInput = {
  name: string;
  providerId: string;
  modelIds: string[];
  settings?: Record<string, unknown>;
  status?: GatewayProviderStatus;
  credentialMode?: GatewayProviderCredentialMode;
  credential?: { kind: GatewayProviderCredentialKind; secret: string };
  apiKeys?: Record<string, string>;
  oauthClientId?: string;
  oauthClientSecret?: string;
  allMembers?: boolean;
  memberIds?: string[];
  teamIds?: string[];
}
export type GatewayCreationCatalog = Awaited<ReturnType<typeof gatewayCatalog>>

export async function defaultMatrix(tx: GatewayTx, provider: GatewayProvider, input: GatewayProviderCreateInput, creatorId: GatewayMemberId) {
  const audiences: GatewayAccessGrantWrite["audience"][] = []
  if (input.allMembers) audiences.push({ type: "organization" })
  for (const memberId of new Set(input.memberIds ?? [])) audiences.push({ type: "member", memberId })
  for (const teamId of new Set(input.teamIds ?? [])) audiences.push({ type: "team", teamId })
  const hasCredentialInput = input.credential !== undefined || input.apiKeys !== undefined || input.credentialMode === "member" || input.oauthClientId !== undefined || input.oauthClientSecret !== undefined
  if (!hasCredentialInput && audiences.length) throw new GatewayWriteError(400, "credential_required", "Configure credentials before granting initial provider access.")
  const set = hasCredentialInput
    ? await writeGatewaySet(tx, provider, { name: "Default credentials", credentialMode: input.credentialMode ?? "org", credential: input.credential, apiKeys: input.apiKeys, oauthClientId: input.oauthClientId, oauthClientSecret: input.oauthClientSecret }, { createdByOrgMembershipId: creatorId })
    : null
  const models = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  if (!models.length && audiences.length) throw new GatewayWriteError(400, "model_required", "No supported catalog models are available for the requested initial access grants.")
  const groupId = await writeGatewayGroup(tx, provider, { name: "All Allowed Models", modelIds: models.map((model) => model.model_id) })
  if (!set) return { groupId, setId: null }
  for (const audience of audiences) await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
  return { groupId, setId: set.id }
}

export async function createGatewayProvider(tx: GatewayTx, organizationId: GatewayProvider["organization_id"], creatorId: GatewayMemberId, input: GatewayProviderCreateInput, catalog: GatewayCreationCatalog): Promise<GatewayProvider> {
  validateGatewaySettings(catalog.config, input.settings ?? {})
  const now = new Date()
  const provider: GatewayProvider = {
    id: createDenTypeId("inferenceProvider"), organization_id: organizationId, created_by_org_membership_id: creatorId,
    provider_id: catalog.catalog.id, name: input.name, model_ids: [...new Set(input.modelIds)], pinned_model_ids: [],
    provider_config: catalog.config, settings: input.settings ?? {}, credential_mode: input.credentialMode ?? "org",
    oauth_client_id: null, oauth_client_secret: null, status: input.status ?? "active", created_at: now, updated_at: now,
  }
  await tx.insert(GatewayProviderTable).values(provider)
  await writeGatewayModels(tx, provider, catalog.models)
  await defaultMatrix(tx, provider, input, creatorId)
  return provider
}
