import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  DEFAULT_MODEL,
  MODEL_PREF_KEY,
  SESSION_MODEL_PREF_KEY,
  VARIANT_PREF_KEY,
} from "../../app/constants";
import type { ModelRef } from "../../app/types";
import {
  formatModelRef,
  parseModelRef,
} from "../../app/utils";
import { normalizeModelBehaviorValue } from "../../app/lib/model-behavior";

export const storedDefaultModelChangedEvent = "openwork.defaultModelChanged";
export const workspaceDefaultModelChangedEvent = "openwork.workspaceDefaultModelChanged";

export type WorkspaceModelScope = { profileId: string; runtime: string; workspaceId: string };
export type WorkspaceDefaultModel = { model: ModelRef; variant: string | null };

export function workspaceModelScope(input: {
  profileId: string | null;
  workspaceId: string;
  opencodeBaseUrl: string;
  localRuntime: boolean;
}): WorkspaceModelScope | null {
  if (!input.profileId?.trim() || !input.workspaceId.trim() || !input.opencodeBaseUrl.trim()) return null;
  try {
    const url = new URL(input.opencodeBaseUrl);
    const local = input.localRuntime && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return { profileId: input.profileId, workspaceId: input.workspaceId,
      runtime: `${local ? "desktop:" : url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/opencode2?$/, "")}` };
  } catch { return null; }
}

export function workspaceDefaultModelKey(scope: WorkspaceModelScope | null): string | null {
  return scope?.profileId && scope.runtime && scope.workspaceId
    ? `openwork.workspaceDefaultModel.v1.${JSON.stringify([scope.profileId, scope.runtime, scope.workspaceId])}` : null;
}

function readWorkspaceDefaultRaw(key: string | null) {
  try { return key && typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; }
}

function parseWorkspaceDefault(raw: string | null): WorkspaceDefaultModel | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || !("model" in value)) return null;
    const model = parseStoredModel(value.model);
    if (!model?.providerID || !model.modelID) return null;
    const variant = "variant" in value && typeof value.variant === "string" ? normalizeModelBehaviorValue(value.variant) : null;
    return { model, variant };
  } catch { return null; }
}

export function readWorkspaceDefaultModel(scope: WorkspaceModelScope | null): WorkspaceDefaultModel | null {
  return parseWorkspaceDefault(readWorkspaceDefaultRaw(workspaceDefaultModelKey(scope)));
}

export function setWorkspaceDefaultModel(scope: WorkspaceModelScope | null, model: ModelRef, variant: string | null = null): boolean {
  const key = workspaceDefaultModelKey(scope);
  if (!key || !model.providerID || !model.modelID || typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify({ model: { providerID: model.providerID, modelID: model.modelID }, variant }));
    window.dispatchEvent(new Event(workspaceDefaultModelChangedEvent));
    return true;
  } catch { return false; }
}

function subscribeWorkspaceDefault(listener: () => void) {
  window.addEventListener(workspaceDefaultModelChangedEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(workspaceDefaultModelChangedEvent, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useWorkspaceDefaultModel(scope: WorkspaceModelScope | null) {
  const key = workspaceDefaultModelKey(scope);
  const raw = useSyncExternalStore(subscribeWorkspaceDefault, () => readWorkspaceDefaultRaw(key), () => null);
  return useMemo(() => parseWorkspaceDefault(raw), [raw]);
}

export function resolveNewTaskModel(scope: WorkspaceModelScope | null, fallback: { model: ModelRef | null; variant: string | null }) {
  return readWorkspaceDefaultModel(scope) ?? fallback;
}

export type SessionChoiceOverride = {
  model?: ModelRef | null;
  variant?: string | null;
};

export type ModelPickerTarget = "default" | "session";

const hasOwn = <K extends PropertyKey>(
  value: object,
  key: K,
): value is Record<K, unknown> =>
  Object.prototype.hasOwnProperty.call(value, key);

export function sessionModelOverridesKey(workspaceId: string): string {
  return `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;
}

export function workspaceModelVariantsKey(workspaceId: string): string {
  return `${VARIANT_PREF_KEY}.${workspaceId}`;
}

const normalizeVariantOverride = (value: unknown) => {
  if (typeof value === "string") return normalizeModelBehaviorValue(value);
  if (value == null) return null;
  return null;
};

const parseStoredModel = (value: unknown) => {
  if (typeof value === "string") return parseModelRef(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.providerID === "string" &&
    typeof record.modelID === "string"
  ) {
    return { providerID: record.providerID, modelID: record.modelID };
  }
  return null;
};

const normalizeSessionChoice = (
  value: SessionChoiceOverride | null | undefined,
): SessionChoiceOverride | null => {
  if (!value || typeof value !== "object") return null;
  const next: SessionChoiceOverride = {};
  if (value.model) next.model = value.model;
  if (hasOwn(value, "variant")) {
    next.variant = normalizeModelBehaviorValue(value.variant ?? null);
  }
  return hasOwn(next, "variant") || next.model ? next : null;
};

export function parseSessionChoiceOverrides(
  raw: string | null,
): Record<string, SessionChoiceOverride> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
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
        ...(hasOwn(record, "variant")
          ? { variant: normalizeVariantOverride(record.variant) }
          : {}),
      });
      if (choice) next[sessionId] = choice;
    }
    return next;
  } catch {
    return {};
  }
}

export function serializeSessionChoiceOverrides(
  overrides: Record<string, SessionChoiceOverride>,
): string | null {
  const entries = Object.entries(overrides).flatMap(([sessionId, choice]) => {
    const normalized = normalizeSessionChoice(choice);
    return normalized ? [[sessionId, normalized] as const] : [];
  });

  if (!entries.length) return null;

  const payload: Record<string, { model?: string; variant?: string | null }> =
    {};
  for (const [sessionId, choice] of entries) {
    const next: { model?: string; variant?: string | null } = {};
    if (choice.model) next.model = formatModelRef(choice.model);
    if (hasOwn(choice, "variant")) next.variant = choice.variant ?? null;
    payload[sessionId] = next;
  }
  return JSON.stringify(payload);
}

export function parseWorkspaceModelVariants(
  raw: string | null,
  fallbackModel: ModelRef = DEFAULT_MODEL,
): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const normalized = normalizeModelBehaviorValue(raw);
      return normalized ? { [formatModelRef(fallbackModel)]: normalized } : {};
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const normalized = normalizeVariantOverride(value);
      if (normalized) next[key] = normalized;
    }
    return next;
  } catch {
    const normalized = normalizeModelBehaviorValue(raw);
    return normalized ? { [formatModelRef(fallbackModel)]: normalized } : {};
  }
}

export function readStoredDefaultModel(): ModelRef {
  if (typeof window === "undefined") return DEFAULT_MODEL;
  try {
    const stored = window.localStorage.getItem(MODEL_PREF_KEY);
    return parseModelRef(stored) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function writeStoredDefaultModel(model: ModelRef): void {
  if (typeof window === "undefined") return;
  try {
    const value = formatModelRef(model);
    if (window.localStorage.getItem(MODEL_PREF_KEY) === value) return;
    window.localStorage.setItem(MODEL_PREF_KEY, value);
    window.dispatchEvent(new Event(storedDefaultModelChangedEvent));
  } catch {
    // ignore quota errors
  }
}

/**
 * Minimal React hook covering the default model picker state. The richer
 * session/workspace model overrides from context/model-config.ts will be
 * ported incrementally as the session and settings surfaces migrate.
 */
export function useDefaultModel(): [ModelRef, (next: ModelRef) => void] {
  const [model, setModel] = useState<ModelRef>(() => readStoredDefaultModel());

  useEffect(() => {
    writeStoredDefaultModel(model);
  }, [model]);

  const update = useCallback((next: ModelRef) => {
    setModel(next);
  }, []);

  return [model, update];
}
