/**
 * Pure helpers for the Den "Gateway providers" screens: response parsing,
 * request-body builders and label mapping. Kept free of React and fetch so
 * the request shapes can be unit-tested against den-api's
 * `inference-providers.ts` schemas.
 */

import type {
  InferenceProviderCredentialKind,
  InferenceProviderCredentialMode,
  InferenceProviderStatus,
} from "@openwork/types/den/inference";

export type InferenceCredentialStatus = "ready" | "member_auth_required" | "org_credential_missing";

export type DenInferenceProviderCredential = {
  subject: string;
  kind: InferenceProviderCredentialKind;
  status: string;
  expiresAt: string | null;
};

export type DenInferenceProvider = {
  id: string;
  providerId: string;
  name: string;
  credentialMode: InferenceProviderCredentialMode;
  status: InferenceProviderStatus;
  updatedAt: string | null;
  providerConfig: Record<string, unknown>;
  settings: Record<string, string>;
  models: Array<{ id: string; name: string; config: Record<string, unknown> }>;
  credentialStatus: InferenceCredentialStatus;
  access: { allMembers: boolean; memberIds: string[]; teamIds: string[] } | null;
  credentials: DenInferenceProviderCredential[] | null;
};

/** models.dev `npm` packages the gateway can proxy; mirrors den-api. */
export const SUPPORTED_GATEWAY_NPM_PACKAGES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
] as const;

export function isSupportedGatewayNpm(npm: string | null): boolean {
  return npm !== null && SUPPORTED_GATEWAY_NPM_PACKAGES.some((entry) => entry === npm);
}

export function isGoogleVertexNpm(npm: string | null): boolean {
  return npm === "@ai-sdk/google-vertex" || npm === "@ai-sdk/google-vertex/anthropic";
}

export function isAzureNpm(npm: string | null): boolean {
  return npm === "@ai-sdk/azure";
}

/** Settings den-api requires for a given provider SDK (`invalid_settings` otherwise). */
export function getRequiredSettingKeys(npm: string | null): string[] {
  if (isGoogleVertexNpm(npm)) return ["project", "location"];
  if (isAzureNpm(npm)) return ["resourceName"];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function asCredentialMode(value: unknown): InferenceProviderCredentialMode | null {
  return value === "org" || value === "member" ? value : null;
}

function asStatus(value: unknown): InferenceProviderStatus | null {
  return value === "active" || value === "disabled" ? value : null;
}

function asCredentialStatus(value: unknown): InferenceCredentialStatus {
  return value === "ready" || value === "member_auth_required" ? value : "org_credential_missing";
}

function asCredentialKind(value: unknown): InferenceProviderCredentialKind | null {
  return value === "api_key" || value === "api_key_map" || value === "aws_keys" || value === "gcp_service_account"
    ? value
    : null;
}

function asCredential(value: unknown): DenInferenceProviderCredential | null {
  if (!isRecord(value)) return null;
  const subject = asString(value.subject);
  const kind = asCredentialKind(value.kind);
  const status = asString(value.status);
  if (!subject || !kind || !status) return null;
  return { subject, kind, status, expiresAt: asString(value.expiresAt) };
}

export function asInferenceProvider(value: unknown): DenInferenceProvider | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const providerId = asString(value.providerId);
  const name = asString(value.name);
  const credentialMode = asCredentialMode(value.credentialMode);
  const status = asStatus(value.status);
  if (!id || !providerId || !name || !credentialMode || !status) return null;

  const settings = Object.fromEntries(
    Object.entries(asJsonRecord(value.settings)).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry] as const] : [],
    ),
  );

  return {
    id,
    providerId,
    name,
    credentialMode,
    status,
    updatedAt: asString(value.updatedAt),
    providerConfig: asJsonRecord(value.providerConfig),
    settings,
    models: Array.isArray(value.models)
      ? value.models.flatMap((model) => {
          if (!isRecord(model)) return [];
          const modelId = asString(model.id);
          const modelName = asString(model.name);
          return modelId && modelName ? [{ id: modelId, name: modelName, config: asJsonRecord(model.config) }] : [];
        })
      : [],
    credentialStatus: asCredentialStatus(value.credentialStatus),
    access: isRecord(value.access)
      ? {
          allMembers: value.access.allMembers === true,
          memberIds: asStringList(value.access.memberIds),
          teamIds: asStringList(value.access.teamIds),
        }
      : null,
    credentials: Array.isArray(value.credentials)
      ? value.credentials.map(asCredential).filter((entry): entry is DenInferenceProviderCredential => entry !== null)
      : null,
  };
}

export function readInferenceProviderFromPayload(payload: unknown): DenInferenceProvider | null {
  return isRecord(payload) ? asInferenceProvider(payload.inferenceProvider) : null;
}

export function readInferenceProvidersFromPayload(payload: unknown): DenInferenceProvider[] {
  return isRecord(payload) && Array.isArray(payload.inferenceProviders)
    ? payload.inferenceProviders.map(asInferenceProvider).filter((entry): entry is DenInferenceProvider => entry !== null)
    : [];
}

// --- Labels ---

export function getCredentialModeLabel(mode: InferenceProviderCredentialMode) {
  return mode === "member" ? "Each member signs in" : "Organization key";
}

export function getCredentialStatusLabel(provider: Pick<DenInferenceProvider, "credentialMode" | "credentialStatus">) {
  if (provider.credentialMode === "member") return "Members authorize individually";
  return provider.credentialStatus === "ready" ? "Ready" : "Org credential missing";
}

export function getCredentialStatusTone(
  provider: Pick<DenInferenceProvider, "credentialMode" | "credentialStatus">,
): "success" | "warning" | "info" {
  if (provider.credentialMode === "member") return "info";
  return provider.credentialStatus === "ready" ? "success" : "warning";
}

export function getCredentialKindLabel(kind: InferenceProviderCredentialKind) {
  switch (kind) {
    case "api_key":
      return "API key";
    case "api_key_map":
      return "API keys (per env)";
    case "gcp_service_account":
      return "Google service account";
    case "aws_keys":
      return "AWS keys";
  }
}

export function getProviderStatusLabel(status: InferenceProviderStatus) {
  return status === "active" ? "Active" : "Disabled";
}

// --- Request bodies ---

export type InferenceProviderFormInput = {
  name: string;
  providerId: string;
  modelIds: string[];
  credentialMode: InferenceProviderCredentialMode;
  status: InferenceProviderStatus;
  /** Required-setting values keyed by setting name; blank entries are dropped. */
  settings: Record<string, string>;
  /** Env var names the provider reads (from the catalog config). */
  envNames: string[];
  /** Single API key when the provider reads one env var. */
  apiKey: string;
  /** Per-env values when the provider reads several env vars. */
  apiKeyValues: Record<string, string>;
  /** Pasted Google service-account JSON (Vertex org mode). */
  serviceAccountJson: string;
  access: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
};

export type InferenceProviderRequestBody = {
  name: string;
  providerId: string;
  modelIds: string[];
  credentialMode: InferenceProviderCredentialMode;
  status: InferenceProviderStatus;
  settings: Record<string, string>;
  credential?: { kind: InferenceProviderCredentialKind; secret: string };
  apiKeys?: Record<string, string>;
  allMembers: boolean;
  memberIds: string[];
  teamIds: string[];
};

function trimmedSettings(settings: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(settings).flatMap(([key, value]) => {
      const trimmed = value.trim();
      return trimmed ? [[key, trimmed] as const] : [];
    }),
  );
}

/**
 * Builds the POST/PATCH body for `/v1/inference-providers`. The credential is
 * only included when the admin typed one (blank = keep what is stored), and
 * never in member mode, where each member authorizes their own account.
 * `apiKeys` is used for multi-env providers exactly like the BYOK editor.
 */
export function buildInferenceProviderRequestBody(input: InferenceProviderFormInput): InferenceProviderRequestBody {
  const body: InferenceProviderRequestBody = {
    name: input.name.trim(),
    providerId: input.providerId,
    modelIds: [...new Set(input.modelIds)],
    credentialMode: input.credentialMode,
    status: input.status,
    settings: trimmedSettings(input.settings),
    allMembers: input.access.allMembers,
    memberIds: input.access.allMembers ? [] : [...new Set(input.access.memberIds)],
    teamIds: input.access.allMembers ? [] : [...new Set(input.access.teamIds)],
  };

  if (input.credentialMode === "member") {
    return body;
  }

  const serviceAccountJson = input.serviceAccountJson.trim();
  if (serviceAccountJson) {
    body.credential = { kind: "gcp_service_account", secret: serviceAccountJson };
    return body;
  }

  if (input.envNames.length > 1) {
    const entries = input.envNames
      .map((envName) => [envName, (input.apiKeyValues[envName] ?? "").trim()] as const)
      .filter(([, value]) => value.length > 0);
    if (entries.length > 0) {
      body.apiKeys = Object.fromEntries(entries);
    }
    return body;
  }

  const apiKey = input.apiKey.trim();
  if (apiKey) {
    body.credential = { kind: "api_key", secret: apiKey };
  }
  return body;
}

/** Client-side check mirroring den-api's `invalid_settings` / `unsupported_provider` rules. */
export function validateInferenceProviderForm(input: {
  npm: string | null;
  name: string;
  providerId: string;
  modelIds: string[];
  settings: Record<string, string>;
  serviceAccountJson: string;
}): string | null {
  if (!input.providerId) return "Select a provider.";
  if (!isSupportedGatewayNpm(input.npm)) {
    return "This provider cannot be routed through the OpenWork gateway yet. Pick another provider, or add it under Bring your Own Keys.";
  }
  if (!input.name.trim()) return "Give the provider a name.";
  if (input.modelIds.length === 0) return "Select at least one model.";
  for (const key of getRequiredSettingKeys(input.npm)) {
    if (!(input.settings[key] ?? "").trim()) {
      return `${getSettingLabel(key)} is required for this provider.`;
    }
  }
  const json = input.serviceAccountJson.trim();
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!isRecord(parsed) || parsed.type !== "service_account") {
        return "The service account JSON should be the key file downloaded from Google Cloud (type: service_account).";
      }
    } catch {
      return "The service account JSON could not be parsed.";
    }
  }
  return null;
}

export function getSettingLabel(key: string) {
  switch (key) {
    case "project":
      return "Google Cloud project";
    case "location":
      return "Region";
    case "resourceName":
      return "Azure resource name";
    default:
      return key;
  }
}

export function buildMigrateFromLlmProviderBody(llmProviderId: string): { llmProviderId: string } {
  return { llmProviderId };
}
