"use client";

import { useEffect, useState } from "react";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";

export type DenLlmProviderSource = "models_dev" | "custom";

export type DenLlmProviderModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type DenLlmProviderMemberAccess = {
  id: string;
  orgMembershipId: string;
  role: string;
  createdAt: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
};

export type DenLlmProviderTeamAccess = {
  id: string;
  teamId: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenLlmProvider = {
  id: string;
  organizationId: string;
  createdByOrgMembershipId: string;
  source: DenLlmProviderSource;
  providerId: string;
  name: string;
  providerConfig: Record<string, unknown>;
  hasApiKey: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  canManage: boolean;
  accessibleVia: {
    orgMembershipIds: string[];
    teamIds: string[];
  };
  models: DenLlmProviderModel[];
  access: {
    members: DenLlmProviderMemberAccess[];
    teams: DenLlmProviderTeamAccess[];
  };
};

export type DenModelsDevProviderSummary = {
  id: string;
  name: string;
  npm: string | null;
  env: string[];
  doc: string | null;
  api: string | null;
  modelCount: number;
};

export type DenModelsDevProviderDetail = DenModelsDevProviderSummary & {
  config: Record<string, unknown>;
  models: Array<{
    id: string;
    name: string;
    config: Record<string, unknown>;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIsoString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asLlmProviderModel(value: unknown): DenLlmProviderModel | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const name = asString(value.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    config: asJsonRecord(value.config),
    createdAt: asIsoString(value.createdAt),
  };
}

function asLlmProviderMemberAccess(value: unknown): DenLlmProviderMemberAccess | null {
  if (!isRecord(value) || !isRecord(value.user)) {
    return null;
  }

  const id = asString(value.id);
  const orgMembershipId = asString(value.orgMembershipId);
  const role = asString(value.role);
  const userId = asString(value.user.id);
  const name = asString(value.user.name);
  const email = asString(value.user.email);
  if (!id || !orgMembershipId || !role || !userId || !name || !email) {
    return null;
  }

  return {
    id,
    orgMembershipId,
    role,
    createdAt: asIsoString(value.createdAt),
    user: {
      id: userId,
      name,
      email,
      image: asString(value.user.image),
    },
  };
}

function asLlmProviderTeamAccess(value: unknown): DenLlmProviderTeamAccess | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const teamId = asString(value.teamId);
  const name = asString(value.name);
  if (!id || !teamId || !name) {
    return null;
  }

  return {
    id,
    teamId,
    name,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
  };
}

function asLlmProvider(value: unknown): DenLlmProvider | null {
  if (!isRecord(value) || !isRecord(value.access) || !isRecord(value.accessibleVia)) {
    return null;
  }

  const id = asString(value.id);
  const organizationId = asString(value.organizationId);
  const createdByOrgMembershipId = asString(value.createdByOrgMembershipId);
  const providerId = asString(value.providerId);
  const name = asString(value.name);
  const source = value.source === "models_dev" || value.source === "custom" ? value.source : null;
  if (!id || !organizationId || !createdByOrgMembershipId || !providerId || !name || !source) {
    return null;
  }

  return {
    id,
    organizationId,
    createdByOrgMembershipId,
    source,
    providerId,
    name,
    providerConfig: asJsonRecord(value.providerConfig),
    hasApiKey: value.hasApiKey === true,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
    canManage: value.canManage === true,
    accessibleVia: {
      orgMembershipIds: asStringList(value.accessibleVia.orgMembershipIds),
      teamIds: asStringList(value.accessibleVia.teamIds),
    },
    models: Array.isArray(value.models)
      ? value.models.map(asLlmProviderModel).filter((entry): entry is DenLlmProviderModel => entry !== null)
      : [],
    access: {
      members: Array.isArray(value.access.members)
        ? value.access.members
            .map(asLlmProviderMemberAccess)
            .filter((entry): entry is DenLlmProviderMemberAccess => entry !== null)
        : [],
      teams: Array.isArray(value.access.teams)
        ? value.access.teams
            .map(asLlmProviderTeamAccess)
            .filter((entry): entry is DenLlmProviderTeamAccess => entry !== null)
        : [],
    },
  };
}

function asCatalogProviderSummary(value: unknown): DenModelsDevProviderSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const name = asString(value.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    npm: asString(value.npm),
    env: asStringList(value.env),
    doc: asString(value.doc),
    api: asString(value.api),
    modelCount: typeof value.modelCount === "number" ? value.modelCount : 0,
  };
}

function asCatalogProviderDetail(value: unknown): DenModelsDevProviderDetail | null {
  const summary = asCatalogProviderSummary(value);
  if (!summary || !isRecord(value)) {
    return null;
  }

  const models = Array.isArray(value.models)
    ? value.models
        .map((model) => {
          if (!isRecord(model)) {
            return null;
          }

          const id = asString(model.id);
          const name = asString(model.name);
          if (!id || !name) {
            return null;
          }

          return {
            id,
            name,
            config: asJsonRecord(model.config),
          };
        })
        .filter((entry): entry is DenModelsDevProviderDetail["models"][number] => entry !== null)
    : [];

  return {
    ...summary,
    config: asJsonRecord(value.config),
    models,
  };
}

export function getProviderEnvNames(config: Record<string, unknown>): string[] {
  return asStringList(config.env);
}

export function getProviderDocUrl(config: Record<string, unknown>): string | null {
  return asString(config.doc);
}

export function getProviderNpmPackage(config: Record<string, unknown>): string | null {
  return asString(config.npm);
}

export function getProviderApiBase(config: Record<string, unknown>): string | null {
  return asString(config.api);
}

export function formatProviderTimestamp(value: string | null) {
  if (!value) {
    return "Recently updated";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently updated";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function buildCustomProviderTemplate() {
  return JSON.stringify(
    {
      id: "custom-provider",
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      env: ["CUSTOM_PROVIDER_API_KEY"],
      doc: "https://example.com/docs/models",
      api: "https://api.example.com/v1",
      models: [
        {
          id: "custom-provider/example-model",
          name: "Example Model",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          release_date: "2026-01-01",
          last_updated: "2026-01-01",
          open_weights: false,
          limit: {
            context: 128000,
            input: 128000,
            output: 8192,
          },
          modalities: {
            input: ["text"],
            output: ["text"],
          },
        },
      ],
    },
    null,
    2,
  );
}

export function buildEditableCustomProviderText(provider: DenLlmProvider) {
  return JSON.stringify(
    {
      ...provider.providerConfig,
      models: provider.models.map((model) => model.config),
    },
    null,
    2,
  );
}

export async function requestLlmProviderCatalog(orgId: string) {
  const { response, payload } = await requestJson(`/v1/orgs/${encodeURIComponent(orgId)}/llm-provider-catalog`, { method: "GET" }, 20000);
  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Failed to load the provider catalog (${response.status}).`));
  }

  return isRecord(payload) && Array.isArray(payload.providers)
    ? payload.providers.map(asCatalogProviderSummary).filter((entry): entry is DenModelsDevProviderSummary => entry !== null)
    : [];
}

export async function requestLlmProviderCatalogDetail(orgId: string, providerId: string) {
  const { response, payload } = await requestJson(
    `/v1/orgs/${encodeURIComponent(orgId)}/llm-provider-catalog/${encodeURIComponent(providerId)}`,
    { method: "GET" },
    20000,
  );

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Failed to load provider details (${response.status}).`));
  }

  if (!isRecord(payload) || !payload.provider) {
    throw new Error("Provider details were missing from the response.");
  }

  const detail = asCatalogProviderDetail(payload.provider);
  if (!detail) {
    throw new Error("Provider details could not be parsed.");
  }

  return detail;
}

export function useOrgLlmProviders(orgId: string | null) {
  const [llmProviders, setLlmProviders] = useState<DenLlmProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProviders() {
    if (!orgId) {
      setLlmProviders([]);
      setError("Organization not found.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(`/v1/orgs/${encodeURIComponent(orgId)}/llm-providers`, { method: "GET" }, 15000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load providers (${response.status}).`));
      }

      const nextProviders = isRecord(payload) && Array.isArray(payload.llmProviders)
        ? payload.llmProviders.map(asLlmProvider).filter((entry): entry is DenLlmProvider => entry !== null)
        : [];
      setLlmProviders(nextProviders);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the provider library.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, [orgId]);

  return {
    llmProviders,
    busy,
    error,
    reloadProviders: loadProviders,
  };
}
