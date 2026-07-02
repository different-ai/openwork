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

const sortStrings = (values: string[]) => values.toSorted();

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * an env var and use the first env-ordered value as the auth entry, following
 * the models.dev convention that `env[0]` is the primary credential. Legacy
 * single-credential payloads (`apiKey`) keep today's auth-only behaviour.
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
  const primaryApiKey = provider.apiKey?.trim() || envEntries[0]?.value || "";
  return { envEntries, primaryApiKey };
};

export const getCloudManagedProviderId = (
  provider: Pick<DenOrgLlmProvider, "id" | "providerId" | "source">,
) => (provider.source === "openwork" ? "openwork" : provider.id.trim());

/**
 * A provider key in `opencode.jsonc` that is owned by the cloud-import system:
 * `lpr_*` keys (org-managed providers) and the `openwork` hosted provider.
 * These keys are never hand-authored, so re-importing over an existing block
 * with one of these ids is a safe reconcile (recovers a lost import baseline)
 * rather than a clobber of a user's manual provider (#2346).
 */
export const isCloudManagedProviderKey = (providerId: string) =>
  /^lpr_/i.test(providerId) || providerId.trim() === "openwork";


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
    sortStrings(provider.models.map((model) => model.id)),
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
    models,
  };

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
