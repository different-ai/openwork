import { createMemo, createSignal, type Accessor } from "solid-js";

import type { ProviderAuthAuthorization, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import { t, currentLocale } from "../../../i18n";
import { unwrap, waitForHealthy } from "../../lib/opencode";
import type { Client, ProviderListItem, WorkspaceDisplay } from "../../types";
import { safeStringify } from "../../utils";
import { filterProviderList, mapConfigProvidersToList } from "../../utils/providers";

type ProviderReturnFocusTarget = "none" | "composer";

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  methodIndex?: number;
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

type CreateProvidersStoreOptions = {
  client: Accessor<Client | null>;
  providers: Accessor<ProviderListItem[]>;
  providerDefaults: Accessor<Record<string, string>>;
  providerConnectedIds: Accessor<string[]>;
  disabledProviders: Accessor<string[]>;
  selectedWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviders: (value: string[]) => void;
  markOpencodeConfigReloadRequired: () => void;
  focusPromptSoon?: () => void;
};

export function createProvidersStore(options: CreateProvidersStoreOptions) {
  const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
  const [providerAuthBusy, setProviderAuthBusy] = createSignal(false);
  const [providerAuthError, setProviderAuthError] = createSignal<string | null>(null);
  const [providerAuthMethods, setProviderAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});
  const [providerAuthPreferredProviderId, setProviderAuthPreferredProviderId] = createSignal<string | null>(null);
  const [providerAuthReturnFocusTarget, setProviderAuthReturnFocusTarget] =
    createSignal<ProviderReturnFocusTarget>("none");

  const providerAuthWorkerType = createMemo<"local" | "remote">(() =>
    options.selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local",
  );

  const applyProviderListState = (value: ProviderListResponse) => {
    options.setProviders(value.all ?? []);
    options.setProviderDefaults(value.default ?? {});
    options.setProviderConnectedIds(value.connected ?? []);
  };

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    options.setProviders(options.providers().filter((provider) => provider.id !== resolved));
    options.setProviderConnectedIds(options.providerConnectedIds().filter((id) => id !== resolved));
    options.setProviderDefaults(
      Object.fromEntries(
        Object.entries(options.providerDefaults()).filter(([id]) => id !== resolved),
      ),
    );
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, t("app.error_request_failed", currentLocale())));
  };

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return t("app.error_auth_failed", currentLocale());
      if (status === 429) return t("app.error_rate_limit", currentLocale());
      if (provider) return `Provider error (${provider})`;
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

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
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
    }
    const methods = unwrap(await c.provider.auth());
    return buildProviderAuthMethods(
      methods as Record<string, ProviderAuthMethod[]>,
      options.providers(),
      workerType,
    );
  };

  async function startProviderAuth(
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> {
    setProviderAuthError(null);
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
    }
    try {
      const cachedMethods = providerAuthMethods();
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods(providerAuthWorkerType());
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

      const auth = unwrap(await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }));
      return {
        methodIndex: oauthIndex,
        authorization: auth,
      };
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function refreshProviders(optionsArg?: { dispose?: boolean }) {
    const c = options.client();
    if (!c) return null;

    if (optionsArg?.dispose) {
      try {
        unwrap(await c.instance.dispose());
      } catch {
        // ignore dispose failures and try reading current state anyway
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 8_000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    const activeClient = options.client() ?? c;
    let disabledProviders = options.disabledProviders() ?? [];
    try {
      const config = unwrap(await activeClient.config.get());
      disabledProviders = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
      options.setDisabledProviders(disabledProviders);
    } catch {
      // ignore config read failures and continue with current store state
    }
    try {
      const updated = filterProviderList(
        unwrap(await activeClient.provider.list()),
        disabledProviders,
      );
      applyProviderListState(updated);
      return updated;
    } catch {
      try {
        const fallback = unwrap(await activeClient.config.providers());
        const mapped = mapConfigProvidersToList(fallback.providers);
        const next = filterProviderList(
          {
            all: mapped,
            connected: options.providerConnectedIds().filter((id) => mapped.some((provider) => provider.id === id)),
            default: fallback.default,
          },
          disabledProviders,
        );
        applyProviderListState(next);
        return next;
      } catch {
        return null;
      }
    }
  }

  async function completeProviderAuthOAuth(providerId: string, methodIndex: number, code?: string) {
    setProviderAuthError(null);
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
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
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
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
      const message = describeProviderError(error, "Failed to complete OAuth");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    setProviderAuthError(null);
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("API key is required");
    }

    try {
      await c.auth.set({
        providerID: providerId,
        auth: { type: "api", key: trimmed },
      });
      await refreshProviders({ dispose: true });
      return `Connected ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to save API key");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function disconnectProvider(providerId: string) {
    setProviderAuthError(null);
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    const provider = options.providers().find((entry) => entry.id === resolved) as
      | (ProviderListItem & { source?: string })
      | undefined;
    const canDisableProvider =
      provider?.source === "config" || provider?.source === "custom";

    const removeProviderAuth = async () => {
      const authClient = c.auth as unknown as {
        remove?: (options: { providerID: string }) => Promise<unknown>;
        set?: (options: { providerID: string; auth: unknown }) => Promise<unknown>;
      };
      if (typeof authClient.remove === "function") {
        const result = await authClient.remove({ providerID: resolved });
        assertNoClientError(result);
        return;
      }

      const rawClient = (c as unknown as { client?: { delete?: (options: { url: string }) => Promise<unknown> } })
        .client;
      if (rawClient?.delete) {
        await rawClient.delete({ url: `/auth/${encodeURIComponent(resolved)}` });
        return;
      }

      if (typeof authClient.set === "function") {
        const result = await authClient.set({ providerID: resolved, auth: null });
        assertNoClientError(result);
        return;
      }

      throw new Error("Provider auth removal is not supported by this client.");
    };

    const disableProvider = async () => {
      const config = unwrap(await c.config.get());
      const disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      if (disabledProviders.includes(resolved)) {
        return false;
      }

      const next = [...disabledProviders, resolved];
      options.setDisabledProviders(next);
      try {
        const result = await c.config.update({
          config: {
            ...config,
            disabled_providers: next,
          },
        });
        assertNoClientError(result);
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
        if (disabled && updated) {
          updated = filterProviderList(updated, options.disabledProviders() ?? []);
          applyProviderListState(updated);
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
      removeProviderFromState(resolved);
      return `Disconnected ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to disconnect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
  }) {
    setProviderAuthReturnFocusTarget(optionsArg?.returnFocusTarget ?? "none");
    setProviderAuthPreferredProviderId(optionsArg?.preferredProviderId?.trim() || null);
    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      const methods = await loadProviderAuthMethods(providerAuthWorkerType());
      setProviderAuthMethods(methods);
      setProviderAuthModalOpen(true);
    } catch (error) {
      setProviderAuthPreferredProviderId(null);
      setProviderAuthReturnFocusTarget("none");
      const message = describeProviderError(error, "Failed to load providers");
      setProviderAuthError(message);
      throw error;
    } finally {
      setProviderAuthBusy(false);
    }
  }

  function closeProviderAuthModal(optionsArg?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      optionsArg?.restorePromptFocus ??
      providerAuthReturnFocusTarget() === "composer";
    setProviderAuthModalOpen(false);
    setProviderAuthError(null);
    setProviderAuthPreferredProviderId(null);
    setProviderAuthReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      options.focusPromptSoon?.();
    }
  }

  return {
    providerAuthModalOpen,
    providerAuthBusy,
    providerAuthError,
    providerAuthMethods,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    startProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    disconnectProvider,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}
