import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2/client";
import { CheckCircle2, Loader2, X } from "lucide-solid";
import type { ProviderListItem } from "../types";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import { isTauriRuntime } from "../utils";
import { compareProviders } from "../utils/providers";

import Button from "./button";
import TextInput from "./text-input";

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  methodIndex?: number;
};
type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

type ProviderOAuthSession = ProviderOAuthStartResult & {
  providerId: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

export type ProviderAuthModalProps = {
  open: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  providers: ProviderListItem[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onSubmitOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  onRefreshProviders?: () => Promise<unknown>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
  const openworkDeployment = getOpenWorkDeployment();

  const formatProviderName = (id: string, fallback?: string) => {
    const named = fallback?.trim();
    if (named) return named;

    const normalized = id.trim();
    const mapped = PROVIDER_LABELS[normalized.toLowerCase()];
    if (mapped) return mapped;

    const cleaned = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return id;

    return cleaned
      .split(" ")
      .filter(Boolean)
      .map((word) => {
        if (/\d/.test(word) || word.length <= 3) {
          return word.toUpperCase();
        }
        const lower = word.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(" ");
  };

  const entries = createMemo<ProviderAuthEntry[]>(() => {
    const methods = props.authMethods ?? {};
    const connected = new Set(props.connectedProviderIds ?? []);
    const providers = props.providers ?? [];

    return Object.keys(methods)
      .map((id): ProviderAuthEntry => {
        const provider = providers.find((item) => item.id === id);
        const entryMethods = (methods[id] ?? []).filter((method) => {
          if (id !== "openai") return true;
          if (openworkDeployment !== "web") return true;
          return method.type !== "oauth";
        });
        return {
          id,
          name: formatProviderName(id, provider?.name),
          methods: entryMethods,
          connected: connected.has(id),
          env: Array.isArray(provider?.env) ? provider.env : [],
        };
      })
      .filter((entry) => entry.methods.length > 0)
      .sort(compareProviders);
  });

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = () => props.loading || props.submitting;

  const [view, setView] = createSignal<"list" | "method" | "api" | "oauth-code" | "oauth-auto">("list");
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [oauthCodeInput, setOauthCodeInput] = createSignal("");
  const [oauthSession, setOauthSession] = createSignal<ProviderOAuthSession | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeEntryIndex, setActiveEntryIndex] = createSignal(0);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [pollingBusy, setPollingBusy] = createSignal(false);
  const [oauthAutoBusy, setOauthAutoBusy] = createSignal(false);
  let searchInputEl: HTMLInputElement | undefined;
  let providerPoll: number | null = null;
  let oauthAutoPoll: number | null = null;

  const selectedEntry = createMemo(() =>
    entries().find((entry) => entry.id === selectedProviderId()) ?? null,
  );

  const resolvedView = createMemo(() => (selectedEntry() ? view() : "list"));
  const errorMessage = createMemo(() => localError() ?? props.error);

  const filteredEntries = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return entries();
    return entries().filter((entry) => {
      const methodText = entry.methods.map((method) => methodLabel(method)).join(" ");
      return `${entry.name} ${entry.id} ${methodText}`.toLowerCase().includes(query);
    });
  });

  const oauthInstructions = createMemo(() => oauthSession()?.authorization.instructions?.trim() ?? "");

  const oauthDisplayCode = createMemo(() => {
    const instructions = oauthInstructions();
    if (!instructions) return "";
    const matched = instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0];
    if (matched) return matched;
    if (instructions.includes(":")) {
      return instructions.split(":").slice(1).join(":").trim();
    }
    return instructions;
  });

  const resetState = () => {
    setView("list");
    setSelectedProviderId(null);
    setApiKeyInput("");
    setOauthCodeInput("");
    setOauthSession(null);
    setSearchQuery("");
    setActiveEntryIndex(0);
    setLocalError(null);
  };

  createEffect(() => {
    if (!props.open) {
      resetState();
    }
  });

  createEffect(() => {
    if (!props.open || resolvedView() !== "list") return;
    const total = filteredEntries().length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => Math.max(0, Math.min(current, total - 1)));
  });

  createEffect(() => {
    if (!props.open || resolvedView() !== "list") return;
    queueMicrotask(() => {
      searchInputEl?.focus();
    });
  });

  const handleClose = () => {
    void props.onRefreshProviders?.();
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
    resetState();
    props.onClose();
  };

  onCleanup(() => {
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
  });

  const isOauthView = () => resolvedView() === "oauth-code" || resolvedView() === "oauth-auto";
  const activeProviderId = () => oauthSession()?.providerId ?? selectedProviderId();

  const isActiveProviderConnected = () => {
    const id = activeProviderId();
    if (!id) return false;
    return (props.connectedProviderIds ?? []).includes(id);
  };

  const pollProviders = async () => {
    const id = activeProviderId();
    if (!id) return;
    if (pollingBusy()) return;
    setPollingBusy(true);
    try {
      await props.onRefreshProviders?.();
    } finally {
      setPollingBusy(false);
    }
    if (isActiveProviderConnected()) {
      handleClose();
    }
  };

  const startProviderPolling = () => {
    if (typeof window === "undefined") return;
    if (providerPoll !== null) return;
    void pollProviders();
    providerPoll = window.setInterval(() => {
      void pollProviders();
    }, 2000);
  };

  const stopProviderPolling = () => {
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
  };

  createEffect(() => {
    if (!props.open || !isOauthView()) {
      stopProviderPolling();
      return;
    }
    if (isActiveProviderConnected()) {
      handleClose();
      return;
    }
    startProviderPolling();
  });

  createEffect(() => {
    if (!props.open || resolvedView() !== "oauth-auto" || !oauthSession()) {
      stopOauthAutoPolling();
      return;
    }
    startOauthAutoPolling();
  });

  const openOauthUrl = async (url: string) => {
    if (!url) return;
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const submitOauth = async (providerId: string, methodIndex: number, code?: string) => {
    const trimmedCode = code?.trim();
    setLocalError(null);
    try {
      return await props.onSubmitOAuth(providerId, methodIndex, trimmedCode || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to complete OAuth";
      setLocalError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const stopOauthAutoPolling = () => {
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
  };

  const attemptOauthAutoCompletion = async () => {
    const session = oauthSession();
    if (!session || oauthAutoBusy()) return;
    setOauthAutoBusy(true);
    try {
      const result = await submitOauth(session.providerId, session.methodIndex);
      if (result?.connected) {
        stopOauthAutoPolling();
      }
    } finally {
      setOauthAutoBusy(false);
    }
  };

  const startOauthAutoPolling = () => {
    if (typeof window === "undefined") return;
    if (oauthAutoPoll !== null) return;
    void attemptOauthAutoCompletion();
    oauthAutoPoll = window.setInterval(() => {
      void attemptOauthAutoCompletion();
    }, 2000);
  };

  const startOauth = async (entry: ProviderAuthEntry, methodIndex?: number) => {
    if (actionDisabled()) return;
    if (!Number.isInteger(methodIndex) || methodIndex === undefined) {
      setLocalError(`No OAuth flow available for ${entry.name}.`);
      return;
    }
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    try {
      const started = await props.onSelect(entry.id, methodIndex);
      const nextSession: ProviderOAuthSession = {
        providerId: entry.id,
        methodIndex: started.methodIndex,
        authorization: started.authorization,
      };
      setOauthSession(nextSession);
      await openOauthUrl(started.authorization.url);

      if (started.authorization.method === "code") {
        setView("oauth-code");
        return;
      }

      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
    }
  };

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
    if (actionDisabled()) return;
    setLocalError(null);
    setSelectedProviderId(entry.id);

    if (entry.methods.length === 1) {
      void handleMethodSelect(entry.methods[0]);
      return;
    }

    if (entry.methods.length > 1) {
      setView("method");
      return;
    }

    setLocalError(`No authentication methods available for ${entry.name}.`);
  };

  const handleMethodSelect = async (method: ProviderAuthMethod) => {
    const entry = selectedEntry();
    if (!entry || actionDisabled()) return;
    setLocalError(null);

    if (method.type === "oauth") {
      await startOauth(entry, method.methodIndex);
      return;
    }

    setView("api");
  };

  const handleApiSubmit = async () => {
    const entry = selectedEntry();
    if (!entry || actionDisabled()) return;

    const trimmed = apiKeyInput().trim();
    if (!trimmed) {
      setLocalError("API key is required.");
      return;
    }

    setLocalError(null);
    try {
      await props.onSubmitApiKey(entry.id, trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setLocalError(message);
    }
  };

  const handleOauthCodeSubmit = async () => {
    const entry = selectedEntry();
    const session = oauthSession();
    if (!entry || !session || actionDisabled()) return;

    const trimmed = oauthCodeInput().trim();
    if (!trimmed) {
      setLocalError("Authorization code is required.");
      return;
    }

    await submitOauth(entry.id, session.methodIndex, trimmed);
  };

  const handleBack = () => {
    if (resolvedView() === "oauth-code" || resolvedView() === "oauth-auto") {
      if ((selectedEntry()?.methods.length ?? 0) > 1) {
        setView("method");
      } else {
        setView("list");
      }
      setOauthSession(null);
      setOauthCodeInput("");
      setLocalError(null);
      return;
    }

    if (resolvedView() === "api" && (selectedEntry()?.methods.length ?? 0) > 1) {
      setView("method");
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    if (resolvedView() === "api") return "Saving API key...";
    if (resolvedView() === "oauth-code") return "Verifying authorization code...";
    if (resolvedView() === "oauth-auto") return "Waiting for OAuth confirmation...";
    return "Opening authentication...";
  };

  const stepEntryIndex = (delta: number) => {
    const total = filteredEntries().length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const handleListKeyDown = (event: KeyboardEvent) => {
    if (resolvedView() !== "list") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepEntryIndex(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepEntryIndex(-1);
      return;
    }
    if (event.key === "Enter") {
      if (event.isComposing || (event as KeyboardEvent & { keyCode?: number }).keyCode === 229) return;
      const entry = filteredEntries()[activeEntryIndex()];
      if (!entry) return;
      event.preventDefault();
      handleEntrySelect(entry);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  };

  const methodDescription = (entry: ProviderAuthEntry, method: ProviderAuthMethod) => {
    const label = methodLabel(method).toLowerCase();
    if (entry.id === "openai" && label.includes("headless")) {
      return "Use OpenAI's device flow when the local browser callback is unreliable.";
    }
    if (method.type === "oauth") {
      return "Continue in the browser and let OpenWork finish the connection automatically.";
    }
    return "Paste a secret key that OpenWork stores locally on this device.";
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="px-6 pt-6 pb-4 border-b border-gray-6/50 flex items-start justify-between gap-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-12">Connect providers</h3>
              <p class="text-sm text-gray-11 mt-1">Sign in to services you want OpenWork to use.</p>
            </div>
            <Button
              variant="ghost"
              class="!p-2 rounded-full"
              onClick={handleClose}
              aria-label="Close"
            >
              <X size={16} />
            </Button>
          </div>

          <div class="px-6 py-4 flex flex-col gap-4 min-h-0">
            <div class="min-h-[36px]">
              <Show
                when={errorMessage()}
                fallback={
                  <Show when={props.loading}>
                    <div class="rounded-xl border border-gray-6 bg-gray-1/60 px-4 py-3 text-sm text-gray-10 animate-pulse">
                      Loading providers...
                    </div>
                  </Show>
                }
              >
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {errorMessage()}
                </div>
              </Show>
            </div>

            <Show when={!props.loading}>
              <div class="flex-1 space-y-2 overflow-y-auto pr-1 -mr-1">
                <Show when={resolvedView() === "list"}>
                  <div class="space-y-3" onKeyDown={handleListKeyDown}>
                    <TextInput
                      ref={searchInputEl}
                      label="Search"
                      type="text"
                      placeholder="Filter providers by name or ID"
                      value={searchQuery()}
                      onInput={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveEntryIndex(0);
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />

                    <Show
                      when={filteredEntries().length}
                      fallback={
                        <div class="text-sm text-gray-10">
                          {entries().length ? "No providers match your search." : "No providers available."}
                        </div>
                      }
                    >
                      <For each={filteredEntries()}>
                        {(entry, index) => {
                          const idx = () => index();
                          return (
                            <button
                              type="button"
                              class={`w-full rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                                idx() === activeEntryIndex()
                                  ? "border-gray-8 bg-gray-1/80"
                                  : "border-gray-6 bg-gray-1/40 hover:bg-gray-1/70"
                              }`}
                              disabled={actionDisabled()}
                              onMouseEnter={() => setActiveEntryIndex(idx())}
                              onClick={() => handleEntrySelect(entry)}
                            >
                              <div class="flex items-center justify-between gap-3">
                                <div class="min-w-0">
                                  <div class="text-sm font-medium text-gray-12 truncate">{entry.name}</div>
                                  <div class="text-[11px] text-gray-8 font-mono truncate">{entry.id}</div>
                                </div>
                                <div class="flex items-center justify-end gap-2 shrink-0 min-w-[108px]">
                                  <Show
                                    when={entry.connected}
                                    fallback={<span class="text-xs text-gray-9">Connect</span>}
                                  >
                                    <div class="flex items-center gap-1 text-[11px] text-green-11 bg-green-7/10 border border-green-7/20 px-2 py-1 rounded-full">
                                      <CheckCircle2 size={12} />
                                      Connected
                                    </div>
                                  </Show>
                                </div>
                              </div>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={entry.methods}>
                                  {(method) => (
                                    <span
                                      class={`text-[10px] uppercase tracking-[0.2em] px-2 py-1 rounded-full border ${
                                        method.type === "oauth"
                                          ? "bg-indigo-7/15 text-indigo-11 border-indigo-7/30"
                                          : "bg-gray-3 text-gray-11 border-gray-6"
                                      }`}
                                    >
                                      {methodLabel(method)}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </button>
                          );
                        }}
                      </For>
                    </Show>

                    <div class="text-[11px] text-gray-9">Arrow keys to navigate, Enter to select.</div>
                  </div>
                </Show>

                <Show when={resolvedView() === "method" && selectedEntry()}>
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-gray-12">{selectedEntry()!.name}</div>
                        <div class="text-xs text-gray-10 mt-1">Choose how you'd like to connect.</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        Back
                      </Button>
                    </div>
                    <div class="grid gap-2">
                      <For each={selectedEntry()!.methods}>
                        {(method) => (
                          <button
                            type="button"
                            class={`w-full rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                              method.type === "oauth"
                                ? "border-indigo-7/30 bg-indigo-7/10 hover:bg-indigo-7/15"
                                : "border-gray-6 bg-gray-1/20 hover:bg-gray-1/50"
                            }`}
                            onClick={() => void handleMethodSelect(method)}
                            disabled={actionDisabled()}
                          >
                            <div class="text-sm font-medium text-gray-12">{methodLabel(method)}</div>
                            <div class="mt-1 text-xs text-gray-10">{methodDescription(selectedEntry()!, method)}</div>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "api" && selectedEntry()}>
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-gray-12">{selectedEntry()!.name}</div>
                        <div class="text-xs text-gray-10 mt-1">Paste your API key to connect.</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        Back
                      </Button>
                    </div>
                    <TextInput
                      label="API key"
                      type="password"
                      placeholder="sk-..."
                      value={apiKeyInput()}
                      onInput={(event) => {
                        setApiKeyInput(event.currentTarget.value);
                        if (localError()) setLocalError(null);
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />
                    <Show when={selectedEntry()!.env.length > 0}>
                      <div class="text-[11px] text-gray-9">
                        Env vars: <span class="font-mono">{selectedEntry()!.env.join(", ")}</span>
                      </div>
                    </Show>
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-[11px] text-gray-9">
                        Keys are stored locally by OpenCode.
                      </div>
                      <Button
                        variant="secondary"
                        onClick={handleApiSubmit}
                        disabled={actionDisabled() || !apiKeyInput().trim()}
                      >
                        {props.submitting ? "Saving..." : "Save key"}
                      </Button>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "oauth-code" && selectedEntry() && oauthSession()}>
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-gray-12">{selectedEntry()!.name}</div>
                        <div class="text-xs text-gray-10 mt-1">Finish OAuth by pasting the authorization code.</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        Back
                      </Button>
                    </div>
                    <div class="text-xs text-gray-9">
                      Complete sign-in in your browser, then paste the code here.
                    </div>
                    <Show when={oauthInstructions()}>
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-[11px] text-gray-9 font-mono break-all">
                        {oauthInstructions()}
                      </div>
                    </Show>
                    <TextInput
                      label="Authorization code"
                      type="text"
                      placeholder="Paste code"
                      value={oauthCodeInput()}
                      onInput={(event) => {
                        setOauthCodeInput(event.currentTarget.value);
                        if (localError()) setLocalError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void handleOauthCodeSubmit();
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />
                    <div class="flex items-center justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => {
                          const url = oauthSession()?.authorization.url ?? "";
                          void openOauthUrl(url);
                        }}
                        disabled={actionDisabled()}
                      >
                        Open browser again
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void handleOauthCodeSubmit()}
                        disabled={actionDisabled() || !oauthCodeInput().trim()}
                      >
                        {props.submitting ? "Verifying..." : "Complete connection"}
                      </Button>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "oauth-auto" && selectedEntry() && oauthSession()}>
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-gray-12">{selectedEntry()!.name}</div>
                        <div class="text-xs text-gray-10 mt-1">Waiting for browser confirmation.</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        Back
                      </Button>
                    </div>
                    <div class="text-xs text-gray-9">Sign in in the browser tab we just opened. We will complete the connection automatically.</div>
                    <Show when={oauthDisplayCode()}>
                      <TextInput label="Confirmation code" value={oauthDisplayCode()} readOnly class="font-mono" />
                    </Show>
                    <div class="flex items-center gap-2 text-xs text-gray-9">
                      <Loader2 size={14} class={props.submitting || pollingBusy() || oauthAutoBusy() ? "animate-spin" : ""} />
                      <span>Checking connection status automatically...</span>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => {
                          const url = oauthSession()?.authorization.url ?? "";
                          void openOauthUrl(url);
                        }}
                        disabled={actionDisabled()}
                      >
                        Open browser again
                      </Button>
                      <div class="text-[11px] text-gray-9 text-right">This window will close once the provider is connected.</div>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          <div class="px-6 pt-4 pb-6 border-t border-gray-6/50 flex flex-col gap-3">
            <div class="min-h-[16px] text-xs text-gray-10">
              <Show when={props.submitting}>{submittingLabel()}</Show>
            </div>
            <div class="text-xs text-gray-9">
              OAuth opens in your browser. API keys are stored locally by OpenCode (not in your repo). Use{" "}
              <span class="font-mono">/models</span> to pick a default.
            </div>
            <Button variant="ghost" onClick={handleClose} disabled={actionDisabled()}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
