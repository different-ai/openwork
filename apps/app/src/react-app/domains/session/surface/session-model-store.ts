// Per-conversation model memory. Each session can pick its own model (and
// reasoning variant) from the composer; the choice is remembered in
// localStorage so returning to a conversation restores the model it last
// used. Sessions without a remembered choice fall back to the global
// default model preference.
import { useMemo } from "react";
import { create } from "zustand";

import { formatGenericBehaviorLabel, getModelBehaviorSummary } from "@/app/lib/model-behavior";
import type { ModelRef } from "@/app/types";

type BehaviorOption = { value: string | null; label: string };
import { resolveModelDisplayName } from "@/app/utils";
import type { ProviderCatalog } from "./use-model-behavior";

export type SessionModelSelection = {
  model: ModelRef;
  variant: string | null;
};

const STORAGE_KEY = "openwork.sessionModels.v1";
const MAX_REMEMBERED_SESSIONS = 200;

function readStoredSelections(): Record<string, SessionModelSelection> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, SessionModelSelection> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const model: unknown = Reflect.get(value, "model");
      const variant: unknown = Reflect.get(value, "variant");
      if (!model || typeof model !== "object") continue;
      const providerID: unknown = Reflect.get(model, "providerID");
      const modelID: unknown = Reflect.get(model, "modelID");
      if (typeof providerID !== "string" || typeof modelID !== "string" || !providerID || !modelID) continue;
      entries[sessionId] = {
        model: { providerID, modelID },
        variant: typeof variant === "string" ? variant : null,
      };
    }
    return entries;
  } catch {
    return {};
  }
}

function writeStoredSelections(bySessionId: Record<string, SessionModelSelection>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bySessionId));
  } catch {
    // Ignore storage failures.
  }
}

/** Keep the newest entries (object insertion order) under the cap. */
function capSelections(bySessionId: Record<string, SessionModelSelection>) {
  const keys = Object.keys(bySessionId);
  if (keys.length <= MAX_REMEMBERED_SESSIONS) return bySessionId;
  const trimmed: Record<string, SessionModelSelection> = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED_SESSIONS)) {
    trimmed[key] = bySessionId[key];
  }
  return trimmed;
}

type SessionModelStore = {
  bySessionId: Record<string, SessionModelSelection>;
  /** Remember a session's model. No-op when the model is unchanged. */
  setModel: (sessionId: string, model: ModelRef, variant?: string | null) => void;
  setVariant: (sessionId: string, variant: string | null) => void;
};

export const useSessionModelStore = create<SessionModelStore>((set) => ({
  bySessionId: readStoredSelections(),
  setModel: (sessionId, model, variant = null) => set((state) => {
    const previous = state.bySessionId[sessionId];
    const sameModel = previous
      && previous.model.providerID === model.providerID
      && previous.model.modelID === model.modelID;
    if (sameModel) return state;
    const { [sessionId]: _replaced, ...rest } = state.bySessionId;
    const bySessionId = capSelections({ ...rest, [sessionId]: { model, variant } });
    writeStoredSelections(bySessionId);
    return { bySessionId };
  }),
  setVariant: (sessionId, variant) => set((state) => {
    const previous = state.bySessionId[sessionId];
    if (!previous || previous.variant === variant) return state;
    const bySessionId = { ...state.bySessionId, [sessionId]: { ...previous, variant } };
    writeStoredSelections(bySessionId);
    return { bySessionId };
  }),
}));

export function getSessionModelSelection(sessionId: string): SessionModelSelection | null {
  return useSessionModelStore.getState().bySessionId[sessionId] ?? null;
}

export type UseSessionModelSelectionInput = {
  sessionId: string;
  /** Global default model (route prefs) used when the session has no memory. */
  fallbackModel: ModelRef;
  fallbackModelLabel: string;
  fallbackVariant: string | null;
  fallbackVariantLabel: string;
  fallbackBehaviorOptions?: BehaviorOption[];
  providerCatalog?: ProviderCatalog;
  onFallbackVariantChange: (value: string | null) => void;
};

export type SessionModelControls = {
  selectedModel: ModelRef;
  modelLabel: string;
  modelVariant: string | null;
  modelVariantLabel: string;
  modelBehaviorOptions: BehaviorOption[] | undefined;
  hasSessionOverride: boolean;
  setModel: (model: ModelRef) => void;
  setVariant: (value: string | null) => void;
};

/**
 * Resolves the model controls for one session surface: the session's own
 * remembered model when present, otherwise the global default. Writing
 * always targets the session so split panes never control each other.
 */
export function useSessionModelSelection(input: UseSessionModelSelectionInput): SessionModelControls {
  const {
    sessionId,
    fallbackModel,
    fallbackModelLabel,
    fallbackVariant,
    fallbackVariantLabel,
    fallbackBehaviorOptions,
    providerCatalog,
    onFallbackVariantChange,
  } = input;
  const selection = useSessionModelStore((state) => state.bySessionId[sessionId] ?? null);

  return useMemo(() => {
    const setModel = (model: ModelRef) => useSessionModelStore.getState().setModel(sessionId, model);
    if (!selection) {
      return {
        selectedModel: fallbackModel,
        modelLabel: fallbackModelLabel,
        modelVariant: fallbackVariant,
        modelVariantLabel: fallbackVariantLabel,
        modelBehaviorOptions: fallbackBehaviorOptions,
        hasSessionOverride: false,
        setModel,
        setVariant: onFallbackVariantChange,
      };
    }
    const providerModel = providerCatalog?.[selection.model.providerID]?.[selection.model.modelID];
    const summary = providerModel
      ? getModelBehaviorSummary(selection.model.providerID, providerModel, selection.variant)
      : null;
    return {
      selectedModel: selection.model,
      modelLabel: providerModel?.name || resolveModelDisplayName(selection.model.modelID),
      modelVariant: summary ? summary.value : selection.variant,
      modelVariantLabel: summary?.label ?? formatGenericBehaviorLabel(selection.variant),
      modelBehaviorOptions: summary?.options ?? [],
      hasSessionOverride: true,
      setModel,
      setVariant: (value: string | null) => useSessionModelStore.getState().setVariant(sessionId, value),
    };
  }, [
    fallbackBehaviorOptions,
    fallbackModel,
    fallbackModelLabel,
    fallbackVariant,
    fallbackVariantLabel,
    onFallbackVariantChange,
    providerCatalog,
    selection,
    sessionId,
  ]);
}
