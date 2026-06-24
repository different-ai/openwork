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

const cloudProviderComment = (provider: Pick<DenOrgLlmProvider, "id" | "name">) =>
  `// OpenWork Cloud import: ${provider.name
    .replace(/\s+/g, " ")
    .trim()} (${provider.id}). Manage this entry from Cloud settings.`;

const removeCloudProviderComment = (raw: string, providerId: string) =>
  raw.replace(
    new RegExp(
      `(^[ \t]*)// OpenWork Cloud import:.*\\n\\1(?="${escapeRegExp(providerId)}":)`,
      "m",
    ),
    "$1",
  );

const addCloudProviderComment = (
  raw: string,
  provider: Pick<DenOrgLlmProvider, "id" | "name">,
  localProviderId: string,
) => {
  const withoutExisting = removeCloudProviderComment(raw, localProviderId);
  const propertyPattern = new RegExp(
    `^([ \t]*)"${escapeRegExp(localProviderId)}":`,
    "m",
  );
  return withoutExisting.replace(
    propertyPattern,
    `$1${cloudProviderComment(provider)}\n$1"${localProviderId}":`,
  );
};

export const getCloudProviderEnv = (config: Record<string, unknown>) =>
  getStringList(config.env);

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
 * Rewrite the cloud-managed provider block in `opencode.jsonc`. This fully
 * replaces the block via jsonc `modify()`, so an updated Den model list (added,
 * changed, or removed models) is reconciled into the file rather than keeping
 * the first-import snapshot.
 */
export const formatConfigWithCloudProvider = (
  raw: string,
  provider: DenOrgLlmProviderConnection,
  localProviderId: string,
  options: { previousProviderId?: string | null; disabledProviders: string[] },
) => {
  const previousProviderId = options.previousProviderId ?? null;
  const nextProviderConfig = buildCloudProviderConfig(
    provider,
  ) as unknown as Record<string, unknown>;
  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

  if (previousProviderId && previousProviderId !== localProviderId) {
    updated = removeCloudProviderComment(updated, previousProviderId);
    const previousEdits = modify(updated, ["provider", previousProviderId], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, previousEdits);
  }

  const providerEdits = modify(updated, ["provider", localProviderId], nextProviderConfig, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, providerEdits);
  updated = addCloudProviderComment(updated, provider, localProviderId);

  const disabledToRemove = new Set([localProviderId, previousProviderId ?? ""]);
  const currentDisabled = options.disabledProviders;
  if (currentDisabled.some((id) => disabledToRemove.has(id))) {
    const nextDisabled = currentDisabled.filter((id) => !disabledToRemove.has(id));
    const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, disabledEdits);
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`;
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
