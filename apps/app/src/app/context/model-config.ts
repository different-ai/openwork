import { createMemo, createSignal } from "solid-js";

import { DEFAULT_MODEL, SESSION_MODEL_PREF_KEY, VARIANT_PREF_KEY } from "../constants";
import type { ModelRef } from "../types";
import { normalizeModelBehaviorValue } from "../lib/model-behavior";
import { formatModelRef, modelEquals, parseModelRef } from "../utils";

export type SessionChoiceOverride = {
  model?: ModelRef | null;
  variant?: string | null;
};

export type SessionModelState = {
  overrides: Record<string, ModelRef>;
  resolved: Record<string, ModelRef>;
};

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

export function createModelConfigStore() {
  const [sessionChoiceOverrideById, setSessionChoiceOverrideById] = createSignal<
    Record<string, SessionChoiceOverride>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});
  const [pendingSessionChoice, setPendingSessionChoice] = createSignal<SessionChoiceOverride | null>(
    null,
  );
  const [sessionModelOverridesReady, setSessionModelOverridesReady] = createSignal(false);
  const [workspaceVariantMap, setWorkspaceVariantMap] = createSignal<Record<string, string>>({});

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
      normalizeSessionChoice({ model, ...(current && hasOwn(current, "variant") ? { variant: current.variant ?? null } : {}) }),
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
  };
}
