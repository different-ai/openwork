import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";

import { parse } from "jsonc-parser";

import { currentLocale, t } from "../../i18n";
import { DEFAULT_MODEL, SESSION_MODEL_PREF_KEY } from "../constants";
import {
  formatGenericBehaviorLabel,
  getModelBehaviorSummary,
  normalizeModelBehaviorValue,
  sanitizeModelBehaviorValue,
} from "../lib/model-behavior";
import { unwrap } from "../lib/opencode";
import { readOpencodeConfig, writeOpencodeConfig } from "../lib/tauri";
import type { OpenworkServerClient } from "../lib/openwork-server";
import type {
  Client,
  MessageWithParts,
  ModelOption,
  ModelRef,
  ProviderListItem,
} from "../types";
import {
  addOpencodeCacheHint,
  formatModelLabel,
  formatModelRef,
  isTauriRuntime,
  lastUserModelFromMessages,
  modelEquals,
  parseModelRef,
  safeStringify,
} from "../utils";
import { compareProviders, providerPriorityRank } from "../utils/providers";
import type { PromptFocusReturnTarget } from "../context/provider-auth-store";

type ModelPickerTarget = "session" | "default";

type OpenworkConfigCapabilities = {
  config?: {
    read?: boolean;
    write?: boolean;
  } | null;
} | null;

type WorkspaceDisplay = {
  workspaceType: string;
};

type UseModelPreferencesOptions = {
  selectedSessionId: Accessor<string | null>;
  messages: Accessor<MessageWithParts[]>;
  providers: Accessor<ProviderListItem[]>;
  providerDefaults: Accessor<Record<string, string>>;
  providerConnectedIds: Accessor<string[]>;
  client: Accessor<Client | null>;
  selectedWorkspaceId: Accessor<string>;
  selectedWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  selectedWorkspacePath: Accessor<string>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerStatus: Accessor<string>;
  openworkServerCapabilities: Accessor<OpenworkConfigCapabilities>;
  runtimeWorkspaceId: Accessor<string | null>;
  markOpencodeConfigReloadRequired: () => void;
  focusSessionPromptSoon: () => void;
  setError: (value: string | null) => void;
};

const ensureRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const sessionModelOverridesKey = (workspaceId: string) => `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;

const parseSessionModelOverrides = (raw: string | null) => {
  if (!raw) return {} as Record<string, ModelRef>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, ModelRef>;
    }
    const next: Record<string, ModelRef> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const model = parseModelRef(value);
        if (model) next[sessionId] = model;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.providerID === "string" && typeof record.modelID === "string") {
        next[sessionId] = {
          providerID: record.providerID,
          modelID: record.modelID,
        };
      }
    }
    return next;
  } catch {
    return {} as Record<string, ModelRef>;
  }
};

const serializeSessionModelOverrides = (overrides: Record<string, ModelRef>) => {
  const entries = Object.entries(overrides);
  if (!entries.length) return null;
  const payload: Record<string, string> = {};
  for (const [sessionId, model] of entries) {
    payload[sessionId] = formatModelRef(model);
  }
  return JSON.stringify(payload);
};

const parseDefaultModelFromConfig = (content: string | null) => {
  if (!content) return null;
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
    return parseModelRef(rawModel);
  } catch {
    return null;
  }
};

const formatConfigWithDefaultModel = (content: string | null, model: ModelRef) => {
  let config: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = { ...parsed };
      }
    } catch {
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  config.model = formatModelRef(model);
  return `${JSON.stringify(config, null, 2)}\n`;
};

const parseAutoCompactContextFromConfig = (content: string | null) => {
  if (!content) return null;
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const compaction = parsed.compaction;
    if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
      return null;
    }
    return typeof (compaction as Record<string, unknown>).auto === "boolean"
      ? ((compaction as Record<string, unknown>).auto as boolean)
      : null;
  } catch {
    return null;
  }
};

const formatConfigWithAutoCompactContext = (content: string | null, enabled: boolean) => {
  let config: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = { ...parsed };
      }
    } catch {
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  const compaction =
    typeof config.compaction === "object" && config.compaction && !Array.isArray(config.compaction)
      ? { ...(config.compaction as Record<string, unknown>) }
      : {};

  compaction.auto = enabled;
  config.compaction = compaction;
  return `${JSON.stringify(config, null, 2)}\n`;
};

const readAutoCompactContextFromRecord = (value: unknown) => {
  const compaction = ensureRecord(ensureRecord(value).compaction);
  return typeof compaction.auto === "boolean" ? compaction.auto : null;
};

const isHeroModel = (id: string) => {
  const check = id.toLowerCase();
  if (check.includes("gpt-5")) return true;
  if (check.includes("opus-4")) return true;
  if (check.includes("claude-3-7-sonnet")) return true;
  if (check.includes("claude-3-5-sonnet")) return true;
  if (check.includes("gpt-4o") && !check.includes("mini") && !check.includes("audio")) return true;
  if (check.includes("o3-mini")) return true;
  if (check.includes("o1") && !check.includes("mini")) return true;
  if (check.includes("deepseek-r1")) return true;
  return false;
};

export function useModelPreferences(options: UseModelPreferencesOptions) {
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});
  const [pendingSessionModel, setPendingSessionModel] = createSignal<ModelRef | null>(null);
  const [sessionModelOverridesReady, setSessionModelOverridesReady] = createSignal(false);
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [pendingDefaultModelByWorkspace, setPendingDefaultModelByWorkspace] = createSignal<
    Record<string, string>
  >({});
  const [autoCompactContextReady, setAutoCompactContextReady] = createSignal(false);
  const [autoCompactContextDirty, setAutoCompactContextDirty] = createSignal(false);
  const [autoCompactContextApplied, setAutoCompactContextApplied] = createSignal(true);
  const [autoCompactContextSaving, setAutoCompactContextSaving] = createSignal(false);
  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<ModelPickerTarget>("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [modelPickerReturnFocusTarget, setModelPickerReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");
  const [autoCompactContext, setAutoCompactContext] = createSignal(true);
  const [modelVariantMap, setModelVariantMap] = createSignal<Record<string, string>>({});

  const getVariantFor = (ref: ModelRef) => modelVariantMap()[`${ref.providerID}/${ref.modelID}`] ?? null;

  const updateModelVariant = (ref: ModelRef, value: string | null) => {
    const key = `${ref.providerID}/${ref.modelID}`;
    setModelVariantMap((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = options.selectedSessionId();
    if (!id) return pendingSessionModel() ?? defaultModel();

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(options.messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const modelVariant = () => getVariantFor(selectedSessionModel());

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), options.providers()),
  );

  const findProviderModel = (ref: ModelRef) => {
    const provider = options.providers().find((entry) => entry.id === ref.providerID);
    return provider?.models?.[ref.modelID] ?? null;
  };

  const sanitizeModelVariantForRef = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) return normalizeModelBehaviorValue(value);
    return sanitizeModelBehaviorValue(ref.providerID, modelInfo, value);
  };

  const getModelBehaviorCopy = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) {
      return {
        title: "Model behavior",
        label: formatGenericBehaviorLabel(value),
        description: "Choose the model first to see provider-specific behavior controls.",
        options: [],
      };
    }
    return getModelBehaviorSummary(ref.providerID, modelInfo, value);
  };

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = options.providers();
    const defaults = options.providerDefaults();
    const currentDefault = defaultModel();

    if (!allProviders.length) {
      const behavior = getModelBehaviorCopy(DEFAULT_MODEL, getVariantFor(DEFAULT_MODEL));
      return [
        {
          providerID: DEFAULT_MODEL.providerID,
          modelID: DEFAULT_MODEL.modelID,
          title: DEFAULT_MODEL.modelID,
          description: DEFAULT_MODEL.providerID,
          footer: t("settings.model_fallback", currentLocale()),
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue: normalizeModelBehaviorValue(getVariantFor(DEFAULT_MODEL)),
          behaviorOptions: behavior.options,
          isFree: true,
          isConnected: false,
        },
      ];
    }

    const sortedProviders = allProviders.slice().sort(compareProviders);
    const next: ModelOption[] = [];

    for (const provider of sortedProviders) {
      const defaultModelID = defaults[provider.id];
      const isConnected = options.providerConnectedIds().includes(provider.id);
      const models = Object.values(provider.models ?? {}).filter((m) => m.status !== "deprecated");

      models.sort((a, b) => {
        const aFree = a.cost?.input === 0 && a.cost?.output === 0;
        const bFree = b.cost?.input === 0 && b.cost?.output === 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });

      for (const model of models) {
        const isFree = model.cost?.input === 0 && model.cost?.output === 0;
        const isDefault =
          provider.id === currentDefault.providerID && model.id === currentDefault.modelID;
        const ref = { providerID: provider.id, modelID: model.id };
        const behavior = getModelBehaviorSummary(provider.id, model, getVariantFor(ref));
        const behaviorValue = sanitizeModelBehaviorValue(provider.id, model, getVariantFor(ref));
        const footerBits: string[] = [];
        if (defaultModelID === model.id || isDefault) {
          footerBits.push(t("settings.model_default", currentLocale()));
        }
        if (model.reasoning) footerBits.push(t("settings.model_reasoning", currentLocale()));

        next.push({
          providerID: provider.id,
          modelID: model.id,
          title: model.name ?? model.id,
          description: provider.name,
          footer: footerBits.length ? footerBits.slice(0, 2).join(" · ") : undefined,
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue,
          behaviorOptions: behavior.options,
          disabled: !isConnected,
          isFree,
          isConnected,
          isRecommended: isHeroModel(model.id),
        });
      }
    }

    next.sort((a, b) => {
      if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      const providerRankDiff = providerPriorityRank(a.providerID) - providerPriorityRank(b.providerID);
      if (providerRankDiff !== 0) return providerRankDiff;
      return a.title.localeCompare(b.title);
    });

    return next;
  });

  const filteredModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const available = modelOptions();
    if (!q) return available;

    return available.filter((opt) => {
      const haystack = [
        opt.title,
        opt.description ?? "",
        opt.footer ?? "",
        opt.behaviorTitle,
        opt.behaviorLabel,
        opt.behaviorDescription,
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  const resolveCodexReasoningEffort = (modelID: string, variant: string | null) => {
    if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
    const normalized = normalizeModelBehaviorValue(variant);
    if (!normalized || normalized === "none") return undefined;
    if (normalized === "minimal") return "low";
    if (normalized === "xhigh" || normalized === "max") return "high";
    if (!["low", "medium", "high"].includes(normalized)) return undefined;
    return normalized;
  };

  const closeModelPicker = (pickerOptions?: { restorePromptFocus?: boolean }) => {
    const shouldFocusPrompt =
      pickerOptions?.restorePromptFocus ?? modelPickerReturnFocusTarget() === "composer";
    setModelPickerOpen(false);
    setModelPickerReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      options.focusSessionPromptSoon();
    }
  };

  const openSessionModelPicker = (pickerOptions?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) => {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget(pickerOptions?.returnFocusTarget ?? "composer");
    setModelPickerOpen(true);
  };

  const openDefaultModelPicker = () => {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget("none");
    setModelPickerOpen(true);
  };

  const setPendingDefaultModelForWorkspace = (workspaceId: string, model: ModelRef | null) => {
    const id = workspaceId.trim();
    if (!id) return;
    setPendingDefaultModelByWorkspace((current) => {
      const next = { ...current };
      if (model) {
        next[id] = formatModelRef(model);
      } else {
        delete next[id];
      }
      return next;
    });
  };

  const pendingDefaultModelForWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return null;
    return pendingDefaultModelByWorkspace()[id] ?? null;
  };

  const applyDefaultModelChoice = (next: ModelRef) => {
    const workspaceId = options.selectedWorkspaceId().trim();
    if (workspaceId) {
      setPendingDefaultModelForWorkspace(workspaceId, next);
    }
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    setLegacyDefaultModel(next);
  };

  const applyModelSelection = (next: ModelRef) => {
    const target = modelPickerTarget();
    const restorePromptFocus = target === "session";

    if (target === "default") {
      applyDefaultModelChoice(next);
      return;
    }

    const id = options.selectedSessionId();
    if (!id) {
      setPendingSessionModel(next);
      applyDefaultModelChoice(next);
      closeModelPicker({ restorePromptFocus });
      return;
    }

    setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
    applyDefaultModelChoice(next);
    closeModelPicker({ restorePromptFocus });
  };

  const toggleAutoCompactContext = () => {
    if (autoCompactContextSaving()) return;
    setAutoCompactContext((value) => !value);
    setAutoCompactContextDirty(true);
  };

  const canReadViaOpenworkServer = () => {
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    return (
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read
    );
  };

  const canWriteViaOpenworkServer = () => {
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    return (
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write
    );
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) return;

    setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(sessionModelOverridesKey(workspaceId));
    setSessionModelOverrideById(parseSessionModelOverrides(raw));
    setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionModelOverridesReady()) return;
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionModelOverrides(sessionModelOverrideById());
    try {
      if (payload) {
        window.localStorage.setItem(sessionModelOverridesKey(workspaceId), payload);
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(workspaceId));
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const workspace = options.selectedWorkspaceDisplay();
    const workspaceRoot = options.selectedWorkspacePath().trim();
    const activeClient = options.client();
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer = canReadViaOpenworkServer();

    let cancelled = false;

    const applyDefault = async () => {
      let configDefault: ModelRef | null = null;

      if (workspace.workspaceType === "local" && workspaceRoot) {
        if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
          try {
            const config = await openworkClient.getConfig(openworkWorkspaceId);
            const model = typeof config.opencode?.model === "string" ? config.opencode.model : null;
            configDefault = parseModelRef(model);
          } catch {
            // ignore
          }
        } else if (isTauriRuntime()) {
          try {
            const configFile = await readOpencodeConfig("project", workspaceRoot);
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = unwrap(await activeClient.config.get({ directory: workspaceRoot || undefined }));
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      const pendingModelRef = pendingDefaultModelForWorkspace(workspaceId);
      const loadedModelRef = configDefault ? formatModelRef(configDefault) : null;

      if (pendingModelRef && pendingModelRef !== loadedModelRef) {
        if (!cancelled) {
          setWorkspaceDefaultModelReady(true);
        }
        return;
      }

      if (pendingModelRef && loadedModelRef === pendingModelRef) {
        setPendingDefaultModelForWorkspace(workspaceId, null);
      }

      setDefaultModelExplicit(Boolean(configDefault));
      const nextDefault = configDefault ?? legacyDefaultModel();
      const currentDefault = untrack(defaultModel);
      if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }
      const currentLegacyDefault = untrack(legacyDefaultModel);
      if (nextDefault && !modelEquals(currentLegacyDefault, nextDefault)) {
        setLegacyDefaultModel(nextDefault);
      }

      if (!cancelled) {
        setWorkspaceDefaultModelReady(true);
      }
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = options.selectedWorkspaceDisplay();
    const workspaceId = options.selectedWorkspaceId().trim();
    if (workspace.workspaceType !== "local") return;

    const root = options.selectedWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer = canWriteViaOpenworkServer();
    let cancelled = false;

    const writeConfig = async () => {
      try {
        if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentModel =
            typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
          if (currentModel && modelEquals(currentModel, nextModel)) {
            if (workspaceId) {
              setPendingDefaultModelForWorkspace(workspaceId, null);
            }
            return;
          }

          await openworkClient.patchConfig(openworkWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          if (workspaceId) {
            setPendingDefaultModelForWorkspace(workspaceId, null);
          }
          options.markOpencodeConfigReloadRequired();
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) {
          if (workspaceId) {
            setPendingDefaultModelForWorkspace(workspaceId, null);
          }
          return;
        }

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        if (workspaceId) {
          setPendingDefaultModelForWorkspace(workspaceId, null);
        }
        options.markOpencodeConfigReloadRequired();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        options.setError(addOpencodeCacheHint(message));
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) {
      setAutoCompactContext(true);
      setAutoCompactContextApplied(true);
      setAutoCompactContextDirty(false);
      setAutoCompactContextReady(false);
      setAutoCompactContextSaving(false);
      return;
    }

    const workspace = options.selectedWorkspaceDisplay();
    const root = options.selectedWorkspacePath().trim();
    const activeClient = options.client();
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer = canReadViaOpenworkServer();

    let cancelled = false;
    setAutoCompactContextReady(false);
    setAutoCompactContextDirty(false);

    const loadAutoCompactContext = async () => {
      let nextValue = true;

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        try {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          nextValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
        } catch {
          // ignore
        }
      } else if (workspace.workspaceType === "local" && root && isTauriRuntime()) {
        try {
          const configFile = await readOpencodeConfig("project", root);
          nextValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        } catch {
          // ignore
        }
      } else if (activeClient) {
        try {
          const config = unwrap(await activeClient.config.get({ directory: root || undefined }));
          nextValue = readAutoCompactContextFromRecord(config) ?? true;
        } catch {
          // ignore
        }
      }

      if (cancelled) return;
      setAutoCompactContext(nextValue);
      setAutoCompactContextApplied(nextValue);
      setAutoCompactContextReady(true);
    };

    void loadAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!autoCompactContextReady()) return;
    if (!autoCompactContextDirty()) return;

    const nextValue = autoCompactContext();
    const appliedValue = autoCompactContextApplied();
    const workspace = options.selectedWorkspaceDisplay();
    const root = options.selectedWorkspacePath().trim();
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer = canWriteViaOpenworkServer();

    let cancelled = false;
    setAutoCompactContextSaving(true);

    const persistAutoCompactContext = async () => {
      try {
        if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
          if (currentValue !== nextValue) {
            await openworkClient.patchConfig(openworkWorkspaceId, {
              opencode: {
                compaction: {
                  auto: nextValue,
                },
              },
            });
            options.markOpencodeConfigReloadRequired();
          }
          if (cancelled) return;
          setAutoCompactContextApplied(nextValue);
          setAutoCompactContextDirty(false);
          return;
        }

        if (workspace.workspaceType !== "local" || !root || !isTauriRuntime()) {
          throw new Error(
            "Auto context compaction can only be changed for a local workspace or a writable OpenWork server workspace.",
          );
        }

        const configFile = await readOpencodeConfig("project", root);
        const currentValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        if (currentValue !== nextValue) {
          const content = formatConfigWithAutoCompactContext(configFile.content, nextValue);
          const result = await writeOpencodeConfig("project", root, content);
          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
          }
          options.markOpencodeConfigReloadRequired();
        }

        if (cancelled) return;
        setAutoCompactContextApplied(nextValue);
        setAutoCompactContextDirty(false);
      } catch (error) {
        if (cancelled) return;
        setAutoCompactContext(appliedValue);
        setAutoCompactContextDirty(false);
        const message = error instanceof Error ? error.message : safeStringify(error);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        setAutoCompactContextSaving(false);
      }
    };

    void persistAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
  });

  return {
    defaultModel,
    setDefaultModel,
    setLegacyDefaultModel,
    defaultModelExplicit,
    setDefaultModelExplicit,
    sessionModelOverrideById,
    setSessionModelOverrideById,
    sessionModelById,
    setSessionModelById,
    pendingSessionModel,
    setPendingSessionModel,
    selectedSessionModel,
    selectedSessionModelLabel,
    autoCompactContext,
    setAutoCompactContext,
    autoCompactContextSaving,
    toggleAutoCompactContext,
    modelVariantMap,
    setModelVariantMap,
    modelVariant,
    getVariantFor,
    updateModelVariant,
    setModelVariant: (value: string | null) => updateModelVariant(selectedSessionModel(), value),
    sanitizeModelVariantForRef,
    getModelBehaviorCopy,
    resolveCodexReasoningEffort,
    modelPickerOpen,
    modelOptions,
    filteredModelOptions,
    modelPickerQuery,
    setModelPickerQuery,
    modelPickerTarget,
    modelPickerCurrent,
    closeModelPicker,
    openSessionModelPicker,
    openDefaultModelPicker,
    applyModelSelection,
    setPendingDefaultModelByWorkspace,
  };
}
