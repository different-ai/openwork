import { applyEdits, modify } from "jsonc-parser";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderConnection,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";

/**
 * Pure helpers that build and reconcile the cloud-managed ("lpr_*") provider
 * block inside a workspace `opencode.jsonc`. Extracted from the provider-auth
 * store so the diff/update behaviour can be unit tested directly (#2346).
 */

const getStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const credentialEnvRank = (name: string) => {
  const normalized = name.trim().toUpperCase();
  if (/(^|_)API_KEY$/.test(normalized)) return 0;
  if (/(^|_)ACCESS_KEY_ID$/.test(normalized)) return 1;
  if (/(^|_)BEARER_TOKEN(_|$)/.test(normalized) || /(^|_)TOKEN$/.test(normalized)) return 2;
  if (/(^|_)KEY$/.test(normalized)) return 3;
  return null;
};

const selectPrimaryCredentialEnvName = (
  envNames: string[],
  availableNames: string[],
) => {
  const available = new Set(availableNames.filter((name) => name.trim().length > 0));
  const orderedNames = envNames.filter((name) => available.has(name));
  const ranked = orderedNames
    .map((name, index) => ({ name, index, rank: credentialEnvRank(name) }))
    .filter((entry): entry is { name: string; index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  if (ranked[0]) return ranked[0].name;
  if (envNames.length > 1 && envNames.some((name) => credentialEnvRank(name) !== null)) return null;
  return orderedNames[0] ?? null;
};

const removeCloudProviderComment = (raw: string, providerId: string) =>
  raw.replace(
    new RegExp(
      `(^[ \t]*)// OpenWork Cloud import:.*\\n\\1(?="${escapeRegExp(providerId)}":)`,
      "m",
    ),
    "$1",
  );

export const getCloudProviderEnv = (config: Record<string, unknown>) =>
  getStringList(config.env);

/**
 * Split a connect payload's credential into the opencode auth.json entry and
 * the env vars to upsert. Multi-env providers (`apiKeys`) set every value as
 * an env var, then choose the auth entry by credential-shaped env name rather
 * than by position: Azure declares its resource name before its API key.
 * Legacy single-credential payloads (`apiKey`) keep today's auth-only behaviour.
 */
export const resolveCloudProviderCredentials = (
  provider: Pick<
    DenOrgLlmProviderConnection,
    "apiKey" | "apiKeys" | "providerConfig"
  >,
) => {
  const apiKeys = provider.apiKeys ?? {};
  const envNames = getCloudProviderEnv(provider.providerConfig);
  const orderedNames = [
    ...envNames.filter((name) => name in apiKeys),
    ...Object.keys(apiKeys).filter((name) => !envNames.includes(name)),
  ];
  const envEntries = orderedNames.flatMap((name) => {
    const value = apiKeys[name]?.trim();
    return value ? [{ key: name, value }] : [];
  });
  const primaryCredentialEnvName = selectPrimaryCredentialEnvName(
    envNames,
    envEntries.map((entry) => entry.key),
  );
  const primaryApiKey =
    provider.apiKey?.trim() ||
    envEntries.find((entry) => entry.key === primaryCredentialEnvName)?.value ||
    "";
  return { envEntries, primaryApiKey };
};

export const getCloudManagedProviderId = (
  provider: Pick<DenOrgLlmProvider, "id" | "providerId" | "source">,
) => (provider.source === "openwork" ? "openwork" : provider.id.trim());

/**
 * A provider key in `opencode.jsonc` that is owned by the cloud-import system:
 * `lpr_*` keys (org-managed providers), `ipr_*` keys (providers routed through
 * the OpenWork inference gateway) and the `openwork` hosted provider.
 * These keys are never hand-authored, so re-importing over an existing block
 * with one of these ids is a safe reconcile (recovers a lost import baseline)
 * rather than a clobber of a user's manual provider (#2346).
 */
export const isCloudManagedProviderKey = (providerId: string) =>
  /^(lpr|ipr)_/i.test(providerId) || providerId.trim() === "openwork";

export const OPENWORK_GATEWAY_PROVIDER_SOURCE = "openwork_gateway";
/** Badge copy for providers routed through the OpenWork inference gateway. */
export const OPENWORK_GATEWAY_BADGE_LABEL = "via OpenWork Gateway";

/**
 * Runtime provider ids whose sync status reports the OpenWork inference
 * gateway as source — the UI badges these "via OpenWork Gateway".
 */
/**
 * A gateway provider the server sync skipped because this member has not yet
 * authorized their own account (`member_auth_required`). Rendered as a
 * "Connect" row in Settings > AI providers and the model picker.
 */
export type GatewayConnectProvider = {
  cloudProviderId: string;
  providerId: string;
  name: string;
  /** Den's OAuth start URL; null on older Den servers that do not return one. */
  authUrl: string | null;
};

export const GATEWAY_MEMBER_AUTH_REQUIRED_REASON = "member_auth_required";

/** Copy shown under a gateway provider that still needs the member's sign-in. */
export const gatewayConnectCopy = (name: string) => `Sign in to ${name} to use it`;

/** Skipped sync entries that need the member's own sign-in, in server order. */
export const resolveGatewayConnectProviders = (
  skippedProviders:
    | Record<string, { cloudProviderId: string; providerId: string; name: string; reason: string; authUrl?: string | null }>
    | undefined
    | null,
): GatewayConnectProvider[] =>
  Object.values(skippedProviders ?? {})
    .filter((provider) => provider.reason === GATEWAY_MEMBER_AUTH_REQUIRED_REASON)
    .map((provider) => ({
      cloudProviderId: provider.cloudProviderId,
      providerId: provider.providerId,
      name: provider.name,
      authUrl: provider.authUrl ?? null,
    }));

export const GATEWAY_CONNECT_POLL_INTERVAL_MS = 10_000;
export const GATEWAY_CONNECT_POLL_ATTEMPTS = 6;

/**
 * Opens the member's OAuth start URL in the system browser, then re-syncs cloud
 * providers a few times (~60s by default) so the provider appears once the
 * member finishes the grant in the browser. Stops early when `isConnected`
 * reports the provider is no longer waiting on sign-in.
 */
export async function connectGatewayProvider(input: {
  provider: GatewayConnectProvider;
  openUrl: (url: string) => void | Promise<void>;
  resync: () => Promise<unknown>;
  /** Whether the provider is now materialized (sync no longer skips it). */
  isConnected: () => boolean;
  wait?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  attempts?: number;
}): Promise<boolean> {
  if (!input.provider.authUrl) return false;
  await input.openUrl(input.provider.authUrl);
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = input.attempts ?? GATEWAY_CONNECT_POLL_ATTEMPTS;
  const interval = input.pollIntervalMs ?? GATEWAY_CONNECT_POLL_INTERVAL_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(interval);
    try {
      await input.resync();
    } catch {
      // A failed poll is not fatal: the next scheduled sync will pick it up.
    }
    if (input.isConnected()) return true;
  }
  return input.isConnected();
}

export const resolveGatewayProviderIds = (
  importedCloudProviders: Record<string, Pick<CloudImportedProvider, "providerId" | "source">> | undefined,
): Set<string> =>
  new Set(
    Object.values(importedCloudProviders ?? {})
      .filter((provider) => provider.source === OPENWORK_GATEWAY_PROVIDER_SOURCE)
      .map((provider) => provider.providerId),
  );


export const getProviderModelIds = (
  provider: Pick<DenOrgLlmProvider, "models">,
) =>
  provider.models
    .flatMap((model) => {
      const id = model.id.trim();
      return id ? [id] : [];
    })
    .sort();

export const isCloudProviderOutOfSync = (
  provider: DenOrgLlmProvider,
  importedProvider: CloudImportedProvider,
) =>
  importedProvider.providerId !== getCloudManagedProviderId(provider) ||
  importedProvider.sourceProviderId !== provider.providerId ||
  (importedProvider.source ?? null) !== provider.source ||
  (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
  !sameStringList(
    importedProvider.modelIds,
    // Normalize both sides: raw Den ids can include whitespace/empty values,
    // which otherwise made providers permanently out-of-sync.
    getProviderModelIds(provider),
  );

export const buildCloudProviderConfig = (
  provider: DenOrgLlmProviderConnection,
): ProviderConfig => {
  const models = Object.fromEntries(
    provider.models.map((model) => {
      const next: NonNullable<ProviderConfig["models"]>[string] = {
        id: model.id,
        name: model.name,
      };
      const raw = model.config;
      for (const key of [
        "family",
        "release_date",
        "attachment",
        "reasoning",
        "temperature",
        "tool_call",
        "interleaved",
        "cost",
        "limit",
        "modalities",
        "status",
        "options",
        "headers",
        "provider",
        "variants",
      ] as const) {
        const value = raw[key];
        if (value !== undefined) {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      return [model.id, next];
    }),
  );

  const next: ProviderConfig = {
    id: provider.providerId,
    name: provider.name,
    env: getCloudProviderEnv(provider.providerConfig),
  };

  // OpenWork Models are catalog-backed via OPENCODE_MODELS_URL. Den provisions
  // the provider + key with zero model rows — writing `models: {}` can prevent
  // the engine from keeping catalog models, so omit an empty map for openwork.
  if (Object.keys(models).length > 0 || provider.source !== "openwork") {
    next.models = models;
  }

  if (
    typeof provider.providerConfig.npm === "string" &&
    provider.providerConfig.npm.trim()
  ) {
    next.npm = provider.providerConfig.npm;
  }
  if (
    typeof provider.providerConfig.api === "string" &&
    provider.providerConfig.api.trim()
  ) {
    next.api = provider.providerConfig.api;
  }
  if (
    provider.providerConfig.options &&
    typeof provider.providerConfig.options === "object"
  ) {
    next.options = provider.providerConfig.options as Record<string, unknown>;
  }
  if (Array.isArray(provider.providerConfig.whitelist)) {
    next.whitelist = getStringList(provider.providerConfig.whitelist);
  }
  if (Array.isArray(provider.providerConfig.blacklist)) {
    next.blacklist = getStringList(provider.providerConfig.blacklist);
  }

  return next;
};

/**
 * Build the per-key runtime provider patch for a cloud import/reconcile.
 * Sent to `PATCH /workspace/:id/config` where record values upsert and
 * explicit `null` deletes (`mergeRuntimeProviderUpdate`) — no client-side
 * read-modify-write of the user's `opencode.jsonc` at all.
 */
export const buildRuntimeProviderPatch = (
  provider: DenOrgLlmProviderConnection,
  localProviderId: string,
  previousProviderId?: string | null,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (previousProviderId && previousProviderId !== localProviderId) {
    patch[previousProviderId] = null;
  }
  patch[localProviderId] = buildCloudProviderConfig(provider) as unknown as Record<string, unknown>;
  return patch;
};

export const formatConfigWithoutCloudProvider = (
  raw: string,
  providerId: string,
  disabledProviders: string[],
) => {
  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  updated = removeCloudProviderComment(updated, providerId);
  const providerEdits = modify(updated, ["provider", providerId], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, providerEdits);

  const nextDisabled = disabledProviders.filter((id) => id !== providerId);
  const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, disabledEdits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
