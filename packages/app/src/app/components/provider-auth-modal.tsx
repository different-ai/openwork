import { CheckCircle2, X } from "lucide-solid";
import type { ProviderListItem } from "../types";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import Button from "./button";
import TextInput from "./text-input";

type ProviderAuthMethod = { type: "oauth" | "api"; label: string };
type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
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
  onSelect: (providerId: string) => void;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
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
        return {
          id,
          name: formatProviderName(id, provider?.name),
          methods: methods[id] ?? [],
          connected: connected.has(id),
          env: Array.isArray(provider?.env) ? provider.env : [],
        };
      })
      .sort((a, b) => {
        const aIsOpencode = a.id === "opencode";
        const bIsOpencode = b.id === "opencode";
        if (aIsOpencode !== bIsOpencode) return aIsOpencode ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = () => props.loading || props.submitting;

  const [view, setView] = createSignal<"list" | "method" | "api">("list");
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [localError, setLocalError] = createSignal<string | null>(null);

  const selectedEntry = createMemo(() =>
    entries().find((entry) => entry.id === selectedProviderId()) ?? null,
  );

  const resolvedView = createMemo(() => (selectedEntry() ? view() : "list"));
  const errorMessage = createMemo(() => localError() ?? props.error);

  const resetState = () => {
    setView("list");
    setSelectedProviderId(null);
    setApiKeyInput("");
    setLocalError(null);
  };

  createEffect(() => {
    if (!props.open) {
      resetState();
    }
  });

  const hasMethod = (entry: ProviderAuthEntry | null, type: ProviderAuthMethod["type"]) =>
    !!entry?.methods?.some((method) => method.type === type);

  const handleClose = () => {
    resetState();
    props.onClose();
  };

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
    if (actionDisabled()) return;
    setLocalError(null);
    setSelectedProviderId(entry.id);

    const hasOauth = hasMethod(entry, "oauth");
    const hasApi = hasMethod(entry, "api");

    if (hasOauth && !hasApi) {
      props.onSelect(entry.id);
      return;
    }

    if (hasApi && !hasOauth) {
      setView("api");
      return;
    }

    if (hasApi && hasOauth) {
      setView("method");
      return;
    }

    props.onSelect(entry.id);
  };

  const handleMethodSelect = (method: ProviderAuthMethod["type"]) => {
    const entry = selectedEntry();
    if (!entry || actionDisabled()) return;
    setLocalError(null);

    if (method === "oauth") {
      props.onSelect(entry.id);
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

  const handleBack = () => {
    if (resolvedView() === "api" && hasMethod(selectedEntry(), "oauth")) {
      setView("method");
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    return resolvedView() === "api" ? "Saving API key..." : "Opening authentication...";
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
                  <Show
                    when={entries().length}
                    fallback={<div class="text-sm text-gray-10">No providers available.</div>}
                  >
                    <For each={entries()}>
                      {(entry) => (
                        <button
                          type="button"
                          class="w-full rounded-xl border border-gray-6 bg-gray-1/40 px-4 py-3 text-left transition-colors hover:bg-gray-1/70 disabled:opacity-60 disabled:cursor-not-allowed"
                          disabled={actionDisabled()}
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
                      )}
                    </For>
                  </Show>
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
                      <Show when={hasMethod(selectedEntry(), "oauth")}>
                        <Button
                          variant="secondary"
                          onClick={() => handleMethodSelect("oauth")}
                          disabled={actionDisabled()}
                        >
                          Continue with OAuth
                        </Button>
                      </Show>
                      <Show when={hasMethod(selectedEntry(), "api")}>
                        <Button
                          variant="outline"
                          onClick={() => handleMethodSelect("api")}
                          disabled={actionDisabled()}
                        >
                          Use API key
                        </Button>
                      </Show>
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
