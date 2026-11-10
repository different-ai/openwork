"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createdGatewayApiKeySchema,
  memberGatewayApiKeysViewSchema,
  organizationAiGatewaySettingsSchema,
  organizationGatewayApiKeysViewSchema,
  type CreatedGatewayApiKey,
  type OrganizationAiGatewaySettings,
  type OrganizationGatewayApiKeysView,
} from "@openwork/types/den/gateway-api-keys";
import { z } from "zod";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getLibraryRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * AI Gateway API keys for 3rd party tools (feature `gatewayMemberApiKeys`): the organization setting,
 * the viewer's own keys (Library › Models) and every key in the organization (AI Gateway › API Keys).
 */
export const gatewayApiKeyQueryKeys = {
  all: ["gateway-api-keys"] as const,
  mine: (orgId: string | null) => ["gateway-api-keys", "mine", orgId] as const,
  organization: (orgId: string | null) => ["gateway-api-keys", "organization", orgId] as const,
};

const settingsViewSchema = z.object({ settings: organizationAiGatewaySettingsSchema });

async function request<T>(orgId: string, path: string, init: RequestInit, schema: z.ZodType<T>, fallback: string): Promise<T> {
  const { response, payload } = await requestJson(path, { ...init, headers: { ...init.headers, [ORG_SCOPE_HEADER]: orgId } }, 15_000);
  // A reauth error stays one, so runReauthableAction can open the sign-in dialog and retry.
  if (!response.ok) throw getRequestError(payload, response, fallback);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(fallback);
  return parsed.data;
}

async function send(orgId: string, path: string, init: RequestInit, fallback: string): Promise<void> {
  const { response, payload } = await requestJson(path, { ...init, headers: { ...init.headers, [ORG_SCOPE_HEADER]: orgId } }, 15_000);
  if (!response.ok) throw getRequestError(payload, response, fallback);
}

function requireOrg(orgId: string | null): string {
  if (!orgId) throw new Error("Select an organization first.");
  return orgId;
}

export function useSaveAiGatewaySettings() {
  const { orgId } = useOrgDashboard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<OrganizationAiGatewaySettings>) =>
      (await request(requireOrg(orgId), "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify(input) }, settingsViewSchema, "Could not save AI Gateway settings.")).settings,
    onSuccess: (settings) => {
      // The API Keys tab reads the setting from its key list; show the saved value before the refetch lands.
      queryClient.setQueryData<OrganizationGatewayApiKeysView>(gatewayApiKeyQueryKeys.organization(orgId), (current) => current ? { ...current, enabled: settings.memberApiKeys } : current);
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.mine(orgId) });
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.organization(orgId) });
    },
  });
}

/** The viewer's own keys, whether the organization allows them, and the URL tools call. */
export function useMyGatewayApiKeys(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    queryKey: gatewayApiKeyQueryKeys.mine(orgId),
    enabled: enabled && Boolean(orgId),
    queryFn: () => request(requireOrg(orgId), "/v1/org/ai-gateway/api-keys/mine", { method: "GET" }, memberGatewayApiKeysViewSchema, "Your API keys did not load. Try again."),
  });
}

export function useCreateGatewayApiKey() {
  const { orgId } = useOrgDashboard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; expiresAt: string | null }): Promise<CreatedGatewayApiKey> =>
      request(requireOrg(orgId), "/v1/org/ai-gateway/api-keys/mine", { method: "POST", body: JSON.stringify(input) }, createdGatewayApiKeySchema, "Could not create the key. Try again."),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.mine(orgId) });
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.organization(orgId) });
    },
  });
}

/** Revokes a key: the viewer's own, or with `scope: "organization"` any member's (admins). */
export function useRevokeGatewayApiKey(scope: "mine" | "organization") {
  const { orgId } = useOrgDashboard();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKeyId: string) => send(
      requireOrg(orgId),
      scope === "mine" ? `/v1/org/ai-gateway/api-keys/mine/${encodeURIComponent(apiKeyId)}` : `/v1/org/ai-gateway/api-keys/${encodeURIComponent(apiKeyId)}`,
      { method: "DELETE" },
      "Could not revoke the key. Try again.",
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.mine(orgId) });
      void queryClient.invalidateQueries({ queryKey: gatewayApiKeyQueryKeys.organization(orgId) });
    },
  });
}

export function useOrganizationGatewayApiKeys(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    queryKey: gatewayApiKeyQueryKeys.organization(orgId),
    enabled: enabled && Boolean(orgId),
    queryFn: () => request(requireOrg(orgId), "/v1/org/ai-gateway/api-keys", { method: "GET" }, organizationGatewayApiKeysViewSchema, "API keys did not load. Try again."),
  });
}

/** "3 hours ago", "Never" — when a key was last used. */
export function formatLastUsed(value: string | null, now: number = Date.now()): string {
  if (!value) return "Never used";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Never used";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 2) return "Used just now";
  if (minutes < 60) return `Used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Used ${days} ${days === 1 ? "day" : "days"} ago`;
  return `Used ${new Date(value).toLocaleDateString()}`;
}

export function formatCreated(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Created ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Expires Feb 7, 2027", "Expired Nov 2, 2026", "Never expires". */
export function formatExpiry(value: string | null, now: number = Date.now()): string {
  if (!value) return "Never expires";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Never expires";
  return time <= now ? `Expired ${shortDate(value)}` : `Expires ${shortDate(value)}`;
}

/** The expiry for a choice of days from now; null never expires. */
export function expiryFromDays(days: number | null, now: number = Date.now()): string | null {
  return days === null ? null : new Date(now + days * 86_400_000).toISOString();
}

export function expiryChoiceLabel(days: number | null): string {
  if (days === null) return "Never";
  if (days === 365) return "1 year";
  return `${days} days`;
}

/** Query parameter that opens "Create an API key" once on Library › Models. */
export const CREATE_GATEWAY_API_KEY_PARAM = "create-key";

/** Library › Models with the create dialog already open, for "Create your own key now". */
export function createOwnGatewayApiKeyRoute(orgSlug?: string | null): string {
  return `${getLibraryRoute(orgSlug)}?show=models&${CREATE_GATEWAY_API_KEY_PARAM}=1`;
}

/** The public docs page on calling AI Gateway from 3rd party tools. */
export const GATEWAY_API_KEYS_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/third-party-tools";
