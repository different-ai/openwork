/**
 * The thinking effort a coworker keeps when its model changes — whoever
 * changes it (the person in settings or the failure card, the app's one-time
 * fallback): the person's choice stays when the new model offers that effort,
 * and otherwise returns to the model's default. Never a value the new model
 * does not know, never silently a different one.
 */
export function carryVariant(variant: string, model: { variants: readonly string[] } | null | undefined): string {
  const wanted = variant.trim();
  return wanted && model?.variants.includes(wanted) ? wanted : "";
}

/**
 * Which coworker models the app chose by itself this session. A model the
 * person picked is never swapped behind their back; one the app picked may be
 * replaced automatically when it turns out not to work.
 */
const autoPicked = new Map<string, string>();

export function markAutoPicked(slug: string, modelId: string): void {
  autoPicked.set(slug, modelId);
}

export function wasAutoPicked(slug: string, modelId: string): boolean {
  return Boolean(modelId) && autoPicked.get(slug) === modelId;
}

/** Forget the automatic choice once the person picks a model themselves. */
export function clearAutoPicked(slug: string): void {
  autoPicked.delete(slug);
}

/**
 * The model the person chose to start with before any coworker existed (on
 * the local mode screen). The first coworker created takes it instead of the
 * automatic pick, once.
 */
let startingModel = "";

export function setStartingModel(modelId: string): void {
  startingModel = modelId.trim();
}

export function peekStartingModel(): string {
  return startingModel;
}

export function takeStartingModel(): string {
  const taken = startingModel;
  startingModel = "";
  return taken;
}
