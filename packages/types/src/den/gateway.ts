import type {
  GatewayAwsSsoSettings,
  InferenceProviderCredentialKind,
  InferenceProviderCredentialMode,
  InferenceProviderCredentialStatus,
  InferenceProviderStatus,
} from "./inference.js";

// Persisted enum values and secret formats are unchanged; Models billing stays
// in den/inference. Gateway consumers should use these canonical exports.
export {
  INFERENCE_PROVIDER_CREDENTIAL_KINDS as GATEWAY_PROVIDER_CREDENTIAL_KINDS,
  INFERENCE_PROVIDER_CREDENTIAL_MODES as GATEWAY_PROVIDER_CREDENTIAL_MODES,
  INFERENCE_PROVIDER_CREDENTIAL_STATUSES as GATEWAY_PROVIDER_CREDENTIAL_STATUSES,
  INFERENCE_PROVIDER_STATUSES as GATEWAY_PROVIDER_STATUSES,
  INFERENCE_REQUEST_OUTCOMES as GATEWAY_REQUEST_OUTCOMES,
  INFERENCE_REQUEST_PROTOCOLS as GATEWAY_REQUEST_PROTOCOLS,
  INFERENCE_REQUEST_ROUTES as GATEWAY_REQUEST_ROUTES,
  INFERENCE_ROLLUP_GRANULARITIES as GATEWAY_ROLLUP_GRANULARITIES,
  INFERENCE_USAGE_SOURCES as GATEWAY_USAGE_SOURCES,
  inferenceApiKeyMapSecretSchema as gatewayApiKeyMapSecretSchema,
  inferenceAwsKeysSecretSchema as gatewayAwsKeysSecretSchema,
  inferenceAwsSsoSecretSchema as gatewayAwsSsoSecretSchema,
  gatewayAwsSsoSettingsSchema,
  inferenceGcpServiceAccountSecretSchema as gatewayGcpServiceAccountSecretSchema,
  inferenceOauthTokenSecretSchema as gatewayOauthTokenSecretSchema,
  parseInferenceProviderSecret as parseGatewayProviderSecret,
} from "./inference.js";
export type {
  InferenceProviderCredentialKind as GatewayProviderCredentialKind,
  InferenceProviderCredentialMode as GatewayProviderCredentialMode,
  InferenceProviderCredentialStatus as GatewayProviderCredentialStatus,
  InferenceProviderStatus as GatewayProviderStatus,
  InferenceProviderSecret as GatewayProviderSecret,
  InferenceApiKeyMapSecret as GatewayApiKeyMapSecret,
  InferenceAwsKeysSecret as GatewayAwsKeysSecret,
  InferenceAwsSsoSecret as GatewayAwsSsoSecret,
  InferenceGcpServiceAccountSecret as GatewayGcpServiceAccountSecret,
  InferenceOauthTokenSecret as GatewayOauthTokenSecret,
  InferenceRequestOutcome as GatewayRequestOutcome,
  InferenceRequestProtocol as GatewayRequestProtocol,
  InferenceRequestRoute as GatewayRequestRoute,
  InferenceRollupGranularity as GatewayRollupGranularity,
  InferenceUsageSource as GatewayUsageSource,
} from "./inference.js";

export const GATEWAY_KEY_STATUSES = ["active", "revoked"] as const;
export type GatewayKeyStatus = (typeof GATEWAY_KEY_STATUSES)[number];
export type GatewayResourceStatus = InferenceProviderStatus;
export type GatewayCredentialStatus =
  | "ready"
  | "member_auth_required"
  | "org_credential_missing";

export type GatewayAudience =
  | { type: "organization" }
  | { type: "team"; teamId: string }
  | { type: "member"; memberId: string };

export interface GatewayModelGroupWrite {
  name: string;
  description?: string | null;
  /** Explicit configured catalog model IDs, not row/wire IDs. Empty means no models. */
  modelIds: string[];
  status?: GatewayResourceStatus;
}

export interface GatewayModelGroup {
  id: string;
  name: string;
  description: string | null;
  status: GatewayResourceStatus;
  modelIds: string[];
}

export interface GatewayCredentialSetWrite {
  name: string;
  credentialMode: InferenceProviderCredentialMode;
  /** Write-only; mutually exclusive with apiKeys. Omission retains encrypted material. */
  credential?: { kind: InferenceProviderCredentialKind; secret: string };
  apiKeys?: Record<string, string>;
  /** Omit to retain; empty string explicitly clears OAuth client configuration. */
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Microsoft Foundry member sets: the Entra ID directory (tenant) ID. Omit to retain; empty string clears. */
  oauthTenantId?: string;
  /** Amazon Bedrock member sets: the IAM Identity Center instance, account and permission set. Omit to retain; null clears. */
  awsSso?: GatewayAwsSsoSettings | null;
  status?: GatewayResourceStatus;
}

export interface GatewayCredentialSet {
  id: string;
  name: string;
  createdAt?: string;
  createdBy?: { id: string; name: string | null; email: string | null } | null;
  credentialMode: InferenceProviderCredentialMode;
  status: GatewayResourceStatus;
  /** Set configuration exists; not a successful upstream probe or consent. */
  configured: boolean;
  /** Readiness for this caller only; never evidence of another member's token. */
  credentialStatus: GatewayCredentialStatus;
  oauthClientId?: string | null;
  hasOauthClientSecret?: boolean;
  oauthTenantId?: string | null;
  awsSso?: GatewayAwsSsoSettings | null;
}

export interface GatewayAccessGrantWrite {
  modelGroupId: string;
  credentialSetId: string;
  audience: GatewayAudience;
}

export interface GatewayAccessGrant extends GatewayAccessGrantWrite {
  id: string;
}

export type GatewayModelGroupPatch = Partial<GatewayModelGroupWrite>;
export type GatewayCredentialSetPatch = Partial<GatewayCredentialSetWrite>;
export type GatewayAccessGrantPatch = Partial<GatewayAccessGrantWrite>;

export interface GatewayAuthorizationRequest {
  credentialSetId: string;
  name: string;
  authUrl: string;
  models?: GatewayUsableModel[];
}

/** Selection hints only. Reauthorize every referenced row on every request. */
export interface GatewaySelection {
  modelGroupId?: string;
  credentialSetId?: string;
  accessGrantId?: string;
}

export const GATEWAY_GRANT_HEADER = "x-openwork-gateway-grant-id";
// Diagnostic request metadata only; never authorizes or selects an upstream.
export const GATEWAY_REQUEST_MODEL_HEADER = "x-openwork-gateway-request-model";

export interface GatewaySelectionConflict {
  error: "gateway_selection_required";
  message: string;
  selections: Array<{
    modelGroupId: string;
    modelGroupName: string;
    credentialSetId: string;
    credentialSetName: string;
    accessGrantId: string;
  }>;
}

export interface GatewayUsableModel {
  /** gwm_<gmg suffix>_<gcs suffix>_<ipm suffix>, never a raw upstream ID. */
  id: string;
  name: string;
  /** config.id must equal id so SDK requests carry the selected combination. */
  config: Record<string, unknown> & { id: string };
  upstreamModelId: string;
  modelGroupId: string;
  modelGroupName: string;
  credentialSetId: string;
  credentialSetName: string;
}

export interface GatewayProviderMigration {
  llmProviderId: string;
  runtimeEnvNames: string[];
}

export interface GatewayProviderCredentialSummary {
  id: string;
  credentialSetId: string;
  subject: string;
  orgMembershipId: string | null;
  memberName: string | null;
  memberEmail: string | null;
  kind: InferenceProviderCredentialKind;
  status: InferenceProviderCredentialStatus;
  expiresAt: string | null;
}

export interface GatewayProviderSummary {
  /** Persisted ipr_ provider identity; groups do not create desktop providers. */
  id: string;
  providerId: string;
  name: string;
  source: "openwork_gateway";
  /** Aggregate compatibility hints only; individual sets are authoritative. */
  credentialMode: InferenceProviderCredentialMode;
  credentialStatus: GatewayCredentialStatus;
  authUrl: string | null;
  status: GatewayResourceStatus;
  /** Stored provider creation time; optional for compatibility with older servers. */
  createdAt?: string;
  updatedAt: string;
  providerConfig: Record<string, unknown>;
  /** Universe policy: [] follows all supported catalog models; nonempty restricts to these IDs. Never grants group membership. */
  modelIds: string[];
  /** Display when catalog refresh is unavailable or compatibility excludes catalog models. */
  catalogWarning?: string;
  models: GatewayUsableModel[];
  pinnedModelIds: string[];
  authorizationRequests: GatewayAuthorizationRequest[];
  migration?: GatewayProviderMigration;
  /** Legacy management hints. Never flatten these back into matrix writes. */
  access?: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
  settings?: Record<string, unknown>;
  oauthClientId?: string | null;
  oauthCallbackUrl?: string;
  hasOauthClientSecret?: boolean;
  /** Per-person credential rows; only for callers who hold Manage Gateway providers. */
  credentials?: GatewayProviderCredentialSummary[];
  /** Credential counts by status, returned instead of `credentials` to callers who may only view providers. */
  credentialCounts?: GatewayProviderCredentialCounts;
  /** Only the caller's ow_gw_ key, in provider-scoped env slots. */
  apiKey?: string;
  apiKeys?: Record<string, string>;
}

/**
 * LiteLLM provider state for management views. `org` uses one organization
 * key and OpenWork spend tracking; `member` uses each person's own LiteLLM
 * key, so LiteLLM owns budgets and OpenWork does not price or limit usage.
 */
export type GatewayLiteLlmAttentionReason = "not_in_litellm" | "no_key_to_mirror" | "no_models" | "error";

export interface GatewayLiteLlmStatus {
  mode: InferenceProviderCredentialMode;
  /** member mode: each person pastes their key, or OpenWork creates it. */
  keySource: "personal" | "issued" | null;
  /** issued: one key per LiteLLM team, or a copy of each person's existing key. */
  issueStrategy: "per_team" | "mirror" | null;
  /** issued + mirror: fall back to per-team keys, or report people with no key to copy. */
  mirrorFallback: "per_team" | "error" | null;
  /** issued: people with at least one key OpenWork created. */
  issuedMemberCount: number;
  /** issued: people OpenWork could not create keys for (first 50 in attention). */
  attentionCount: number;
  attention: Array<{ memberId: string; name: string | null; email: string | null; reason: GatewayLiteLlmAttentionReason }>;
  /** LiteLLM proxy root, never a key. */
  baseUrl: string | null;
  spendTracking: boolean;
  /** Organization key (org mode) or admin key (member mode) is stored. */
  hasSyncKey: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  modelCount: number;
  teamCount: number;
  connectedMemberCount: number;
}

export interface GatewayLiteLlmSyncResult {
  modelCount: number;
  groupCount: number;
  teamCount: number;
  members: { matched: number; rejected: number; unavailable: number; removed: number };
  warnings: string[];
  /** issued mode: keys OpenWork created or refreshed in this sync. */
  issued?: { people: number; keys: number; notInLiteLlm: number; noKeyToMirror: number; noModels: number; errors: number; removed: number };
}

export interface GatewayProviderCredentialCounts {
  total: number;
  active: number;
  revoked: number;
  refreshFailed: number;
}

export interface GatewayProviderDetails extends GatewayProviderSummary {
  settings: Record<string, unknown>;
  modelGroups: GatewayModelGroup[];
  credentialSets: GatewayCredentialSet[];
  accessGrants: GatewayAccessGrant[];
  litellm?: GatewayLiteLlmStatus;
}

export interface GatewayProviderListResponse {
  inferenceProviders: GatewayProviderSummary[];
}

export interface GatewayProviderResponse {
  inferenceProvider: GatewayProviderSummary;
}

export interface GatewayProviderDetailsResponse {
  inferenceProvider: GatewayProviderDetails;
}

export interface GatewayProviderConnectSummary extends GatewayProviderSummary {
  apiKey: string;
  apiKeys: Record<string, string>;
}

export interface GatewayProviderConnectResponse {
  inferenceProvider: GatewayProviderConnectSummary;
}

export interface GatewayOauthStartRequest {
  credentialSetId?: string;
}

export interface GatewayDesktopOauthStartRequest extends GatewayOauthStartRequest {
  orgId: string;
}

export interface GatewayOauthStartResponse {
  authUrl: string;
}

export interface GatewayDesktopOauthStartResponse {
  authorizationUrl: string;
}
