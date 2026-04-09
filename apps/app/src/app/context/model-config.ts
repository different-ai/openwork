import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import { parse } from "jsonc-parser";

import { currentLocale, t } from "../../i18n";
import { DEFAULT_MODEL, MODEL_PREF_KEY, SESSION_MODEL_PREF_KEY, VARIANT_PREF_KEY } from "../constants";
import { readOpencodeConfig, writeOpencodeConfig } from "../lib/tauri";
import {
  formatGenericBehaviorLabel,
  getModelBehaviorSummary,
  normalizeModelBehaviorValue,
  sanitizeModelBehaviorValue,
} from "../lib/model-behavior";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import type {
  Client,
  MessageWithParts,
  ModelOption,
  ModelRef,
  ProviderListItem,
  WorkspaceDisplay,
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

export type SessionChoiceOverride = {
  model?: ModelRef | null;
  variant?: string | null;
};

export type SessionModelState = {
  overrides: Record<string, ModelRef>;
  resolved: Record<string, ModelRef>;
};

export type ModelPickerTarget = "default" | "session";
export type PromptFocusReturnTarget = "none" | "composer";

const hasOwn = <K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizeVariantOverride = (value: unknown) => {
  if (typeof value === "string") return normalizeModelBehaviorValue(value);
  if (value == null) return null;
  return null;
};

const parseStoredModel = (value: unknown) => {
  if (typeof value === "string") return parseModelRef(value);
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.providerID === "string" && typeof record.modelID === "string") {
    return {
      providerID: record.providerID,
      modelID: record.modelID,
    };
  }

  return null;
};

const normalizeSessionChoice = (value: SessionChoiceOverride | null | undefined) => {
  if (!value || typeof value !== "object") return null;

  const next: SessionChoiceOverride = {};
  if (value.model) {
    next.model = value.model;
  }

  if (hasOwn(value, "variant")) {
    next.variant = normalizeModelBehaviorValue(value.variant ?? null);
  }

  return hasOwn(next, "variant") || next.model ? next : null;
};

const deriveSessionModelOverrides = (choices: Record<string, SessionChoiceOverride>) => {
  const next: Record<string, ModelRef> = {};
  for (const [sessionId, choice] of Object.entries(choices)) {
    if (choice.model) next[sessionId] = choice.model;
  }
  return next;
};

const applySessionModelState = (
  currentChoices: Record<string, SessionChoiceOverride>,
  nextState: SessionModelState,
) => {
  const nextChoices: Record<string, SessionChoiceOverride> = {};

  for (const [sessionId, choice] of Object.entries(currentChoices)) {
    if (hasOwn(choice, "variant") && !nextState.overrides[sessionId]) {
      nextChoices[sessionId] = { variant: choice.variant ?? null };
    }
  }

  for (const [sessionId, model] of Object.entries(nextState.overrides)) {
    const current = currentChoices[sessionId];
    const nextChoice = normalizeSessionChoice({
      model,
      ...(current && hasOwn(current, "variant") ? { variant: current.variant ?? null } : {}),
    });
    if (nextChoice) nextChoices[sessionId] = nextChoice;
  }

  return nextChoices;
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

const getConfigSnapshot = (content: string | null) => {
  if (!content?.trim()) return "";
  try {
    const parsed = parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const copy = { ...parsed };
      delete copy.model;
      return JSON.stringify(copy);
    }
    return content;
  } catch {
    return content;
  }
};

const ensureRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const readAutoCompactContextFromRecord = (value: unknown) => {
  const compaction = ensureRecord(ensureRecord(value).compaction);
  return typeof compaction.auto === "boolean" ? compaction.auto : null;
};

const readStoredDefaultModel = () => {
  if (typeof window === "undefined") return DEFAULT_MODEL;
  try {
    const stored = window.localStorage.getItem(MODEL_PREF_KEY);
    return parseModelRef(stored) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
};

export const sessionModelOverridesKey = (workspaceId: string) =>
  `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;

export const workspaceModelVariantsKey = (workspaceId: string) =>
  `${VARIANT_PREF_KEY}.${workspaceId}`;

export const parseSessionChoiceOverrides = (raw: string | null) => {
  if (!raw) return {} as Record<string, SessionChoiceOverride>;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, SessionChoiceOverride>;
    }

    const next: Record<string, SessionChoiceOverride> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const model = parseModelRef(value);
        if (model) next[sessionId] = { model };
        continue;
      }

      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const model = parseStoredModel(record.model ?? record);
      const choice = normalizeSessionChoice({
        ...(model ? { model } : {}),
        ...(hasOwn(record, "variant") ? { variant: normalizeVariantOverride(record.variant) } : {}),
      });

      if (choice) next[sessionId] = choice;
    }

    return next;
  } catch {
    return {} as Record<string, SessionChoiceOverride>;
  }
};

export const serializeSessionChoiceOverrides = (
  overrides: Record<string, SessionChoiceOverride>,
) => {
  const entries = Object.entries(overrides)
    .map(([sessionId, choice]) => [sessionId, normalizeSessionChoice(choice)] as const)
    .filter((entry): entry is readonly [string, SessionChoiceOverride] => Boolean(entry[1]));

  if (!entries.length) return null;

  const payload: Record<string, { model?: string; variant?: string | null }> = {};
  for (const [sessionId, choice] of entries) {
    const next: { model?: string; variant?: string | null } = {};
    if (choice.model) next.model = formatModelRef(choice.model);
    if (hasOwn(choice, "variant")) next.variant = choice.variant ?? null;
    payload[sessionId] = next;
  }

  return JSON.stringify(payload);
};

export const parseWorkspaceModelVariants = (
  raw: string | null,
  fallbackModel: ModelRef = DEFAULT_MODEL,
) => {
  if (!raw || !raw.trim()) return {} as Record<string, string>;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const normalized = normalizeModelBehaviorValue(raw);
      return normalized ? { [formatModelRef(fallbackModel)]: normalized } : {};
    }

    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeVariantOverride(value);
      if (normalized) next[key] = normalized;
    }
    return next;
  } catch {
    const normalized = normalizeModelBehaviorValue(raw);
    return normalized ? { [formatModelRef(fallbackModel)]: normalized } : {};
  }
};

export function createModelConfigStore(options: {
  client: Accessor<Client | null>;
  selectedSessionId: Accessor<string | null>;
  messages: Accessor<MessageWithParts[]>;
  providers: Accessor<ProviderListItem[]>;
  providerDefaults: Accessor<Record<string, string>>;
  providerConnectedIds: Accessor<string[]>;
  selectedWorkspaceId: Accessor<string>;
  selectedWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  selectedWorkspacePath: Accessor<string>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerStatus: Accessor<OpenworkServerStatus>;
  openworkServerCapabilities: Accessor<OpenworkServerCapabilities | null>;
  runtimeWorkspaceId: Accessor<string | null>;
  focusSessionPromptSoon: () => void;
  setError: (value: string | null) => void;
  setLastKnownConfigSnapshot: (value: string) => void;
  markOpencodeConfigReloadRequired: () => void;
}) {
  const initialDefaultModel = readStoredDefaultModel();

  const [sessionChoiceOverrideById, setSessionChoiceOverrideById] = createSignal<
    Record<string, SessionChoiceOverride>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});
  const [pendingSessionChoice, setPendingSessionChoice] = createSignal<SessionChoiceOverride | null>(
    null,
  );
  const [sessionModelOverridesReady, setSessionModelOverridesReady] = createSignal(false);
  const [workspaceVariantMap, setWorkspaceVariantMap] = createSignal<Record<string, string>>({});

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(initialDefaultModel);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(initialDefaultModel);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [pendingDefaultModelByWorkspace, setPendingDefaultModelByWorkspace] = createSignal<
    Record<string, string>
  >({});

  const [autoCompactContextReady, setAutoCompactContextReady] = createSignal(false);
  const [autoCompactContextDirty, setAutoCompactContextDirty] = createSignal(false);
  const [autoCompactContextApplied, setAutoCompactContextApplied] = createSignal(true);
  const [autoCompactContextSaving, setAutoCompactContextSaving] = createSignal(false);
  const [autoCompactContext, setAutoCompactContext] = createSignal(true);

  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<ModelPickerTarget>("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [modelPickerReturnFocusTarget, setModelPickerReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  const sessionModelState = createMemo<SessionModelState>(() => ({
    overrides: deriveSessionModelOverrides(sessionChoiceOverrideById()),
    resolved: sessionModelById(),
  }));

  const setSessionModelState = (
    updater: (current: SessionModelState) => SessionModelState,
  ) => {
    const next = updater(sessionModelState());
    setSessionChoiceOverrideById((current) => applySessionModelState(current, next));
    setSessionModelById(next.resolved);
    return next;
  };

  const setWorkspaceVariant = (ref: ModelRef, value: string | null) => {
    const key = formatModelRef(ref);
    const normalized = normalizeModelBehaviorValue(value);

    setWorkspaceVariantMap((current) => {
      const next = { ...current };
      if (normalized) next[key] = normalized;
      else delete next[key];
      return next;
    });
  };

  const setPendingSessionModel = (model: ModelRef) => {
    setPendingSessionChoice((current) =>
      normalizeSessionChoice({
        model,
        ...(current && hasOwn(current, "variant") ? { variant: current.variant ?? null } : {}),
      }),
    );
  };

  const setPendingSessionVariant = (value: string | null) => {
    setPendingSessionChoice((current) =>
      normalizeSessionChoice({
        ...(current?.model ? { model: current.model } : {}),
        variant: normalizeModelBehaviorValue(value),
      }),
    );
  };

  const clearPendingSessionChoice = () => setPendingSessionChoice(null);

  const applyPendingSessionChoice = (sessionId: string) => {
    const pending = normalizeSessionChoice(pendingSessionChoice());
    if (!pending) return;

    setSessionChoiceOverrideById((current) => {
      const existing = current[sessionId];
      const next = normalizeSessionChoice({
        ...(existing?.model ? { model: existing.model } : {}),
        ...(pending.model ? { model: pending.model } : {}),
        ...(hasOwn(existing ?? {}, "variant") ? { variant: existing?.variant ?? null } : {}),
        ...(hasOwn(pending, "variant") ? { variant: pending.variant ?? null } : {}),
      });
      if (!next) return current;
      return { ...current, [sessionId]: next };
    });

    setPendingSessionChoice(null);
  };

  const setSessionModelOverride = (sessionId: string, model: ModelRef) => {
    setSessionChoiceOverrideById((current) => {
      const existing = current[sessionId];
      const preserveVariant =
        existing?.model &&
        modelEquals(existing.model, model) &&
        hasOwn(existing, "variant")
          ? { variant: existing.variant ?? null }
          : hasOwn(existing ?? {}, "variant") && existing?.variant == null
            ? { variant: null }
            : {};

      const next = normalizeSessionChoice({ model, ...preserveVariant });
      if (!next) return current;
      return { ...current, [sessionId]: next };
    });
  };

  const clearSessionModelOverride = (sessionId: string) => {
    setSessionChoiceOverrideById((current) => {
      const existing = current[sessionId];
      if (!existing) return current;

      const next = normalizeSessionChoice(
        hasOwn(existing, "variant") ? { variant: existing.variant ?? null } : null,
      );

      const copy = { ...current };
      if (next) copy[sessionId] = next;
      else delete copy[sessionId];
      return copy;
    });
  };

  const setSessionVariantOverride = (sessionId: string, value: string | null) => {
    setSessionChoiceOverrideById((current) => {
      const existing = current[sessionId];
      const next = normalizeSessionChoice({
        ...(existing?.model ? { model: existing.model } : {}),
        variant: normalizeModelBehaviorValue(value),
      });

      if (!next) {
        const copy = { ...current };
        delete copy[sessionId];
        return copy;
      }

      return { ...current, [sessionId]: next };
    });
  };

  const getWorkspaceVariantFor = (ref: ModelRef) =>
    workspaceVariantMap()[formatModelRef(ref)] ?? null;

  const getVariantFor = (ref: ModelRef, sessionId?: string | null) => {
    if (sessionId) {
      const choice = sessionChoiceOverrideById()[sessionId];
      if (choice && hasOwn(choice, "variant")) {
        return choice.variant ?? null;
      }
    } else {
      const pending = pendingSessionChoice();
      if (pending && hasOwn(pending, "variant")) {
        return pending.variant ?? null;
      }
    }

    return getWorkspaceVariantFor(ref);
  };

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = options.selectedSessionId();
    const pendingChoice = pendingSessionChoice();
    if (!id) return pendingChoice?.model ?? defaultModel();

    const override = sessionChoiceOverrideById()[id]?.model;
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(options.messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const modelVariant = createMemo(() =>
    getVariantFor(selectedSessionModel(), options.selectedSessionId()),
  );

  const resolveCodexReasoningEffort = (modelID: string, variant: string | null) => {
    if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
    const normalized = normalizeModelBehaviorValue(variant);
    if (!normalized || normalized === "none") return undefined;
    if (normalized === "minimal") return "low";
    if (normalized === "xhigh" || normalized === "max") return "high";
    if (!["low", "medium", "high"].includes(normalized)) return undefined;
    return normalized;
  };

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
        title: t("app.model_behavior_title", currentLocale()),
        label: formatGenericBehaviorLabel(value),
        description: t("app.model_behavior_desc", currentLocale()),
        options: [],
      };
    }
    return getModelBehaviorSummary(ref.providerID, modelInfo, value);
  };

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), options.providers()),
  );

  const sessionModelVariantLabel = createMemo(
    () => getModelBehaviorCopy(selectedSessionModel(), modelVariant()).label,
  );

  const sessionModelBehaviorOptions = createMemo(
    () => getModelBehaviorCopy(selectedSessionModel(), modelVariant()).options,
  );

  const defaultModelLabel = createMemo(() => formatModelLabel(defaultModel(), options.providers()));
  const defaultModelRef = createMemo(() => formatModelRef(defaultModel()));
  const defaultModelVariantLabel = createMemo(
    () => getModelBehaviorCopy(defaultModel(), getWorkspaceVariantFor(defaultModel())).label,
  );

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  const isHeroModel = (id: string) => id.toLowerCase().includes("gpt-5");

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = options.providers();
    const defaults = options.providerDefaults();
    const currentDefault = defaultModel();

    if (!allProviders.length) {
      const behavior = getModelBehaviorCopy(DEFAULT_MODEL, getWorkspaceVariantFor(DEFAULT_MODEL));
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
          behaviorValue: normalizeModelBehaviorValue(getWorkspaceVariantFor(DEFAULT_MODEL)),
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
        const activeVariant =
          modelPickerTarget() === "session" && modelEquals(ref, selectedSessionModel())
            ? modelVariant()
            : getWorkspaceVariantFor(ref);
        const behavior = getModelBehaviorSummary(provider.id, model, activeVariant);
        const behaviorValue = sanitizeModelBehaviorValue(provider.id, model, activeVariant);
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
    const optionsList = modelOptions();
    if (!q) return optionsList;

    return optionsList.filter((opt) => {
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

  const closeModelPicker = (opts?: { restorePromptFocus?: boolean }) => {
    const shouldFocusPrompt =
      opts?.restorePromptFocus ?? modelPickerReturnFocusTarget() === "composer";
    setModelPickerOpen(false);
    setModelPickerReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      options.focusSessionPromptSoon();
    }
  };

  const openSessionModelPicker = (opts?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) => {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget(opts?.returnFocusTarget ?? "composer");
    setModelPickerOpen(true);
  };

  const openDefaultModelPicker = () => {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget("none");
    setModelPickerOpen(true);
  };

  const applyModelSelection = (next: ModelRef) => {
    const target = modelPickerTarget();
    const restorePromptFocus = target === "session";

    if (target === "default") {
      applyDefaultModelChoice(next);
      closeModelPicker({ restorePromptFocus: false });
      return;
    }

    const id = options.selectedSessionId();
    if (!id) {
      setPendingSessionModel(next);
      closeModelPicker({ restorePromptFocus });
      return;
    }

    setSessionModelOverride(id, next);
    closeModelPicker({ restorePromptFocus });
  };

  const setModelPickerBehavior = (model: ModelRef, value: string | null) => {
    const nextValue = sanitizeModelVariantForRef(model, value);
    if (modelPickerTarget() === "default") {
      setWorkspaceVariant(model, nextValue);
      return;
    }

    const sessionId = options.selectedSessionId();
    if (sessionId) {
      setSessionVariantOverride(sessionId, nextValue);
      return;
    }

    setPendingSessionVariant(nextValue);
  };

  const setSessionModelVariant = (value: string | null) => {
    const sessionId = options.selectedSessionId();
    const nextValue = sanitizeModelVariantForRef(selectedSessionModel(), value);
    if (sessionId) {
      setSessionVariantOverride(sessionId, nextValue);
      return;
    }
    setPendingSessionVariant(nextValue);
  };

  const toggleAutoCompactContext = () => {
    if (autoCompactContextSaving()) return;
    setAutoCompactContext((value) => !value);
    setAutoCompactContextDirty(true);
  };

  const resetAppDefaults = () => {
    if (typeof window !== "undefined") {
      try {
        const sessionOverridePrefix = `${SESSION_MODEL_PREF_KEY}.`;
        const workspaceVariantPrefix = `${VARIANT_PREF_KEY}.`;
        const keysToRemove: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key) continue;
          if (
            key.startsWith(sessionOverridePrefix) ||
            key.startsWith(workspaceVariantPrefix) ||
            key === VARIANT_PREF_KEY
          ) {
            keysToRemove.push(key);
          }
        }
        for (const key of keysToRemove) {
          window.localStorage.removeItem(key);
        }
      } catch {
        // ignore
      }
    }

    setDefaultModel(DEFAULT_MODEL);
    setLegacyDefaultModel(DEFAULT_MODEL);
    setDefaultModelExplicit(false);
    setWorkspaceDefaultModelReady(false);
    setPendingDefaultModelByWorkspace({});
    setAutoCompactContext(false);
    setAutoCompactContextApplied(false);
    setAutoCompactContextDirty(false);
    setAutoCompactContextReady(false);
    setAutoCompactContextSaving(false);
    clearPendingSessionChoice();
    setSessionChoiceOverrideById({});
    setSessionModelById({});
    setWorkspaceVariantMap({});
    closeModelPicker({ restorePromptFocus: false });
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) return;

    setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(sessionModelOverridesKey(workspaceId));
    setSessionChoiceOverrideById(parseSessionChoiceOverrides(raw));
    setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionModelOverridesReady()) return;
    const workspaceId = options.selectedWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionChoiceOverrides(sessionChoiceOverrideById());
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
    const workspaceId = options.selectedWorkspaceId().trim();
    if (!workspaceId) {
      setWorkspaceVariantMap({});
      return;
    }

    const scopedRaw = window.localStorage.getItem(workspaceModelVariantsKey(workspaceId));
    const legacyRaw = scopedRaw == null ? window.localStorage.getItem(VARIANT_PREF_KEY) : null;
    setWorkspaceVariantMap(parseWorkspaceModelVariants(scopedRaw ?? legacyRaw, defaultModel()));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = options.selectedWorkspaceId().trim();
    if (!workspaceId) return;

    try {
      const map = workspaceVariantMap();
      const key = workspaceModelVariantsKey(workspaceId);
      if (Object.keys(map).length > 0) {
        window.localStorage.setItem(key, JSON.stringify(map));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODEL_PREF_KEY, formatModelRef(defaultModel()));
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
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;

    const applyDefault = async () => {
      let configDefault: ModelRef | null = null;
      let configFileContent: string | null = null;

      if (workspace.workspaceType === "local" && workspaceRoot) {
        if (canUseOpenworkServer) {
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
            configFileContent = configFile.content;
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = await activeClient.config.get({ directory: workspaceRoot || undefined });
          const payload = "data" in config ? config.data : config;
          if (typeof payload?.model === "string") {
            configDefault = parseModelRef(payload.model);
          }
        } catch {
          // ignore
        }
      }

      const pendingModelRef = pendingDefaultModelForWorkspace(workspaceId);
      const loadedModelRef = configDefault ? formatModelRef(configDefault) : null;

      if (pendingModelRef && pendingModelRef !== loadedModelRef) {
        if (workspace.workspaceType === "local" && workspaceRoot) {
          options.setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
        }

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
      const currentDefault = defaultModel();
      if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }
      const currentLegacyDefault = legacyDefaultModel();
      if (nextDefault && !modelEquals(currentLegacyDefault, nextDefault)) {
        setLegacyDefaultModel(nextDefault);
      }

      if (workspace.workspaceType === "local" && workspaceRoot) {
        options.setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
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
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;
    let cancelled = false;

    const writeConfig = async () => {
      try {
        if (canUseOpenworkServer) {
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
          throw new Error(result.stderr || result.stdout || t("app.error_update_opencode_json", currentLocale()));
        }
        options.setLastKnownConfigSnapshot(getConfigSnapshot(content));
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
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;
    setAutoCompactContextReady(false);
    setAutoCompactContextDirty(false);

    const loadAutoCompactContext = async () => {
      let nextValue = true;

      if (canUseOpenworkServer) {
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
          const config = await activeClient.config.get({ directory: root || undefined });
          const payload = "data" in config ? config.data : config;
          nextValue = readAutoCompactContextFromRecord(payload) ?? true;
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
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;

    let cancelled = false;
    setAutoCompactContextSaving(true);

    const persistAutoCompactContext = async () => {
      try {
        if (canUseOpenworkServer) {
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
            t("app.error_auto_compact_scope", currentLocale()),
          );
        }

        const configFile = await readOpencodeConfig("project", root);
        const currentValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        if (currentValue !== nextValue) {
          const content = formatConfigWithAutoCompactContext(configFile.content, nextValue);
          const result = await writeOpencodeConfig("project", root, content);
          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || t("app.error_update_opencode_json", currentLocale()));
          }
          options.setLastKnownConfigSnapshot(getConfigSnapshot(content));
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
    sessionChoiceOverrideById,
    setSessionChoiceOverrideById,
    sessionModelById,
    setSessionModelById,
    sessionModelState,
    setSessionModelState,
    pendingSessionChoice,
    setPendingSessionModel,
    setPendingSessionVariant,
    clearPendingSessionChoice,
    applyPendingSessionChoice,
    sessionModelOverridesReady,
    setSessionModelOverridesReady,
    workspaceVariantMap,
    setWorkspaceVariantMap,
    setWorkspaceVariant,
    setSessionModelOverride,
    clearSessionModelOverride,
    setSessionVariantOverride,
    getWorkspaceVariantFor,
    getVariantFor,
    defaultModel,
    selectedSessionModel,
    selectedSessionModelLabel,
    defaultModelLabel,
    defaultModelRef,
    defaultModelVariantLabel,
    modelVariant,
    sessionModelVariantLabel,
    sessionModelBehaviorOptions,
    setSessionModelVariant,
    sanitizeModelVariantForRef,
    resolveCodexReasoningEffort,
    modelPickerOpen,
    modelPickerQuery,
    setModelPickerQuery,
    modelPickerTarget,
    modelPickerCurrent,
    modelOptions,
    filteredModelOptions,
    openSessionModelPicker,
    openDefaultModelPicker,
    closeModelPicker,
    applyModelSelection,
    setModelPickerBehavior,
    autoCompactContext,
    toggleAutoCompactContext,
    autoCompactContextSaving,
    resetAppDefaults,
  };
}
