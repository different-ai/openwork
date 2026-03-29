import { createSignal, type Accessor } from "solid-js";

import type { ConfigProvidersResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { ProviderAuthMethod, ProviderOAuthStartResult } from "../components/provider-auth-modal";
import { unwrap, waitForHealthy } from "../lib/opencode";
import type { Client, ProviderListItem } from "../types";
import { filterProviderList, mapConfigProvidersToList } from "../utils/providers";

export type PromptFocusReturnTarget = "none" | "composer";

export function createProviderAuthStore(options: {
  client: Accessor<Client | null>;
  providers: Accessor<ProviderListItem[]>;
  providerConnectedIds: Accessor<string[]>;
  selectedWorkspaceType: Accessor<"local" | "remote">;
  getDisabledProviders: Accessor<string[]>;
  setDisabledProviders: (value: string[]) => void;
  setProviderListResponse: (value: ProviderListResponse) => void;
  removeProviderFromState: (providerId: string) => void;
  markOpencodeConfigReloadRequired: () => void;
  describeProviderError: (error: unknown, fallback: string) => string;
  onRestorePromptFocus: () => void;
}) {
  const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
  const [providerAuthBusy, setProviderAuthBusy] = createSignal(false);
  const [providerAuthError, setProviderAuthError] = createSignal<string | null>(null);
  const [providerAuthMethods, setProviderAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});
  const [providerAuthPreferredProviderId, setProviderAuthPreferredProviderId] = createSignal<string | null>(null);
  const [providerAuthReturnFocusTarget, setProviderAuthReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  const providerAuthWorkerType = () => options.selectedWorkspaceType();

  const buildProviderAuthMethods = (
    methods: Record<string, ProviderAuthMethod[]>,
    availableProviders: ProviderListItem[],
    workerType: "local" | "remote",
  ) => {
    const merged = Object.fromEntries(
      Object.entries(methods ?? {}).map(([id, providerMethods]) => [
        id,
        (providerMethods ?? []).map((method, methodIndex) => ({
          ...method,
          methodIndex,
        })),
      ]),
    ) as Record<string, ProviderAuthMethod[]>;

    for (const provider of availableProviders ?? []) {
      const id = provider.id?.trim();
      if (!id || id === "opencode") continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: "API key" }];
    }

    for (const [id, providerMethods] of Object.entries(merged)) {
      const provider = availableProviders.find((item) => item.id === id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        const label = method.label.toLowerCase();
        const isHeadless = label.includes("headless") || label.includes("device");
        return workerType === "remote" ? isHeadless : !isHeadless;
      });
    }

    return merged;
  };

  const loadProviderAuthMethods = async (workerType: "local" | "remote") => {
    const client = options.client();
    if (!client) {
      throw new Error("Not connected to a server");
    }
    const methods = unwrap(await client.provider.auth());
    return buildProviderAuthMethods(
      methods as Record<string, ProviderAuthMethod[]>,
      options.providers(),
      workerType,
    );
  };

  const refreshProviders = async (refreshOptions?: { dispose?: boolean }) => {
    const client = options.client();
    if (!client) return null;

    if (refreshOptions?.dispose) {
      try {
        unwrap(await client.instance.dispose());
      } catch {
        // ignore dispose failures and try reading current state anyway
      }

      try {
        await waitForHealthy(options.client() ?? client, { timeoutMs: 8_000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    const activeClient = options.client() ?? client;
    let disabledProviders = options.getDisabledProviders();
    try {
      const config = unwrap(await activeClient.config.get());
      disabledProviders = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
    } catch {
      // ignore config read failures and continue with current store state
    }

    try {
      const updated = filterProviderList(
        unwrap(await activeClient.provider.list()),
        disabledProviders,
      );
      options.setProviderListResponse(updated);
      return updated;
    } catch {
      try {
        const fallback = unwrap(await activeClient.config.providers()) as ConfigProvidersResponse;
        const mapped = mapConfigProvidersToList(fallback.providers);
        const previousConnected = options.providerConnectedIds();
        const next = filterProviderList(
          {
            all: mapped,
            connected: previousConnected.filter((id) => mapped.some((provider) => provider.id === id)),
            default: fallback.default,
          },
          disabledProviders,
        );
        options.setProviderListResponse(next);
        return next;
      } catch {
        return null;
      }
    }
  };

  const startProviderAuth = async (
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> => {
    setProviderAuthError(null);
    const client = options.client();
    if (!client) {
      throw new Error("Not connected to a server");
    }

    try {
      const cachedMethods = providerAuthMethods();
      const workerType = providerAuthWorkerType();
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods(workerType);
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error("No providers available");
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error("Provider ID is required");
      }

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`Unknown provider: ${resolved}`);
      }

      const oauthIndex =
        methodIndex !== undefined
          ? methodIndex
          : methods.find((method) => method.type === "oauth")?.methodIndex ?? -1;
      if (oauthIndex === -1) {
        throw new Error(`No OAuth flow available for ${resolved}. Use an API key instead.`);
      }

      const selectedMethod = methods.find((method) => method.methodIndex === oauthIndex);
      if (!selectedMethod || selectedMethod.type !== "oauth") {
        throw new Error(`Selected auth method is not an OAuth flow for ${resolved}.`);
      }

      const auth = unwrap(await client.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }));
      return {
        methodIndex: oauthIndex,
        authorization: auth,
      };
    } catch (error) {
      const message = options.describeProviderError(error, "Failed to connect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const completeProviderAuthOAuth = async (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => {
    setProviderAuthError(null);
    const client = options.client();
    if (!client) {
      throw new Error("Not connected to a server");
    }

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error("OAuth method is required");
    }

    const waitForProviderConnection = async (timeoutMs = 15_000, pollMs = 2_000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
            return true;
          }
        } catch {
          // ignore and retry
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return false;
    };

    const isPendingOauthError = (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error ?? "");
      return /request timed out/i.test(text) || /ProviderAuthOauthMissing/i.test(text);
    };

    try {
      const trimmedCode = code?.trim();
      const result = await client.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      const maybeError = result as { error?: unknown } | null | undefined;
      if (maybeError?.error !== undefined) {
        throw new Error(options.describeProviderError(maybeError.error, "Request failed"));
      }
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        return { connected: true, message: `Connected ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        return { connected: true, message: `Connected ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          return { connected: true, message: `Connected ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          return { connected: true, message: `Connected ${resolved}` };
        }
        return { connected: false, pending: true };
      }
      const message = options.describeProviderError(error, "Failed to complete OAuth");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const submitProviderApiKey = async (providerId: string, apiKey: string) => {
    setProviderAuthError(null);
    const client = options.client();
    if (!client) {
      throw new Error("Not connected to a server");
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("API key is required");
    }

    try {
      await client.auth.set({
        providerID: providerId,
        auth: { type: "api", key: trimmed },
      });
      await refreshProviders({ dispose: true });
      return `Connected ${providerId}`;
    } catch (error) {
      const message = options.describeProviderError(error, "Failed to save API key");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const disconnectProvider = async (providerId: string) => {
    setProviderAuthError(null);
    const client = options.client();
    if (!client) {
      throw new Error("Not connected to a server");
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    const provider = options.providers().find((entry) => entry.id === resolved) as
      | (ProviderListItem & { source?: string })
      | undefined;
    const canDisableProvider = provider?.source === "config" || provider?.source === "custom";

    const removeProviderAuth = async () => {
      const authClient = client.auth as unknown as {
        remove?: (request: { providerID: string }) => Promise<unknown>;
        set?: (request: { providerID: string; auth: unknown }) => Promise<unknown>;
      };
      if (typeof authClient.remove === "function") {
        const result = await authClient.remove({ providerID: resolved });
        const maybeError = result as { error?: unknown } | null | undefined;
        if (maybeError?.error !== undefined) {
          throw new Error(options.describeProviderError(maybeError.error, "Request failed"));
        }
        return;
      }

      const rawClient = (client as unknown as {
        client?: { delete?: (request: { url: string }) => Promise<unknown> };
      }).client;
      if (rawClient?.delete) {
        await rawClient.delete({ url: `/auth/${encodeURIComponent(resolved)}` });
        return;
      }

      if (typeof authClient.set === "function") {
        const result = await authClient.set({ providerID: resolved, auth: null });
        const maybeError = result as { error?: unknown } | null | undefined;
        if (maybeError?.error !== undefined) {
          throw new Error(options.describeProviderError(maybeError.error, "Request failed"));
        }
        return;
      }

      throw new Error("Provider auth removal is not supported by this client.");
    };

    const disableProvider = async () => {
      const config = unwrap(await client.config.get());
      const disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      if (disabledProviders.includes(resolved)) {
        return false;
      }

      const next = [...disabledProviders, resolved];
      options.setDisabledProviders(next);
      try {
        const result = await client.config.update({
          config: {
            ...config,
            disabled_providers: next,
          },
        });
        const maybeError = result as { error?: unknown } | null | undefined;
        if (maybeError?.error !== undefined) {
          throw new Error(options.describeProviderError(maybeError.error, "Request failed"));
        }
        options.markOpencodeConfigReloadRequired();
      } catch (error) {
        options.setDisabledProviders(disabledProviders);
        throw error;
      }
      return true;
    };

    try {
      await removeProviderAuth();
      let updated = await refreshProviders({ dispose: true });
      if (
        canDisableProvider &&
        Array.isArray(updated?.connected) &&
        updated.connected.includes(resolved)
      ) {
        const disabled = await disableProvider();
        if (disabled) {
          updated = filterProviderList(updated, options.getDisabledProviders());
          options.setProviderListResponse(updated);
        }
        if (!Array.isArray(updated?.connected) || !updated.connected.includes(resolved)) {
          return disabled
            ? `Disconnected ${resolved} and disabled it in OpenCode config.`
            : `Disconnected ${resolved}.`;
        }
      }

      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        return `Removed stored credentials for ${resolved}, but the worker still reports it as connected. Clear any remaining API key or OAuth credentials and restart the worker to fully disconnect.`;
      }
      options.removeProviderFromState(resolved);
      return `Disconnected ${resolved}`;
    } catch (error) {
      const message = options.describeProviderError(error, "Failed to disconnect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const openProviderAuthModal = async (openOptions?: {
    returnFocusTarget?: PromptFocusReturnTarget;
    preferredProviderId?: string;
  }) => {
    const workerType = providerAuthWorkerType();
    setProviderAuthReturnFocusTarget(openOptions?.returnFocusTarget ?? "none");
    setProviderAuthPreferredProviderId(openOptions?.preferredProviderId?.trim() || null);
    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      const methods = await loadProviderAuthMethods(workerType);
      setProviderAuthMethods(methods);
      setProviderAuthModalOpen(true);
    } catch (error) {
      setProviderAuthPreferredProviderId(null);
      setProviderAuthReturnFocusTarget("none");
      const message = options.describeProviderError(error, "Failed to load providers");
      setProviderAuthError(message);
      throw error;
    } finally {
      setProviderAuthBusy(false);
    }
  };

  const closeProviderAuthModal = (closeOptions?: { restorePromptFocus?: boolean }) => {
    const shouldFocusPrompt =
      closeOptions?.restorePromptFocus ?? providerAuthReturnFocusTarget() === "composer";
    setProviderAuthModalOpen(false);
    setProviderAuthError(null);
    setProviderAuthPreferredProviderId(null);
    setProviderAuthReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      options.onRestorePromptFocus();
    }
  };

  return {
    providerAuthBusy,
    providerAuthModalOpen,
    providerAuthError,
    providerAuthMethods,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    refreshProviders,
    startProviderAuth,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    disconnectProvider,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}
