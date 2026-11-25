import type {
  GatewayAwsSsoSettings,
  InferenceProviderCredentialKind,
  InferenceProviderCredentialMode,
  InferenceProviderCredentialStatus,
  InferenceProviderStatus,
} from "./inference.js";
import type { GatewayCustomProviderStatus } from "./gateway-custom-providers.js";

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

/**
 * Result of sending one test prompt to a provider configuration before it is
 * saved. `message` is written for the admin and never contains the key.
 */
export type GatewayProviderTestResult =
  | { ok: true; model: string; status: number; code: null; message: null }
  | { ok: false; model: string; status: number | null; code: string; message: string };

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

export type GatewayModelGroupWrite =
  | {
      name: string;
      description?: string | null;
      modelIds: string[];
      allModels?: never;
      status?: GatewayResourceStatus;
    }
  | {
      name: string;
      description?: string | null;
      allModels: true;
      modelIds?: never;
      status?: GatewayResourceStatus;
    };

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
  credential?: { kind: InferenceProviderCredentialKind; secret: string };
  apiKeys?: Record<string, string>;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTenantId?: string;
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
  configured: boolean;
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

export type GatewayModelGroupPatch = {
  name?: string;
  description?: string | null;
  modelIds?: string[];
  allModels?: true;
  status?: GatewayResourceStatus;
};
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
  id: string;
  name: string;
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
  id: string;
  providerId: string;
  name: string;
  source: "openwork_gateway";
  credentialMode: InferenceProviderCredentialMode;
  credentialStatus: GatewayCredentialStatus;
  authUrl: string | null;
  status: GatewayResourceStatus;
  createdAt?: string;
  updatedAt: string;
  providerConfig: Record<string, unknown>;
  modelIds: string[];
  catalogWarning?: string;
  models: GatewayUsableModel[];
  modelAssignmentsComplete: boolean;
  pinnedModelIds: string[];
  authorizationRequests: GatewayAuthorizationRequest[];
  migration?: GatewayProviderMigration;
  access?: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
  settings?: Record<string, unknown>;
  oauthClientId?: string | null;
  oauthCallbackUrl?: string;
  hasOauthClientSecret?: boolean;
  credentials?: GatewayProviderCredentialSummary[];
  credentialCounts?: GatewayProviderCredentialCounts;
  apiKey?: string;
  apiKeys?: Record<string, string>;
}

/**
 * LiteLLM provider state for management views. `org` uses one organization
 * key and OpenWork spend tracking; `member` uses each person's own LiteLLM
 * key (or, with keySource `entra`, their own Microsoft Entra sign-in), so
 * LiteLLM owns budgets and OpenWork does not price or limit usage.
 */
export type GatewayLiteLlmAttentionReason = "not_in_litellm" | "no_key_to_mirror" | "no_models" | "error";

export interface GatewayLiteLlmStatus {
  mode: InferenceProviderCredentialMode;
  keySource: "personal" | "issued" | "entra" | null;
  issueStrategy: "per_team" | "mirror" | null;
  mirrorFallback: "per_team" | "error" | null;
  issuedMemberCount: number;
  attentionCount: number;
  attention: Array<{ memberId: string; name: string | null; email: string | null; reason: GatewayLiteLlmAttentionReason }>;
  baseUrl: string | null;
  spendTracking: boolean;
  hasSyncKey: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  modelCount: number;
  teamCount: number;
  connectedMemberCount: number;
  entraScope?: string;
}

export interface GatewayLiteLlmSyncResult {
  modelCount: number;
  groupCount: number;
  teamCount: number;
  members: { matched: number; rejected: number; unavailable: number; removed: number };
  warnings: string[];
  issued?: { people: number; keys: number; notInLiteLlm: number; noKeyToMirror: number; noModels: number; errors: number; removed: number };
}

/** Why OpenWork has no working TrueFoundry token for an allowed person yet. */
export type GatewayTrueFoundryAttentionReason = "not_in_truefoundry" | "user_inactive" | "token_limit" | "no_models" | "error";

/**
 * TrueFoundry provider state for management views. Every person uses a
 * personal access token OpenWork created for their TrueFoundry user, so
 * TrueFoundry owns budgets. OpenWork prices and limits usage only when
 * trackUsageCosts is on, for models with public pricing.
 */
export interface GatewayTrueFoundryStatus {
  controlPlaneUrl: string | null;
  gatewayBaseUrl: string | null;
  createMissingUsers: boolean;
  trackUsageCosts: boolean;
  hasAdminKey: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  modelCount: number;
  availableModels: Array<{ id: string; name: string }>;
  selectedModelIds: string[] | null;
  activeMemberCount: number;
  createdUserCount: number;
  attentionCount: number;
  attention: Array<{ memberId: string; name: string | null; email: string | null; reason: GatewayTrueFoundryAttentionReason; message: string | null }>;
}

export interface GatewayTrueFoundrySyncResult {
  modelCount: number;
  people: number;
  tokensCreated: number;
  usersCreated: number;
  notInTrueFoundry: number;
  noModels: number;
  tokenLimit: number;
  errors: number;
  removed: number;
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
  truefoundry?: GatewayTrueFoundryStatus;
  custom?: GatewayCustomProviderStatus;
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
