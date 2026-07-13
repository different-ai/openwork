"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type DenMarketplace = {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  pluginCount: number;
  createdAt: string;
  updatedAt: string;
};

export const marketplaceQueryKeys = {
  all: ["marketplaces"] as const,
  list: () => [...marketplaceQueryKeys.all, "list"] as const,
  detail: (id: string) => [...marketplaceQueryKeys.all, "detail", id] as const,
  resolved: (id: string) => [...marketplaceQueryKeys.all, "resolved", id] as const,
  access: (id: string) => [...marketplaceQueryKeys.all, "access", id] as const,
};

export type MarketplaceAccessRole = "viewer" | "editor" | "manager";

export type MarketplaceAccessGrant = {
  id: string;
  orgMembershipId: string | null;
  teamId: string | null;
  orgWide: boolean;
  role: MarketplaceAccessRole;
  createdAt: string;
  removedAt: string | null;
};

export type MarketplaceResolvedSource = {
  connectorAccountId: string;
  connectorInstanceId: string;
  accountLogin: string | null;
  repositoryFullName: string;
  branch: string | null;
};

export type MarketplacePluginSummary = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  componentCounts: Record<string, number>;
  sourceFormat: string | null;
};

export type MarketplaceResolved = {
  marketplace: DenMarketplace;
  plugins: MarketplacePluginSummary[];
  source: MarketplaceResolvedSource | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseMarketplace(entry: unknown): DenMarketplace | null {
  if (!isRecord(entry)) return null;
  const id = asString(entry.id);
  const name = asString(entry.name);
  const createdAt = asString(entry.createdAt);
  const updatedAt = asString(entry.updatedAt);
  if (!id || !name || !createdAt || !updatedAt) return null;
  return {
    id,
    name,
    description: asString(entry.description),
    logoUrl: asString(entry.logoUrl),
    pluginCount: typeof entry.pluginCount === "number" ? entry.pluginCount : 0,
    createdAt,
    updatedAt,
  };
}

export function useMarketplace(marketplaceId: string | null) {
  return useQuery({
    enabled: Boolean(marketplaceId),
    queryKey: marketplaceQueryKeys.resolved(marketplaceId ?? "none"),
    queryFn: async (): Promise<MarketplaceResolved> => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(marketplaceId ?? "")}/resolved`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplace (${response.status}).`));
      }

      const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
      const marketplace = item && isRecord(item.marketplace) ? parseMarketplace(item.marketplace) : null;
      if (!item || !marketplace) {
        throw new Error("Marketplace resolved response was incomplete.");
      }

      const plugins = Array.isArray(item.plugins)
        ? item.plugins.flatMap((entry) => {
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
            return [{
              id,
              name,
              description: asString(entry.description),
              memberCount: typeof entry.memberCount === "number" ? entry.memberCount : 0,
              componentCounts,
              sourceFormat: isRecord(entry.extension) ? asString(entry.extension.sourceFormat) : null,
            } satisfies MarketplacePluginSummary];
          })
        : [];

      const sourceRecord = isRecord(item.source) ? item.source : null;
      const source: MarketplaceResolvedSource | null = sourceRecord
        ? {
            connectorAccountId: asString(sourceRecord.connectorAccountId) ?? "",
            connectorInstanceId: asString(sourceRecord.connectorInstanceId) ?? "",
            accountLogin: asString(sourceRecord.accountLogin),
            repositoryFullName: asString(sourceRecord.repositoryFullName) ?? "",
            branch: asString(sourceRecord.branch),
          }
        : null;

      return { marketplace, plugins, source };
    },
  });
}

function parseAccessGrant(entry: unknown): MarketplaceAccessGrant | null {
  if (!isRecord(entry)) return null;
  const id = asString(entry.id);
  const role = asString(entry.role);
  if (!id || !role) return null;
  if (role !== "viewer" && role !== "editor" && role !== "manager") return null;
  return {
    id,
    orgMembershipId: asString(entry.orgMembershipId),
    teamId: asString(entry.teamId),
    orgWide: Boolean(entry.orgWide),
    role,
    createdAt: asString(entry.createdAt) ?? new Date().toISOString(),
    removedAt: asString(entry.removedAt),
  };
}

export function useMarketplaceAccess(marketplaceId: string | null) {
  return useQuery({
    enabled: Boolean(marketplaceId),
    queryKey: marketplaceQueryKeys.access(marketplaceId ?? "none"),
    queryFn: async (): Promise<MarketplaceAccessGrant[]> => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(marketplaceId ?? "")}/access`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplace access (${response.status}).`));
      }

      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseAccessGrant)
        .filter((value): value is MarketplaceAccessGrant => Boolean(value) && value?.removedAt === null);
    },
  });
}

export function useGrantMarketplaceAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: {
      marketplaceId: string;
      body:
        | { orgWide: true; role?: MarketplaceAccessRole }
        | { teamId: string; role?: MarketplaceAccessRole }
        | { orgMembershipId: string; role?: MarketplaceAccessRole };
    }) => {
      await runReauthableAction("grant-marketplace-access", async () => {
      const body = {
        role: input.body.role ?? "viewer",
        ...("orgWide" in input.body ? { orgWide: true } : {}),
        ...("teamId" in input.body ? { teamId: input.body.teamId } : {}),
        ...("orgMembershipId" in input.body ? { orgMembershipId: input.body.orgMembershipId } : {}),
      };
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/access`,
        { method: "POST", body: JSON.stringify(body) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to grant access (${response.status}).`);
      }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.access(marketplaceId) });
    },
  });
}

export function useRevokeMarketplaceAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { marketplaceId: string; grantId: string }) => {
      await runReauthableAction("revoke-marketplace-access", async () => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/access/${encodeURIComponent(input.grantId)}`,
        { method: "DELETE" },
        15000,
      );
      if (response.status !== 204 && !response.ok) {
        throw getRequestError(payload, response, `Failed to revoke access (${response.status}).`);
      }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.access(marketplaceId) });
    },
  });
}

export function useMarketplaces() {
  return useQuery({
    queryKey: marketplaceQueryKeys.list(),
    queryFn: async () => {
      const { response, payload } = await requestJson(
        "/v1/marketplaces?status=active&limit=100",
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplaces (${response.status}).`));
      }

      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseMarketplace)
        .filter((value): value is DenMarketplace => Boolean(value));
    },
  });
}

/**
 * Marketplaces seeded by the platform (built-ins, directory, org wrap
 * target). The lazy seeder looks them up by name, so renaming or archiving
 * them from the UI would just respawn a fresh copy — treat them as managed.
 */
const SYSTEM_MARKETPLACE_NAMES = new Set([
  "OpenWork Marketplace",
  "Anthropic-Compatible Plugins",
  "OpenWork Directory",
  "Your organization",
]);

export function isSystemMarketplace(marketplace: Pick<DenMarketplace, "name">): boolean {
  return SYSTEM_MARKETPLACE_NAMES.has(marketplace.name);
}

export function useCreateMarketplace() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { name: string; description?: string }): Promise<DenMarketplace> => {
      let created: DenMarketplace | null = null;
      await runReauthableAction("create-marketplace", async () => {
        const { response, payload } = await requestJson(
          "/v1/marketplaces",
          {
            method: "POST",
            body: JSON.stringify({
              name: input.name,
              ...(input.description ? { description: input.description } : {}),
            }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to create marketplace (${response.status}).`);
        }
        created = isRecord(payload) && isRecord(payload.item) ? parseMarketplace(payload.item) : null;
      });
      if (!created) {
        throw new Error("Marketplace create response was incomplete.");
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}

export function useUpdateMarketplace() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { marketplaceId: string; name?: string; description?: string | null }) => {
      await runReauthableAction("update-marketplace", async () => {
        const { response, payload } = await requestJson(
          `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update marketplace (${response.status}).`);
        }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.list() });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.resolved(marketplaceId) });
    },
  });
}

export function useArchiveMarketplace() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (marketplaceId: string) => {
      await runReauthableAction("archive-marketplace", async () => {
        const { response, payload } = await requestJson(
          `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/archive`,
          { method: "POST" },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to archive marketplace (${response.status}).`);
        }
      });
      return marketplaceId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}

export function useAddPluginToMarketplace() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { marketplaceId: string; pluginId: string }) => {
      await runReauthableAction("add-marketplace-plugin", async () => {
        const { response, payload } = await requestJson(
          `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/plugins`,
          { method: "POST", body: JSON.stringify({ pluginId: input.pluginId }) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to add the plugin (${response.status}).`);
        }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.list() });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.resolved(marketplaceId) });
    },
  });
}

export function useRemovePluginFromMarketplace() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { marketplaceId: string; pluginId: string }) => {
      await runReauthableAction("remove-marketplace-plugin", async () => {
        const { response, payload } = await requestJson(
          `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/plugins/${encodeURIComponent(input.pluginId)}`,
          { method: "DELETE" },
          15000,
        );
        if (response.status !== 204 && !response.ok) {
          throw getRequestError(payload, response, `Failed to remove the plugin (${response.status}).`);
        }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.list() });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.resolved(marketplaceId) });
    },
  });
}

export function useWrapStandaloneConnections() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (marketplaceId?: string): Promise<number> => {
      let wrappedCount = 0;
      await runReauthableAction("wrap-standalone-connections", async () => {
        const { response, payload } = await requestJson(
          "/v1/marketplaces/wrap-standalone-connections",
          { method: "POST", body: JSON.stringify(marketplaceId ? { marketplaceId } : {}) },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to wrap standalone connections (${response.status}).`);
        }
        if (isRecord(payload) && isRecord(payload.item) && typeof payload.item.wrappedCount === "number") {
          wrappedCount = payload.item.wrappedCount;
        }
      });
      return wrappedCount;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
    },
  });
}

export function formatMarketplaceTimestamp(value: string | null): string {
  if (!value) return "Recently added";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently added";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
