/** @jsxImportSource react */
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { isTauriRuntime } from "../../../../app/utils";
import { compareProviders } from "../../../../app/utils/providers";
import { Button } from "../../../design-system/button";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { TextInput } from "../../../design-system/text-input";
import type {
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderOAuthStartResult,
} from "./store";

type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
};

type ProviderOAuthSession = ProviderOAuthStartResult & {
  providerId: string;
  methodLabel: string;
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
  preferredProviderId?: string | null;
  workerType?: "local" | "remote";
  providers: ProviderAuthProvider[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onConnectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  onSubmitOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  onRefreshProviders?: () => Promise<unknown>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
  const workerType = props.workerType === "remote" ? "remote" : "local";
  const isRemoteWorker = workerType === "remote";

  const [view, setView] = useState<
    "list" | "method" | "api" | "cloud" | "oauth-code" | "oauth-auto"
  >("list");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedCloudMethod, setSelectedCloudMethod] = useState<ProviderAuthMethod | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [oauthSession, setOauthSession] = useState<ProviderOAuthSession | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pollingBusy, setPollingBusy] = useState(false);
  const [oauthAutoBusy, setOauthAutoBusy] = useState(false);
  const [oauthCodeCopied, setOauthCodeCopied] = useState(false);
  const [oauthBrowserOpened, setOauthBrowserOpened] = useState(false);
  const [autoOpenedPreferredProviderId, setAutoOpenedPreferredProviderId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const providerPollRef = useRef<number | null>(null);
  const oauthAutoPollRef = useRef<number | null>(null);
  const oauthCodeCopiedResetRef = useRef<number | null>(null);

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

  const isOpenAiHeadlessMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && (label.includes("headless") || label.includes("device"));
  };

  const isOpenAiProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "openai" || normalizedName === "openai";
  };

  const isAnthropicProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "anthropic" || normalizedName === "anthropic";
  };

  const isClaudeProMaxMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && (label.includes("pro/max") || label.includes("create an api key"));
  };

  const entries = useMemo<ProviderAuthEntry[]>(() => {
    const methods = props.authMethods ?? {};
    const connected = new Set(props.connectedProviderIds ?? []);
    const providers = props.providers ?? [];

    return Object.keys(methods)
      .map((id): ProviderAuthEntry => {
        const provider = providers.find((item) => item.id === id);
        const entryMethods = (methods[id] ?? []).filter((method) => {
          if (isAnthropicProvider(id, provider?.name) && isClaudeProMaxMethod(method)) {
            return false;
          }
          if (!isOpenAiProvider(id, provider?.name)) return true;
          if (method.type !== "oauth") return true;
          if (isRemoteWorker) return isOpenAiHeadlessMethod(method);
          return !isOpenAiHeadlessMethod(method);
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
  }, [isRemoteWorker, props.authMethods, props.connectedProviderIds, props.providers]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedProviderId) ?? null,
    [entries, selectedProviderId],
  );

  const resolvedView = selectedEntry ? view : "list";
  const errorMessage = localError ?? props.error;

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const methodText = entry.methods.map((method) => method.label || (method.type === "oauth" ? "OAuth" : "API key")).join(" ");
      return `${entry.name} ${entry.id} ${methodText}`.toLowerCase().includes(query);
    });
  }, [entries, searchQuery]);

  const oauthInstructions = oauthSession?.authorization.instructions?.trim() ?? "";
  const isOpenAiHeadlessSession = Boolean(
    oauthSession && oauthSession.providerId === "openai" && oauthSession.methodLabel.toLowerCase().includes("headless"),
  );
  const shouldStartOauthAutoPolling =
    props.open &&
    resolvedView === "oauth-auto" &&
    oauthSession &&
    (!isOpenAiHeadlessSession || oauthBrowserOpened);

  const oauthDisplayCode = useMemo(() => {
    if (!oauthInstructions) return "";
    const matched = oauthInstructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0];
    if (matched) return matched;
    if (oauthInstructions.includes(":")) {
      return oauthInstructions.split(":").slice(1).join(":").trim();
    }
    return oauthInstructions;
  }, [oauthInstructions]);

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = props.loading || props.submitting;

  const resetState = () => {
    if (oauthCodeCopiedResetRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
      oauthCodeCopiedResetRef.current = null;
    }
    setView("list");
    setSelectedProviderId(null);
    setSelectedCloudMethod(null);
    setApiKeyInput("");
    setOauthCodeInput("");
    setOauthSession(null);
    setSearchQuery("");
    setActiveEntryIndex(0);
    setLocalError(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
  };

  const stopProviderPolling = () => {
    if (providerPollRef.current !== null) {
      window.clearInterval(providerPollRef.current);
      providerPollRef.current = null;
    }
  };

  const stopOauthAutoPolling = () => {
    if (oauthAutoPollRef.current !== null) {
      window.clearInterval(oauthAutoPollRef.current);
      oauthAutoPollRef.current = null;
    }
  };

  const handleClose = () => {
    void props.onRefreshProviders?.();
    stopOauthAutoPolling();
    stopProviderPolling();
    resetState();
    props.onClose();
  };

  useEffect(() => {
    if (!props.open) {
      setAutoOpenedPreferredProviderId(null);
      resetState();
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => Math.max(0, Math.min(current, total - 1)));
  }, [filteredEntries.length, props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    queueMicrotask(() => searchInputRef.current?.focus());
  }, [props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || props.loading || resolvedView !== "list") return;

    const preferredId = props.preferredProviderId?.trim().toLowerCase() ?? "";
    if (!preferredId || autoOpenedPreferredProviderId === preferredId) return;

    const entry = entries.find((item) => item.id.trim().toLowerCase() === preferredId);
    if (!entry) return;

    setAutoOpenedPreferredProviderId(preferredId);
    queueMicrotask(() => {
      handleEntrySelect(entry);
    });
  }, [
    autoOpenedPreferredProviderId,
    entries,
    props.loading,
    props.open,
    props.preferredProviderId,
    resolvedView,
  ]);

  useEffect(() => {
    return () => {
      stopOauthAutoPolling();
      stopProviderPolling();
      if (oauthCodeCopiedResetRef.current !== null) {
        window.clearTimeout(oauthCodeCopiedResetRef.current);
        oauthCodeCopiedResetRef.current = null;
      }
    };
  }, []);

  const isOauthView = resolvedView === "oauth-code" || resolvedView === "oauth-auto";
  const activeProviderId = oauthSession?.providerId ?? selectedProviderId;
  const isActiveProviderConnected =
    !!activeProviderId && (props.connectedProviderIds ?? []).includes(activeProviderId);

  const pollProviders = async () => {
    const id = activeProviderId;
    if (!id || pollingBusy) return;
    setPollingBusy(true);
    try {
      await props.onRefreshProviders?.();
    } finally {
      setPollingBusy(false);
    }
    if ((props.connectedProviderIds ?? []).includes(id)) {
      handleClose();
    }
  };

  const startProviderPolling = () => {
    if (typeof window === "undefined") return;
    if (providerPollRef.current !== null) return;
    void pollProviders();
    providerPollRef.current = window.setInterval(() => {
      void pollProviders();
    }, 2000);
  };

  useEffect(() => {
    if (!props.open || !isOauthView) {
      stopProviderPolling();
      return;
    }
    if (isActiveProviderConnected) {
      handleClose();
      return;
    }
    startProviderPolling();
  }, [isActiveProviderConnected, isOauthView, props.open]);

  const openOauthUrl = async (url: string) => {
    if (!url) return;
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      setOauthBrowserOpened(true);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setOauthBrowserOpened(true);
  };

  const copyOauthDisplayCode = async () => {
    const code = oauthDisplayCode.trim();
    if (!code) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setLocalError("Clipboard is unavailable in this environment.");
      return;
    }
    await navigator.clipboard.writeText(code);
    setOauthCodeCopied(true);
    if (typeof window === "undefined") return;
    if (oauthCodeCopiedResetRef.current !== null) {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
    }
    oauthCodeCopiedResetRef.current = window.setTimeout(() => {
      setOauthCodeCopied(false);
      oauthCodeCopiedResetRef.current = null;
    }, 2000);
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

  const attemptOauthAutoCompletion = async () => {
    const session = oauthSession;
    if (!session || oauthAutoBusy) return;
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
    if (oauthAutoPollRef.current !== null) return;
    void attemptOauthAutoCompletion();
    oauthAutoPollRef.current = window.setInterval(() => {
      void attemptOauthAutoCompletion();
    }, 2000);
  };

  useEffect(() => {
    if (!shouldStartOauthAutoPolling) {
      stopOauthAutoPolling();
      return;
    }
    startOauthAutoPolling();
  }, [shouldStartOauthAutoPolling]);

  const startOauth = async (entry: ProviderAuthEntry, methodIndex?: number) => {
    if (actionDisabled) return;
    if (!Number.isInteger(methodIndex) || methodIndex === undefined) {
      setLocalError(`No OAuth flow available for ${entry.name}.`);
      return;
    }
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    try {
      const started = await props.onSelect(entry.id, methodIndex);
      const selectedMethod = entry.methods.find((method) => method.methodIndex === methodIndex);
      if (!selectedMethod) {
        throw new Error(`Selected auth method is unavailable for ${entry.name}.`);
      }
      const nextSession: ProviderOAuthSession = {
        providerId: entry.id,
        methodIndex: started.methodIndex,
        methodLabel: selectedMethod.label,
        authorization: started.authorization,
      };
      setOauthSession(nextSession);

      if (started.authorization.method === "code") {
        await openOauthUrl(started.authorization.url);
        setView("oauth-code");
        return;
      }

      if (!isOpenAiHeadlessMethod(selectedMethod)) {
        await openOauthUrl(started.authorization.url);
      }

      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
    }
  };

  const handleMethodSelect = async (method: ProviderAuthMethod) => {
    if (!selectedEntry || actionDisabled) return;
    setLocalError(null);
    setSelectedCloudMethod(null);

    if (method.type === "oauth") {
      await startOauth(selectedEntry, method.methodIndex);
      return;
    }

    if (method.type === "cloud") {
      setSelectedCloudMethod(method);
      setView("cloud");
      return;
    }

    setView("api");
  };

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
    if (actionDisabled) return;
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

  const handleApiSubmit = async () => {
    if (!selectedEntry || actionDisabled) return;

    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setLocalError("API key is required.");
      return;
    }

    setLocalError(null);
    try {
      await props.onSubmitApiKey(selectedEntry.id, trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setLocalError(message);
    }
  };

  const handleCloudSubmit = async () => {
    if (!selectedCloudMethod?.cloudProviderId || actionDisabled) return;

    setLocalError(null);
    try {
      await props.onConnectCloudProvider(selectedCloudMethod.cloudProviderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect organization provider";
      setLocalError(message);
    }
  };

  const handleOauthCodeSubmit = async () => {
    if (!selectedEntry || !oauthSession || actionDisabled) return;

    const trimmed = oauthCodeInput.trim();
    if (!trimmed) {
      setLocalError("Authorization code is required.");
      return;
    }

    await submitOauth(selectedEntry.id, oauthSession.methodIndex, trimmed);
  };

  const handleBack = () => {
    if (resolvedView === "oauth-code" || resolvedView === "oauth-auto") {
      if ((selectedEntry?.methods.length ?? 0) > 1) {
        setView("method");
      } else {
        setView("list");
      }
      setOauthSession(null);
      setOauthCodeInput("");
      setOauthCodeCopied(false);
      setOauthBrowserOpened(false);
      setLocalError(null);
      return;
    }

    if (resolvedView === "api" && (selectedEntry?.methods.length ?? 0) > 1) {
      setView("method");
      setSelectedCloudMethod(null);
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    if (resolvedView === "cloud" && (selectedEntry?.methods.length ?? 0) > 1) {
      setView("method");
      setSelectedCloudMethod(null);
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    if (resolvedView === "api") return "Saving API key...";
    if (resolvedView === "cloud") return "Connecting organization provider...";
    if (resolvedView === "oauth-code") return "Verifying authorization code...";
    if (resolvedView === "oauth-auto") return "Waiting for OAuth confirmation...";
    return "Opening authentication...";
  };

  const stepEntryIndex = (delta: number) => {
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (resolvedView !== "list") return;
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
      const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { keyCode?: number };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      const entry = filteredEntries[activeEntryIndex];
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
    if (isOpenAiProvider(entry.id, entry.name) && (label.includes("headless") || label.includes("device"))) {
      return isRemoteWorker
        ? "Use OpenAI's device flow for remote workers, where the browser callback may not resolve on your local machine."
        : "Use OpenAI's device flow when the local browser callback is unreliable.";
    }
    if (method.type === "oauth") {
      return "Continue in the browser and let OpenWork finish the connection automatically.";
    }
    if (method.type === "cloud") {
      return method.description ?? "Use the provider and credential managed by your organization.";
    }
    return "Paste a secret key that OpenWork stores locally on this device.";
  };

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
        <div className="px-6 pt-6 pb-4 border-b border-gray-6/50 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-12">Connect providers</h3>
            <p className="text-sm text-gray-11 mt-1">
              Sign in to services or use providers managed by your organization.
            </p>
          </div>
          <Button variant="ghost" className="!p-2 rounded-full" onClick={handleClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        <div className="px-6 py-4 flex flex-col gap-4 min-h-0">
          <div className="min-h-[36px]">
            {errorMessage ? (
              <div className="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                {errorMessage}
              </div>
            ) : props.loading ? (
              <div className="rounded-xl border border-gray-6 bg-gray-1/60 px-4 py-3 text-sm text-gray-10 animate-pulse">
                Loading providers...
              </div>
            ) : null}
          </div>

          {!props.loading ? (
            <div className="flex-1 space-y-2 overflow-y-auto pr-1 -mr-1">
              {resolvedView === "list" ? (
                <div className="space-y-3" onKeyDown={handleListKeyDown}>
                  <div className="relative flex items-center mb-1">
                    <Search size={16} className="absolute left-3 text-gray-9" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter providers by name or ID"
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveEntryIndex(0);
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={actionDisabled}
                      className="w-full rounded-xl bg-gray-2 px-9 py-2.5 text-[13px] text-gray-12 placeholder:text-gray-9 border border-gray-6/60 focus:border-gray-8 focus:bg-gray-1 focus:outline-none transition-colors shadow-sm"
                    />
                  </div>

                  {filteredEntries.length ? (
                    filteredEntries.map((entry, index) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`w-full group flex items-start gap-3.5 rounded-xl px-3.5 py-3 text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                          index === activeEntryIndex ? "bg-gray-3/60" : "hover:bg-gray-3/30"
                        }`}
                        disabled={actionDisabled}
                        onMouseEnter={() => setActiveEntryIndex(index)}
                        onClick={() => handleEntrySelect(entry)}
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-5/60 bg-gray-2 shadow-sm overflow-hidden">
                          <ProviderIcon providerId={entry.id} size={18} className="text-gray-12" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex items-center gap-2">
                              <div className="text-[14px] font-medium text-gray-12 truncate tracking-tight">
                                {entry.name}
                              </div>
                            </div>
                            <div className="flex items-center justify-end shrink-0">
                              {entry.connected ? (
                                <div className="flex items-center gap-1 text-[11px] font-medium text-green-11 bg-green-4/20 border border-green-5/30 px-1.5 py-0.5 rounded-md">
                                  <CheckCircle2 size={12} strokeWidth={2.5} />
                                  Connected
                                </div>
                              ) : (
                                <div className="text-[12px] font-medium text-gray-9 group-hover:text-gray-12 transition-colors flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                                  Connect
                                  <ChevronRight size={14} className="opacity-0 -ml-2 group-hover:opacity-100 group-hover:ml-0 transition-all duration-200" />
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] text-gray-9 font-mono truncate mt-0.5 opacity-60 group-hover:opacity-80 transition-opacity">
                            {entry.id}
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {entry.methods.map((method) => (
                              <span
                                key={`${entry.id}-${method.type}-${method.methodIndex ?? method.cloudProviderId ?? method.label}`}
                                className={`text-[10px] font-medium px-2 py-0.5 rounded-md border ${
                                  method.type === "oauth"
                                    ? "bg-indigo-3/30 text-indigo-11 border-indigo-5/30"
                                    : method.type === "cloud"
                                      ? "bg-emerald-3/30 text-emerald-11 border-emerald-5/30"
                                      : "bg-gray-3/40 text-gray-11 border-gray-6/40"
                                }`}
                              >
                                {methodLabel(method)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-sm text-gray-10 pt-2">
                      {entries.length ? "No providers match your search." : "No providers available."}
                    </div>
                  )}

                  <div className="text-[11px] text-gray-9">Arrow keys to navigate, Enter to select.</div>
                </div>
              ) : null}

              {resolvedView === "method" && selectedEntry ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Choose how you'd like to connect.</div>
                    </div>
                    <Button variant="ghost" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {selectedEntry.methods.map((method) => (
                      <button
                        key={`${selectedEntry.id}-${method.type}-${method.methodIndex ?? method.cloudProviderId ?? method.label}`}
                        type="button"
                        className={`w-full rounded-xl border px-4 py-3.5 text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                          method.type === "oauth"
                            ? "border-indigo-5/40 bg-indigo-3/20 hover:bg-indigo-4/30 shadow-sm"
                            : "border-gray-5/50 bg-gray-2 hover:bg-gray-3/50 shadow-sm"
                        }`}
                        onClick={() => void handleMethodSelect(method)}
                        disabled={actionDisabled}
                      >
                        <div className="text-sm font-medium text-gray-12">{methodLabel(method)}</div>
                        <div className="mt-1 text-xs text-gray-10">{methodDescription(selectedEntry, method)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {resolvedView === "api" && selectedEntry ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Paste your API key to connect.</div>
                    </div>
                    <Button variant="ghost" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <TextInput
                    label="API key"
                    type="password"
                    placeholder="sk-..."
                    value={apiKeyInput}
                    onChange={(event) => {
                      setApiKeyInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  {selectedEntry.env.length > 0 ? (
                    <div className="text-[11px] text-gray-9">
                      Env vars: <span className="font-mono">{selectedEntry.env.join(", ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-gray-9">Keys are stored locally by OpenCode.</div>
                    <Button
                      variant="secondary"
                      onClick={handleApiSubmit}
                      disabled={actionDisabled || !apiKeyInput.trim()}
                    >
                      {props.submitting ? "Saving..." : "Save key"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "cloud" && selectedEntry && selectedCloudMethod ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Connect with the provider managed by your organization.</div>
                    </div>
                    <Button variant="ghost" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="text-xs text-gray-9">
                    {selectedCloudMethod.description ?? "Use the provider and credential managed by your organization."}
                  </div>
                  {(selectedCloudMethod.modelCount ?? 0) > 0 ? (
                    <div className="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-[11px] text-gray-9">
                      {(selectedCloudMethod.modelCount ?? 0)} curated model{(selectedCloudMethod.modelCount ?? 0) === 1 ? "" : "s"} will be added to this workspace.
                    </div>
                  ) : null}
                  {(selectedCloudMethod.env?.length ?? 0) > 0 ? (
                    <div className="text-[11px] text-gray-9">
                      Env vars: <span className="font-mono">{selectedCloudMethod.env?.join(", ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-gray-9">
                      OpenWork will install the provider config and use the credential stored for your org.
                    </div>
                    <Button variant="secondary" onClick={handleCloudSubmit} disabled={actionDisabled}>
                      {props.submitting ? "Connecting..." : "Connect provider"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-code" && selectedEntry && oauthSession ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Finish OAuth by pasting the authorization code.</div>
                    </div>
                    <Button variant="ghost" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="text-xs text-gray-9">
                    Complete sign-in in your browser, then paste the code here.
                  </div>
                  {oauthInstructions ? (
                    <div className="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-[11px] text-gray-9 font-mono break-all">
                      {oauthInstructions}
                    </div>
                  ) : null}
                  <TextInput
                    label="Authorization code"
                    type="text"
                    placeholder="Paste code"
                    value={oauthCodeInput}
                    onChange={(event) => {
                      setOauthCodeInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void handleOauthCodeSubmit();
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      Open browser again
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void handleOauthCodeSubmit()}
                      disabled={actionDisabled || !oauthCodeInput.trim()}
                    >
                      {props.submitting ? "Verifying..." : "Complete connection"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-auto" && selectedEntry && oauthSession ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Waiting for browser confirmation.</div>
                    </div>
                    <Button variant="ghost" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  {isOpenAiHeadlessSession ? (
                    <div className="space-y-2 text-xs text-gray-9">
                      <div>You'll need to sign in to your OpenAI account and provide the code below.</div>
                      <div>The first time you do this you'll need to enable Device auth in your account settings.</div>
                      <div>ChatGPT &gt; Account Settings &gt; Security &gt; Enable device code authorization</div>
                      <div>When you're ready, copy the code below, and click &quot;Open Browser&quot;.</div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-9">
                      Sign in in the browser tab we just opened. We will complete the connection automatically.
                    </div>
                  )}
                  {oauthDisplayCode ? (
                    <div className="rounded-xl border border-gray-6/70 bg-gray-2/40 px-3 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-gray-8">Confirmation code</div>
                        <div className="text-sm text-gray-12 font-mono break-all">{oauthDisplayCode}</div>
                      </div>
                      <Button variant="ghost" className="text-xs shrink-0" onClick={() => void copyOauthDisplayCode()}>
                        {oauthCodeCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  ) : null}
                  {isOpenAiHeadlessSession && !oauthBrowserOpened ? (
                    <div className="flex items-center gap-2 text-xs text-gray-9">
                      <span>Authorization checks will start after you click Open Browser.</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-9">
                      <Loader2 size={14} className={props.submitting || pollingBusy || oauthAutoBusy ? "animate-spin" : ""} />
                      <span>Checking connection status automatically...</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      {isOpenAiHeadlessSession
                        ? oauthBrowserOpened
                          ? "Reopen Browser"
                          : "Open Browser"
                        : "Open browser again"}
                    </Button>
                    <div className="text-[11px] text-gray-9 text-right">
                      This window will close once the provider is connected.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="px-6 pt-4 pb-6 border-t border-gray-6/50 flex flex-col gap-3">
          <div className="min-h-[16px] text-xs text-gray-10">
            {props.submitting ? submittingLabel() : null}
          </div>
          <Button variant="ghost" onClick={handleClose} disabled={actionDisabled}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
