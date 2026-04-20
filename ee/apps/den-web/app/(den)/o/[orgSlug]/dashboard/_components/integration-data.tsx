"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Integrations model — the "connectors" layer that sits in front of Plugins.
 *
 * A plugin catalog is only populated once at least one integration is
 * connected. Until then, plugins/skills/hooks/mcps all render empty.
 *
 * In this preview the OAuth flow is fully mocked: the UI walks through the
 * same steps it would for a real integration (authorize → select account
 * → select repositories → connecting → connected) but never leaves the app.
 * State lives in the React Query cache, scoped to the dashboard subtree, so
 * it is intentionally in-memory only.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type IntegrationProvider = "github" | "bitbucket";

export type IntegrationAccount = {
  id: string;
  name: string;
  /** `user` or `org`/`workspace` */
  kind: "user" | "org";
  avatarInitial: string;
};

export type IntegrationRepo = {
  id: string;
  name: string;
  fullName: string;
  description: string;
  /** whether this repo contributes plugins when connected */
  hasPlugins: boolean;
};

export type ConnectedIntegration = {
  id: string;
  provider: IntegrationProvider;
  account: IntegrationAccount;
  repos: IntegrationRepo[];
  connectedAt: string;
};

// ── Provider catalog (static UI metadata) ──────────────────────────────────

export type IntegrationProviderMeta = {
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
    description: "Connect repositories on GitHub to discover plugins, skills, and MCP servers.",
    docsHref: "https://docs.github.com/en/apps/oauth-apps",
    scopes: ["repo", "read:org"],
  },
  bitbucket: {
    provider: "bitbucket",
    name: "Bitbucket",
    description: "Connect Bitbucket workspaces to pull in plugins and skills from your team repos.",
    docsHref: "https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/",
    scopes: ["repository", "account"],
  },
};

// ── Mock backing store (in-memory, keyed on the React Query cache) ────────
//
// The store below models what a real server would return. The React Query
// queryFn reads from this module-level array; mutations push/splice it and
// then invalidate the cache. Swapping for a real API later is a one-line
// change inside each queryFn/mutationFn.

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

export function getMockReposFor(
  provider: IntegrationProvider,
  accountId: string,
): IntegrationRepo[] {
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
    {
      id: `${tag}:llm-ops`,
      name: "llm-ops",
      fullName: `${accountToLabel(accountId)}/llm-ops`,
      description: "Evaluation harnesses, eval data, and dashboard for prompt regressions.",
      hasPlugins: true,
    },
    {
      id: `${tag}:design-system`,
      name: "design-system",
      fullName: `${accountToLabel(accountId)}/design-system`,
      description: "Shared UI primitives used by the web and desktop apps.",
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

// ── Display helpers ────────────────────────────────────────────────────────

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

// ── Query keys ─────────────────────────────────────────────────────────────

export const integrationQueryKeys = {
  all: ["integrations"] as const,
  list: () => [...integrationQueryKeys.all, "list"] as const,
  accounts: (provider: IntegrationProvider) => [...integrationQueryKeys.all, "accounts", provider] as const,
  repos: (provider: IntegrationProvider, accountId: string | null) =>
    [...integrationQueryKeys.all, "repos", provider, accountId ?? "none"] as const,
};

// ── Hooks ──────────────────────────────────────────────────────────────────

async function simulateLatency(ms = 450) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchConnections(): Promise<ConnectedIntegration[]> {
  await simulateLatency(150);
  return [...mockConnections];
}

export function useIntegrations() {
  return useQuery({
    queryKey: integrationQueryKeys.list(),
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

// ── Mutations ──────────────────────────────────────────────────────────────

export type ConnectInput = {
  provider: IntegrationProvider;
  account: IntegrationAccount;
  repos: IntegrationRepo[];
};

export function useConnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ConnectInput): Promise<ConnectedIntegration> => {
      // Simulate the remote OAuth exchange + repo webhook install roundtrip.
      await simulateLatency(900);

      const connection: ConnectedIntegration = {
        id: `conn_${input.provider}_${input.account.id}_${Date.now()}`,
        provider: input.provider,
        account: input.account,
        repos: input.repos,
        connectedAt: new Date().toISOString(),
      };

      // Replace any prior connection on the same account (idempotent).
      mockConnections = [
        ...mockConnections.filter(
          (entry) => !(entry.provider === input.provider && entry.account.id === input.account.id),
        ),
        connection,
      ];

      return connection;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectionId: string) => {
      await simulateLatency(300);
      mockConnections = mockConnections.filter((entry) => entry.id !== connectionId);
      return connectionId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
      queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
}
