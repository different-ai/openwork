export type ModelPurpose = "conversation" | "thinking" | "delivery" | "facilitator";
export type ModelDefault = { model: string; modelVariant: string };
export type ModelDefaults = Record<ModelPurpose, ModelDefault>;

/** Empty choices use each role's automatic model and effort policy. */
export const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
  conversation: { model: "", modelVariant: "" },
  thinking: { model: "", modelVariant: "" },
  delivery: { model: "", modelVariant: "" },
  facilitator: { model: "", modelVariant: "" },
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Merge per-role patches without discarding other roles or exact unavailable IDs. */
export function normalizeModelDefaults(value: unknown, current: ModelDefaults = DEFAULT_MODEL_DEFAULTS): ModelDefaults {
  const source = record(value);
  const role = (purpose: ModelPurpose): ModelDefault => {
    const fields = record(source[purpose]);
    const model = typeof fields.model === "string" ? fields.model.trim() : current[purpose].model;
    const variant = typeof fields.modelVariant === "string" ? fields.modelVariant.trim() : current[purpose].modelVariant;
    return {
      model: model === "" || (model.length <= 256 && /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(model)) ? model : current[purpose].model,
      modelVariant: variant === "" || (variant.length <= 64 && /^[\x21-\x7e]+$/.test(variant)) ? variant : current[purpose].modelVariant,
    };
  };
  return { conversation: role("conversation"), thinking: role("thinking"), delivery: role("delivery"), facilitator: role("facilitator") };
}

/** Legacy personal/unknown selections remain overrides; recommendations keep inheriting. */
export function usesAppConversationDefault(coworker: { useAppModelDefaults?: boolean; model?: string; modelChosenBy?: string }): boolean {
  if (typeof coworker.useAppModelDefaults === "boolean") return coworker.useAppModelDefaults;
  return !coworker.model?.trim() || coworker.modelChosenBy === "app";
}
