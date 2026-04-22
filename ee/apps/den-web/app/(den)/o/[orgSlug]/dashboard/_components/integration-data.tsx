"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type IntegrationProvider = "github" | "bitbucket";

export type IntegrationAccount = {
  id: string;
  installationId?: number;
  manageUrl?: string | null;
  name: string;
  kind: "user" | "org";
  avatarInitial: string;
  createdByName?: string | null;
  ownerName?: string;
  repositorySelection?: "all" | "selected";
};

export type IntegrationRepoManifestKind = "marketplace" | "plugin" | null;

export type IntegrationRepo = {
  connectorInstanceId?: string;
  id: string;
  name: string;
  fullName: string;
  description: string;
  hasPluginManifest?: boolean;
  manifestKind?: IntegrationRepoManifestKind;
  marketplacePluginCount?: number | null;
  hasPlugins: boolean;
  defaultBranch?: string | null;
  private?: boolean;
};

export type ConnectedIntegration = {
  id: string;
  provider: IntegrationProvider;
  account: IntegrationAccount;
  repos: IntegrationRepo[];
  connectedAt: string;
};

export type GithubInstallStartResult = {
  redirectUrl: string;
  state: string;
};

export type GithubInstallCompleteResult = {
  connectorAccount: {
    id: string;
    displayName: string;
    metadata?: Record<string, unknown>;
  };
  repositories: IntegrationRepo[];
};

export type GithubConnectorCreationResult = {
  connectorInstanceId: string;
  connectorTargetId: string;
  repositoryFullName: string;
};

export type GithubDiscoveryStep = {
  id: string;
  label: string;
  status: "completed" | "running" | "warning";
};

export type GithubDiscoveredPlugin = {
  componentKinds: string[];
  componentPaths: {
    agents: string[];
    commands: string[];
    hooks: string[];
    lspServers: string[];
    mcpServers: string[];
    monitors: string[];
    settings: string[];
    skills: string[];
  };
  description: string | null;
  displayName: string;
  key: string;
  manifestPath: string | null;
  rootPath: string;
  selectedByDefault: boolean;
  sourceKind: string;
  supported: boolean;
  warnings: string[];
};

export type GithubConnectorDiscoveryResult = {
  autoImportNewPlugins: boolean;
  classification: string;
  connectorInstanceId: string;
  connectorTargetId: string;
  discoveredPlugins: GithubDiscoveredPlugin[];
  repositoryFullName: string;
  sourceRevisionRef: string;
  steps: GithubDiscoveryStep[];
  treeSummary: {
    scannedEntryCount: number;
    strategy: string;
    truncated: boolean;
  };
  warnings: string[];
};

export type GithubDiscoveryApplyResult = {
  autoImportNewPlugins: boolean;
  createdMappingCount: number;
  materializedConfigObjectCount: number;
  createdPluginNames: string[];
};

type IntegrationProviderMeta = {
  provider: IntegrationProvider;
  name: string;
  description: string;
  docsHref: string;
  scopes: string[];
};

export const INTEGRATION_PROVIDERS: Record<IntegrationProvider, IntegrationProviderMeta> = {
  github: {
    provider: "github",
    name: "GitHub",
    description: "Install the OpenWork GitHub App, then pick a repository to turn into a connector instance.",
    docsHref: "https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps",
    scopes: ["metadata:read", "contents:read", "webhooks"],
  },
  bitbucket: {
    provider: "bitbucket",
    name: "Bitbucket",
    description: "Connect Bitbucket workspaces to pull in plugins and skills from your team repos.",
    docsHref: "https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/",
    scopes: ["repository", "account"],
  },
};

let mockConnections: ConnectedIntegration[] = [];

export function getMockAccountsFor(provider: IntegrationProvider): IntegrationAccount[] {
  if (provider === "github") {
    return [
      { id: "acc_gh_user", name: "bshafii", kind: "user", avatarInitial: "B" },
      { id: "acc_gh_different_ai", name: "different-ai", kind: "org", avatarInitial: "D" },
      { id: "acc_gh_openwork", name: "openwork-labs", kind: "org", avatarInitial: "O" },
    ];
  }
  return [
    { id: "acc_bb_user", name: "bshafii", kind: "user", avatarInitial: "B" },
    { id: "acc_bb_openwork", name: "openwork", kind: "org", avatarInitial: "O" },
  ];
}

export function getMockReposFor(provider: IntegrationProvider, accountId: string): IntegrationRepo[] {
  const tag = `${provider}:${accountId}`;
  const base: IntegrationRepo[] = [
    {
      id: `${tag}:openwork`,
      name: "openwork",
      fullName: `${accountToLabel(accountId)}/openwork`,
      description: "Core OpenWork monorepo — desktop, server, and orchestrator.",
      hasPlugins: true,
    },
    {
      id: `${tag}:openwork-plugins`,
      name: "openwork-plugins",
      fullName: `${accountToLabel(accountId)}/openwork-plugins`,
      description: "Internal plugin marketplace: release kit, commit commands, linear groomer.",
      hasPlugins: true,
    },
    {
      id: `${tag}:den-infra`,
      name: "den-infra",
      fullName: `${accountToLabel(accountId)}/den-infra`,
      description: "Infra-as-code for Den Cloud. No plugins yet.",
      hasPlugins: false,
    },
  ];
  return base;
}

function accountToLabel(accountId: string): string {
  if (accountId.includes("openwork-labs")) return "openwork-labs";
  if (accountId.includes("openwork")) return "openwork";
  if (accountId.includes("different-ai")) return "different-ai";
  return "bshafii";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseGithubConnectorAccounts(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }

  return payload.items.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = asString(entry.id);
    const displayName = asString(entry.displayName);
    const createdAt = asString(entry.createdAt);
    const externalAccountRef = asString(entry.externalAccountRef);
    const createdByName = asNullableString(entry.createdByName);
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    if (!id || !displayName || !createdAt) {
      return [];
    }

    const remoteId = asString(entry.remoteId);
    return [{ id, createdAt, createdByName, displayName, externalAccountRef, metadata, remoteId }];
  });
}

function parseGithubConnectorInstances(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }

  return payload.items.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = asString(entry.id);
    const connectorAccountId = asString(entry.connectorAccountId);
    const remoteId = asNullableString(entry.remoteId);
    const name = asString(entry.name);
    if (!id || !connectorAccountId || !name) {
      return [];
    }

    return [{ connectorAccountId, id, name, remoteId }];
  });
}

function toAccountKind(metadata: Record<string, unknown> | undefined): "org" | "user" {
  return metadata?.accountType === "Organization" ? "org" : "user";
}

function toAvatarInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function toRepoName(fullName: string) {
  const parts = fullName.split("/");
  return parts[parts.length - 1] ?? fullName;
}

async function simulateLatency(ms = 450) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchGithubConnections() {
  const [accountsResult, instancesResult] = await Promise.all([
    requestJson("/v1/connector-accounts?connectorType=github&status=active&limit=100", { method: "GET" }, 15000),
    requestJson("/v1/connector-instances?connectorType=github&status=active&limit=100", { method: "GET" }, 15000),
  ]);

  if (!accountsResult.response.ok) {
    throw new Error(getErrorMessage(accountsResult.payload, `Failed to load GitHub integrations (${accountsResult.response.status}).`));
  }
  if (!instancesResult.response.ok) {
    throw new Error(getErrorMessage(instancesResult.payload, `Failed to load GitHub connector instances (${instancesResult.response.status}).`));
  }

  const accounts = parseGithubConnectorAccounts(accountsResult.payload);
  const instances = parseGithubConnectorInstances(instancesResult.payload);

  return accounts.map<ConnectedIntegration>((account) => ({
    id: account.id,
    provider: "github",
    account: {
      avatarInitial: toAvatarInitial(account.displayName),
      createdByName: account.createdByName,
      id: account.id,
      installationId: account.remoteId ? Number(account.remoteId) : undefined,
      kind: toAccountKind(account.metadata),
      manageUrl: typeof account.metadata?.settingsUrl === "string" ? account.metadata.settingsUrl : null,
      name: account.displayName,
      ownerName: account.externalAccountRef ?? (typeof account.metadata?.accountLogin === "string" ? account.metadata.accountLogin : undefined),
      repositorySelection: account.metadata?.repositorySelection === "selected" ? "selected" : "all",
    },
    connectedAt: account.createdAt,
    repos: instances
      .filter((instance) => instance.connectorAccountId === account.id && instance.remoteId)
      .map((instance) => ({
        connectorInstanceId: instance.id,
        defaultBranch: null,
        description: "Repository selected for connector sync.",
        fullName: instance.remoteId ?? instance.name,
        hasPlugins: true,
        id: instance.id,
        name: toRepoName(instance.remoteId ?? instance.name),
      })),
  }));
}

async function fetchConnections(): Promise<ConnectedIntegration[]> {
  const githubConnections = await fetchGithubConnections();
  return [...githubConnections, ...mockConnections];
}

export function formatIntegrationTimestamp(value: string | null): string {
  if (!value) return "Recently connected";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently connected";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function getProviderMeta(provider: IntegrationProvider): IntegrationProviderMeta {
  return INTEGRATION_PROVIDERS[provider];
}

export const integrationQueryKeys = {
  all: ["integrations"] as const,
  list: (orgId?: string | null) => [...integrationQueryKeys.all, "list", orgId ?? "none"] as const,
  accounts: (provider: IntegrationProvider) => [...integrationQueryKeys.all, "accounts", provider] as const,
  repos: (provider: IntegrationProvider, accountId: string | null) =>
    [...integrationQueryKeys.all, "repos", provider, accountId ?? "none"] as const,
  githubInstall: (installationId: number | null) => [...integrationQueryKeys.all, "github-install", installationId ?? 0] as const,
  githubDiscovery: (connectorInstanceId: string | null) => [...integrationQueryKeys.all, "github-discovery", connectorInstanceId ?? "none"] as const,
  connectorInstanceConfiguration: (connectorInstanceId: string | null) => [...integrationQueryKeys.all, "connector-instance-config", connectorInstanceId ?? "none"] as const,
};

export type ConnectorInstanceConfiguredPlugin = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  componentCounts: Record<string, number>;
  rootPath: string | null;
};

export type ConnectorInstanceConfiguration = {
  autoImportNewPlugins: boolean;
  configuredPlugins: ConnectorInstanceConfiguredPlugin[];
  connectorInstanceId: string;
  connectorInstanceName: string;
  importedConfigObjectCount: number;
  mappingCount: number;
  repositoryFullName: string | null;
};

export function useIntegrations() {
  const { orgId } = useOrgDashboard();

  return useQuery({
    enabled: Boolean(orgId),
    queryKey: integrationQueryKeys.list(orgId),
    queryFn: fetchConnections,
  });
}

export function useHasAnyIntegration(): { hasAny: boolean; isLoading: boolean } {
  const { data, isLoading } = useIntegrations();
  return { hasAny: (data?.length ?? 0) > 0, isLoading };
}

export function useIntegrationAccounts(provider: IntegrationProvider, enabled: boolean) {
  return useQuery({
    queryKey: integrationQueryKeys.accounts(provider),
    queryFn: async () => {
      await simulateLatency();
      return getMockAccountsFor(provider);
    },
    enabled,
  });
}

export function useIntegrationRepos(provider: IntegrationProvider, accountId: string | null) {
  return useQuery({
    queryKey: integrationQueryKeys.repos(provider, accountId),
    queryFn: async () => {
      if (!accountId) return [];
      await simulateLatency();
      return getMockReposFor(provider, accountId);
    },
    enabled: Boolean(accountId),
  });
}

export function useStartGithubInstall() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { returnPath: string }): Promise<GithubInstallStartResult> => {
      const { response, payload } = await requestJson(
        "/v1/connectors/github/install/start",
        {
          method: "POST",
          body: JSON.stringify({ returnPath: input.returnPath }),
        },
        15000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to start GitHub install (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const redirectUrl = item ? asString(item.redirectUrl) : null;
      const state = item ? asString(item.state) : null;
      if (!redirectUrl || !state) {
        throw new Error("GitHub install start response was incomplete.");
      }

      return { redirectUrl, state };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
    },
  });
}

export function useGithubInstallCompletion(input: { installationId: number | null; state: string | null }) {
  return useQuery({
    enabled: Number.isFinite(input.installationId ?? NaN) && (input.installationId ?? 0) > 0 && Boolean(input.state?.trim()),
    queryKey: [...integrationQueryKeys.githubInstall(input.installationId), input.state ?? "no-state"] as const,
    queryFn: async (): Promise<GithubInstallCompleteResult> => {
      const { response, payload } = await requestJson(
        "/v1/connectors/github/install/complete",
        {
          method: "POST",
          body: JSON.stringify({ installationId: input.installationId, state: input.state }),
        },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to complete GitHub installation (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const connectorAccount = item && isRecord(item.connectorAccount) ? item.connectorAccount : null;
      const repositories = item && Array.isArray(item.repositories)
        ? item.repositories.flatMap((entry) => {
            if (!isRecord(entry)) {
              return [];
            }

            const id = typeof entry.id === "number" ? String(entry.id) : asString(entry.id);
            const fullName = asString(entry.fullName);
            if (!id || !fullName) {
              return [];
            }

            const manifestKindValue = entry.manifestKind;
            const manifestKind: IntegrationRepoManifestKind = manifestKindValue === "marketplace" || manifestKindValue === "plugin"
              ? manifestKindValue
              : null;
            return [{
              defaultBranch: asNullableString(entry.defaultBranch),
              description: manifestKind === "marketplace"
                ? "Claude marketplace manifest detected."
                : manifestKind === "plugin"
                  ? "Claude plugin manifest detected."
                  : "Repository available to connect.",
              fullName,
              hasPluginManifest: Boolean(entry.hasPluginManifest),
              hasPlugins: Boolean(entry.hasPluginManifest),
              id,
              manifestKind,
              marketplacePluginCount: typeof entry.marketplacePluginCount === "number" ? entry.marketplacePluginCount : null,
              name: toRepoName(fullName),
              private: Boolean(entry.private),
            } satisfies IntegrationRepo];
          })
        : [];

      if (!connectorAccount || !asString(connectorAccount.id) || !asString(connectorAccount.displayName)) {
        throw new Error("GitHub install completion response was incomplete.");
      }

      return {
        connectorAccount: {
          displayName: asString(connectorAccount.displayName) ?? "GitHub",
          id: asString(connectorAccount.id) ?? "",
          metadata: isRecord(connectorAccount.metadata) ? connectorAccount.metadata : undefined,
        },
        repositories,
      };
    },
  });
}

export function useGithubAccountRepositories(connectorAccountId: string | null) {
  return useQuery({
    enabled: Boolean(connectorAccountId),
    queryKey: [...integrationQueryKeys.repos("github", connectorAccountId), "connected-account"] as const,
    queryFn: async (): Promise<IntegrationRepo[]> => {
      const { response, payload } = await requestJson(
        `/v1/connectors/github/accounts/${encodeURIComponent(connectorAccountId ?? "")}/repositories?limit=100`,
        { method: "GET" },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load GitHub repositories (${response.status}).`));
      }

      return isRecord(payload) && Array.isArray(payload.items)
        ? payload.items.flatMap((entry) => {
            if (!isRecord(entry)) {
              return [];
            }

            const id = typeof entry.id === "number" ? String(entry.id) : asString(entry.id);
            const fullName = asString(entry.fullName);
            if (!id || !fullName) {
              return [];
            }

            const manifestKindValue = entry.manifestKind;
            const manifestKind: IntegrationRepoManifestKind = manifestKindValue === "marketplace" || manifestKindValue === "plugin"
              ? manifestKindValue
              : null;
            return [{
              defaultBranch: asNullableString(entry.defaultBranch),
              description: manifestKind === "marketplace"
                ? "Claude marketplace manifest detected."
                : manifestKind === "plugin"
                  ? "Claude plugin manifest detected."
                  : "Repository available to connect.",
              fullName,
              hasPluginManifest: Boolean(entry.hasPluginManifest),
              hasPlugins: Boolean(entry.hasPluginManifest),
              id,
              manifestKind,
              marketplacePluginCount: typeof entry.marketplacePluginCount === "number" ? entry.marketplacePluginCount : null,
              name: toRepoName(fullName),
              private: Boolean(entry.private),
            } satisfies IntegrationRepo];
          })
        : [];
    },
  });
}

export function useCreateGithubConnectorInstance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      branch: string;
      connectorAccountId: string;
      connectorInstanceName: string;
      installationId: number;
      repositoryFullName: string;
      repositoryId: number;
    }): Promise<GithubConnectorCreationResult> => {
      const { response, payload } = await requestJson(
        "/v1/connectors/github/setup",
        {
          method: "POST",
          body: JSON.stringify({
            branch: input.branch,
            connectorAccountId: input.connectorAccountId,
            connectorInstanceName: input.connectorInstanceName,
            installationId: input.installationId,
            mappings: [],
            ref: `refs/heads/${input.branch}`,
            repositoryFullName: input.repositoryFullName,
            repositoryId: input.repositoryId,
          }),
        },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to connect GitHub repository (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const connectorInstance = item && isRecord(item.connectorInstance) ? item.connectorInstance : null;
      const connectorTarget = item && isRecord(item.connectorTarget) ? item.connectorTarget : null;
      const connectorInstanceId = connectorInstance ? asString(connectorInstance.id) : null;
      const connectorTargetId = connectorTarget ? asString(connectorTarget.id) : null;
      const repositoryFullName = connectorTarget && isRecord(connectorTarget.targetConfigJson)
        ? asString(connectorTarget.targetConfigJson.repositoryFullName)
        : null;

      if (!connectorInstanceId || !connectorTargetId || !repositoryFullName) {
        throw new Error("GitHub setup response was incomplete.");
      }

      return {
        connectorInstanceId,
        connectorTargetId,
        repositoryFullName,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useGithubConnectorDiscovery(connectorInstanceId: string | null) {
  return useQuery({
    enabled: Boolean(connectorInstanceId),
    queryKey: integrationQueryKeys.githubDiscovery(connectorInstanceId),
    queryFn: async (): Promise<GithubConnectorDiscoveryResult> => {
      const { response, payload } = await requestJson(
        `/v1/connector-instances/${encodeURIComponent(connectorInstanceId ?? "")}/discovery`,
        { method: "GET" },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to inspect GitHub repository (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const connectorInstance = item && isRecord(item.connectorInstance) ? item.connectorInstance : null;
      const connectorTarget = item && isRecord(item.connectorTarget) ? item.connectorTarget : null;
      const connectorInstanceIdValue = connectorInstance ? asString(connectorInstance.id) : null;
      const connectorTargetId = connectorTarget ? asString(connectorTarget.id) : null;
      const repositoryFullName = item ? asString(item.repositoryFullName) : null;
      const sourceRevisionRef = item ? asString(item.sourceRevisionRef) : null;
      const classification = item ? asString(item.classification) : null;
      const discoveredPlugins = item && Array.isArray(item.discoveredPlugins)
        ? item.discoveredPlugins.flatMap((entry) => {
            if (!isRecord(entry)) {
              return [];
            }

            const key = asString(entry.key);
            const displayName = asString(entry.displayName);
            if (!key || !displayName) {
              return [];
            }

            const componentPaths = isRecord(entry.componentPaths) ? entry.componentPaths : {};
            const asStringArray = (value: unknown) => Array.isArray(value)
              ? value.flatMap((candidate) => {
                  const normalized = asString(candidate);
                  return normalized ? [normalized] : [];
                })
              : [];

            return [{
              componentKinds: Array.isArray(entry.componentKinds)
                ? entry.componentKinds.flatMap((candidate) => {
                    const normalized = asString(candidate);
                    return normalized ? [normalized] : [];
                  })
                : [],
              componentPaths: {
                agents: asStringArray(componentPaths.agents),
                commands: asStringArray(componentPaths.commands),
                hooks: asStringArray(componentPaths.hooks),
                lspServers: asStringArray(componentPaths.lspServers),
                mcpServers: asStringArray(componentPaths.mcpServers),
                monitors: asStringArray(componentPaths.monitors),
                settings: asStringArray(componentPaths.settings),
                skills: asStringArray(componentPaths.skills),
              },
              description: asNullableString(entry.description),
              displayName,
              key,
              manifestPath: asNullableString(entry.manifestPath),
              rootPath: typeof entry.rootPath === "string" ? entry.rootPath : "",
              selectedByDefault: Boolean(entry.selectedByDefault),
              sourceKind: asString(entry.sourceKind) ?? "folder_inference",
              supported: Boolean(entry.supported),
              warnings: Array.isArray(entry.warnings)
                ? entry.warnings.flatMap((candidate) => {
                    const normalized = asString(candidate);
                    return normalized ? [normalized] : [];
                  })
                : [],
            } satisfies GithubDiscoveredPlugin];
          })
        : [];
      const steps = item && Array.isArray(item.steps)
        ? item.steps.flatMap((entry) => {
            if (!isRecord(entry)) {
              return [];
            }

            const id = asString(entry.id);
            const label = asString(entry.label);
            const status = asString(entry.status);
            if (!id || !label || (status !== "completed" && status !== "running" && status !== "warning")) {
              return [];
            }

            return [{ id, label, status } satisfies GithubDiscoveryStep];
          })
        : [];
      const treeSummary = item && isRecord(item.treeSummary)
        ? {
            scannedEntryCount: typeof item.treeSummary.scannedEntryCount === "number" ? item.treeSummary.scannedEntryCount : 0,
            strategy: asString(item.treeSummary.strategy) ?? "git-tree-recursive",
            truncated: Boolean(item.treeSummary.truncated),
          }
        : { scannedEntryCount: 0, strategy: "git-tree-recursive", truncated: false };
      const warnings = item && Array.isArray(item.warnings)
        ? item.warnings.flatMap((entry) => {
            const normalized = asString(entry);
            return normalized ? [normalized] : [];
          })
        : [];

      const autoImportNewPlugins = item ? Boolean(item.autoImportNewPlugins) : false;

      if (!connectorInstanceIdValue || !connectorTargetId || !repositoryFullName || !sourceRevisionRef || !classification) {
        throw new Error("GitHub discovery response was incomplete.");
      }

      return {
        autoImportNewPlugins,
        classification,
        connectorInstanceId: connectorInstanceIdValue,
        connectorTargetId,
        discoveredPlugins,
        repositoryFullName,
        sourceRevisionRef,
        steps,
        treeSummary,
        warnings,
      };
    },
  });
}

export function useApplyGithubDiscovery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { autoImportNewPlugins: boolean; connectorInstanceId: string; selectedKeys: string[] }): Promise<GithubDiscoveryApplyResult> => {
      const { response, payload } = await requestJson(
        `/v1/connector-instances/${encodeURIComponent(input.connectorInstanceId)}/discovery/apply`,
        {
          method: "POST",
          body: JSON.stringify({ autoImportNewPlugins: input.autoImportNewPlugins, selectedKeys: input.selectedKeys }),
        },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to apply GitHub discovery (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const createdPlugins = item && Array.isArray(item.createdPlugins)
        ? item.createdPlugins.flatMap((entry) => {
            if (!isRecord(entry)) return [];
            const name = asString(entry.name);
            return name ? [name] : [];
          })
        : [];
      const createdMappingCount = item && Array.isArray(item.createdMappings) ? item.createdMappings.length : 0;
      const materializedConfigObjectCount = item && Array.isArray(item.materializedConfigObjects) ? item.materializedConfigObjects.length : 0;

      return {
        autoImportNewPlugins: item ? Boolean(item.autoImportNewPlugins) : input.autoImportNewPlugins,
        createdMappingCount,
        materializedConfigObjectCount,
        createdPluginNames: createdPlugins,
      };
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.githubDiscovery(variables.connectorInstanceId) });
    },
  });
}

export type ConnectInput = {
  provider: IntegrationProvider;
  account: IntegrationAccount;
  repos: IntegrationRepo[];
};

export function useConnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ConnectInput): Promise<ConnectedIntegration> => {
      await simulateLatency(900);

      const connection: ConnectedIntegration = {
        id: `conn_${input.provider}_${input.account.id}_${Date.now()}`,
        provider: input.provider,
        account: input.account,
        repos: input.repos,
        connectedAt: new Date().toISOString(),
      };

      mockConnections = [
        ...mockConnections.filter(
          (entry) => !(entry.provider === input.provider && entry.account.id === input.account.id),
        ),
        connection,
      ];

      return connection;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectionId: string) => {
      const isGithubConnection = connectionId.startsWith("cac_");
      if (isGithubConnection) {
        const { response, payload } = await requestJson(
          `/v1/connector-accounts/${encodeURIComponent(connectionId)}/disconnect`,
          {
            method: "POST",
            body: JSON.stringify({ reason: "Disconnected from Den Web integrations." }),
          },
          20000,
        );
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, `Failed to disconnect integration (${response.status}).`));
        }
        return connectionId;
      }

      await simulateLatency(300);
      mockConnections = mockConnections.filter((entry) => entry.id !== connectionId);
      return connectionId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useConnectorInstanceConfiguration(connectorInstanceId: string | null) {
  return useQuery({
    enabled: Boolean(connectorInstanceId),
    queryKey: integrationQueryKeys.connectorInstanceConfiguration(connectorInstanceId),
    queryFn: async (): Promise<ConnectorInstanceConfiguration> => {
      const { response, payload } = await requestJson(
        `/v1/connector-instances/${encodeURIComponent(connectorInstanceId ?? "")}/configuration`,
        { method: "GET" },
        15000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load connector instance (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const connectorInstance = item && isRecord(item.connectorInstance) ? item.connectorInstance : null;
      const connectorInstanceIdValue = connectorInstance ? asString(connectorInstance.id) : null;
      const connectorInstanceName = connectorInstance ? asString(connectorInstance.name) : null;
      const remoteId = connectorInstance ? asString(connectorInstance.remoteId) : null;
      if (!item || !connectorInstanceIdValue || !connectorInstanceName) {
        throw new Error("Connector instance configuration response was incomplete.");
      }

      const configuredPlugins = Array.isArray(item.configuredPlugins)
        ? item.configuredPlugins.flatMap((entry) => {
            if (!isRecord(entry)) return [];
            const id = asString(entry.id);
            const name = asString(entry.name);
            if (!id || !name) return [];
            const componentCounts: Record<string, number> = {};
            if (isRecord(entry.componentCounts)) {
              for (const [key, value] of Object.entries(entry.componentCounts)) {
                if (typeof value === "number" && value > 0) {
                  componentCounts[key] = value;
                }
              }
            }
            const rootPathValue = entry.rootPath;
            const rootPath = typeof rootPathValue === "string" ? rootPathValue : null;
            return [{
              componentCounts,
              description: asNullableString(entry.description),
              id,
              memberCount: typeof entry.memberCount === "number" ? entry.memberCount : 0,
              name,
              rootPath,
            } satisfies ConnectorInstanceConfiguredPlugin];
          })
        : [];

      return {
        autoImportNewPlugins: Boolean(item.autoImportNewPlugins),
        configuredPlugins,
        connectorInstanceId: connectorInstanceIdValue,
        connectorInstanceName,
        importedConfigObjectCount: typeof item.importedConfigObjectCount === "number" ? item.importedConfigObjectCount : 0,
        mappingCount: typeof item.mappingCount === "number" ? item.mappingCount : 0,
        repositoryFullName: remoteId,
      };
    },
  });
}

export function useSetConnectorInstanceAutoImport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { autoImportNewPlugins: boolean; connectorInstanceId: string }) => {
      const { response, payload } = await requestJson(
        `/v1/connector-instances/${encodeURIComponent(input.connectorInstanceId)}/auto-import`,
        {
          method: "POST",
          body: JSON.stringify({ autoImportNewPlugins: input.autoImportNewPlugins }),
        },
        15000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to update auto-import (${response.status}).`));
      }

      return input.autoImportNewPlugins;
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.connectorInstanceConfiguration(variables.connectorInstanceId),
      });
    },
  });
}

export function useRemoveConnectorInstance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectorInstanceId: string) => {
      const { response, payload } = await requestJson(
        `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/remove`,
        { method: "POST" },
        20000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to remove connector instance (${response.status}).`));
      }

      return connectorInstanceId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}
