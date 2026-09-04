/**
 * Who chose a coworker's AI model, and what follows from it. The person's
 * choice is never swapped behind their back; a model the app picked by itself
 * may be replaced once when it turns out not to work. The record on disk
 * (`coworker.md` `modelChosenBy`) carries the answer across relaunches; a short
 * session memory covers the moment between the app's pick and the record
 * catching up with it.
 */
import type { ModelChosenBy } from "./bridge.ts";
import type { EngineModelOption } from "./threads.ts";

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

const autoPicked = new Map<string, string>();

/** The app just chose this model for the coworker; the record follows. */
export function markAutoPicked(slug: string, modelId: string): void {
  autoPicked.set(slug, modelId);
}

/**
 * Whether the model a turn ran on is the app's own pick — and so may be
 * swapped once when it fails. True when the record says the app chose the
 * coworker's current model, or when the app picked it a moment ago in this
 * session. A record that never said who chose ("") is the person's.
 */
export function wasAutoPicked(coworker: { slug: string; model: string; modelChosenBy: ModelChosenBy }, modelId: string): boolean {
  if (!modelId) return false;
  if (autoPicked.get(coworker.slug) === modelId) return true;
  return coworker.modelChosenBy === "app" && coworker.model.trim() === modelId;
}

/** Forget the session's automatic choice once the person picks a model (or an effort) themselves. */
export function clearAutoPicked(slug: string): void {
  autoPicked.delete(slug);
}

/**
 * One plain line under the model in Coworker settings when the app chose it:
 * where the model came from, and the two things that follow — it stays until
 * the person picks one, and it is swapped once if it cannot answer.
 */
export function describeModelChoice(model: Pick<EngineModelOption, "tier">): string {
  const source = model.tier === "cloud"
    ? "from your OpenWork account"
    : model.tier === "key"
      ? "from a subscription or key on this Mac"
      : model.tier === "local-server"
        ? "from a model server on this Mac"
        : "the free model, nothing to set up";
  return `Chosen for you, ${source}. It stays until you pick one; if it can't answer, the next best takes over once.`;
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
