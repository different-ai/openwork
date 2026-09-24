/**
 * Which AI model answers, and who decided.
 *
 * Three things live here. First, who chose the coworker's model and what
 * follows: a model the person picked is never swapped behind their back; one
 * the app picked may be replaced once when it turns out not to work — the
 * record on disk (`coworker.md` `modelChosenBy`) carries the answer across
 * relaunches, and a short session memory covers the moment between the app's
 * pick and the record catching up. The person's thinking effort travels with a
 * model change only when the new model offers it. Second, the *Automatic* mode — the coworker reads each message and
 * picks the right brain for it from the connected providers: a fast model for a
 * quick exchange, the coworker's standard model for ordinary work, a reasoning
 * model for research, plans, comparisons, drafts, and code. The person's own
 * effort requests ("no need to think", "think carefully") win, but brevity or
 * speed alone never overrides substantive work. The dial still applies, and
 * assignments use the standard model; Workers resolve their purpose-specific
 * choice separately at creation. App inheritance takes precedence over the
 * retained main override: conversations use an exact app choice or the quick
 * policy, leaving heavier work to the existing Worker purpose tool.
 */
import type { ModelChosenBy } from "./bridge.ts";
import { recommendModel, type EngineModelCatalog, type EngineModelOption } from "./threads.ts";
import { DEFAULT_MODEL_DEFAULTS, usesAppConversationDefault, type ModelDefault, type ModelDefaults, type ModelPurpose } from "./model-defaults.ts";
import { chooseIndexedFallbackModel, chooseIndexedModel, chooseAutomaticRoleModel, preferredRoleModel, sameModelBoundary, MODEL_INTELLIGENCE_INDEX, type ModelSelectionDecision, type ModelSelectionOptions, type ModelSelectionPreferences } from "./model-intelligence.ts";
import { effortForTurn, effortStopOf, laneWithPreference, replyKindForLane } from "./effort.ts";
export { costsNoMoreThan } from "./model-intelligence.ts";

// ---------------------------------------------------------------------------
// Who chose the model, and the effort that travels with it

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
export function describeModelPick(model: Pick<EngineModelOption, "tier">): string {
  const source = model.tier === "cloud"
    ? "from your OpenWork account"
    : model.tier === "key"
      ? "from a subscription or key on this Mac"
      : model.tier === "local-server"
        ? "from a model server on this Mac"
        : model.tier === "free"
          ? "OpenWork's free model, no account needed"
          : "from OpenCode's catalog";
  return `Chosen for you, ${source}. It stays until you pick one; if it can't answer, a model from the same provider may take over once at the same or lower known token prices.`;
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

// ---------------------------------------------------------------------------
// Automatic mode

/** `auto`: the coworker picks a lane per message; `fixed`: one model the person chose, every time. */
export type ModelMode = "auto" | "fixed";

export const MODEL_MODES: readonly ModelMode[] = ["auto", "fixed"];

/** The mode a stored coworker record means: an explicit value wins; otherwise one model every time — Automatic is chosen in the picker. */
export function modelModeOf(record: { modelMode?: string | null; model?: string | null }): ModelMode {
  if (record.modelMode === "auto" || record.modelMode === "fixed") return record.modelMode;
  return "fixed";
}

/** How much thinking a message deserves. */
export type ModelLane = "quick" | "standard" | "deep";

export const MODEL_LANES: readonly ModelLane[] = ["quick", "standard", "deep"];

/**
 * The words each lane has: `doing` as a headline while the coworker works,
 * `done` once it has replied, `via` as the small suffix on the live row
 * ("· quick reply on GPT-5 mini") and, with "a " in front, as the rail's
 * "Working on a quick reply on GPT-5 mini".
 */
export const LANE_WORDS: Record<ModelLane, { doing: string; done: string; via: string }> = {
  quick: { doing: "Quick reply", done: "Answered quickly", via: "quick reply" },
  standard: { doing: "Replying", done: "Answered", via: "" },
  deep: { doing: "Thinking deeply", done: "Thought deeply", via: "deep think" },
};

/** Speed or brevity, not permission to skip substantive thinking. */
const QUICK_HINTS = /\b(quick(ly)?|fast|briefly|in (?:one|a) (?:line|sentence|word)|short answer|tl;?dr|just (?:tell|say|give)|yes or no|one[- ]liner)\b/i;
/** An explicit effort instruction, unlike a request for concise output. */
const LIGHT_HINTS = /\bno need to think\b/i;
/** The person asked for depth. */
const DEEP_HINTS = /\b(think (?:hard|harder|carefully|deeply|it through|about it)|carefully|thorough(?:ly)?|in depth|deep dive|deeply|rigorous(?:ly)?|comprehensive|exhaustive|step by step|double[- ]check|be (?:very )?precise|take your time|don'?t rush)\b/i;
/** The shape of substantial work, whatever the person's tone. */
const DEEP_SHAPES = /\b(research|investigate|analy[sz]e|analysis|compare|comparison|trade[- ]?offs?|pros and cons|plan|roadmap|strategy|strategi[sz]e|design|architect(?:ure)?|draft|proposal|spec(?:ification)?|report|essay|article|memo|brief|audit|debug|refactor|implement|migrate|prove|evaluate|assess|synthesi[sz]e|outline|prioriti[sz]e|estimate|forecast|model (?:the|out)|root cause|post-?mortem|due diligence)\b/i;
/** Something to do, not only to say: at least ordinary work, never the quick lane. */
const WORK_VERBS = /\b(summari[sz]e|write|draft|create|make|build|fix|find|search|look (?:up|into|at)|check|read|open|update|change|edit|rewrite|translate|schedule|remind|send|email|message|book|list|explain|describe|walk me through|generate|calculate|convert|set up|configure|install|run|test|deploy|review|watch|monitor|track|add|remove|delete|rename|move|copy|export|import|download|upload)\b/i;
/** A greeting, a thanks, an acknowledgement — one line back and nothing else. */
const CHATTER = /^(?:hi+|hey+|hello|yo|thanks?(?: you| a lot)?|thx|ty|ok(?:ay)?|k|yes|yep|yeah|no|nope|sure|great|cool|nice|perfect|got it|sounds good|makes sense|will do|good (?:morning|afternoon|evening|night)|morning|bye|see you|cheers|lol|haha)\b[\s!.,?]*(?:[a-z ]{0,24})?$/i;
const CODE_SHAPE = /```|^\s*(?:import|export|function|class|const|let|def|fn|pub|#include)\b|=>|\bstack ?trace\b|\berror:\s|\bexception\b|\bTypeError\b|\bundefined is not\b|\bnull pointer\b/im;

export const QUICK_MAX_WORDS = 14;
export const DEEP_MIN_WORDS = 120;

/**
 * Explicit thinking instructions win; otherwise complexity comes before speed
 * or brevity. Greetings and simple questions are quick, substantive or
 * many-part work is deep, and ordinary work is standard even with a short reply.
 */
export function classifyRequest(prompt: string): ModelLane {
  const text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "standard";
  if (DEEP_HINTS.test(text)) return "deep";
  if (LIGHT_HINTS.test(text)) return "quick";
  if (CODE_SHAPE.test(prompt)) return "deep";
  const words = text.split(" ").length;
  const questions = (text.match(/\?/g) ?? []).length;
  const listed = (String(prompt).match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  if (DEEP_SHAPES.test(text) || words > DEEP_MIN_WORDS || questions >= 3 || listed >= 3) return "deep";
  if (WORK_VERBS.test(text)) return "standard";
  if (CHATTER.test(text) || QUICK_HINTS.test(text)) return "quick";
  if (words <= QUICK_MAX_WORDS && questions <= 1 && !/\b(?:why|how)\b/i.test(text)) return "quick";
  return "standard";
}

/** Shared private/group choice. App inheritance is quick; explicit depth still sets effort. */
export function resolveDiscussionModel(
  catalog: Pick<EngineModelCatalog, "models">,
  coworker: { model: string; modelChosenBy?: string; useAppModelDefaults?: boolean; modelMode?: string; effortPreference?: string; modelVariant?: string; modelSelectionPreferences?: ModelSelectionPreferences },
  requestText: string,
  defaults: ModelDefaults = DEFAULT_MODEL_DEFAULTS,
): ModelSelectionDecision & { variant: string; lane: ModelLane } {
  const stop = effortStopOf(coworker.effortPreference);
  const inherited = usesAppConversationDefault(coworker);
  const selected = inherited ? defaults.conversation : coworker;
  const messageLane = inherited ? (DEEP_HINTS.test(requestText) ? "deep" : "quick") : laneWithPreference(classifyRequest(requestText), stop);
  const automatic = inherited ? !selected.model : modelModeOf(coworker) === "auto";
  const lane = inherited ? "quick" : automatic ? messageLane : "standard";
  const fixedId = selected.model;
  const fixed = automatic ? null : catalog.models.find((model) => model.id === fixedId) ?? null;
  const choice = automatic
    ? inherited
      ? chooseAutomaticRoleModel(catalog, "conversation", { standard: coworker.model || undefined, preferences: coworker.modelSelectionPreferences })
      : chooseIndexedModel(catalog, lane, { standard: coworker.model, preferences: coworker.modelSelectionPreferences })
    : { model: fixed, reason: fixed ? "Kept the exact fixed model; automatic model preferences do not apply." : "The saved AI model is unavailable. Choose another AI model or connect its provider. No replacement was selected.", indexVersion: MODEL_INTELLIGENCE_INDEX.version };
  if (!choice.model) return { ...choice, variant: "", lane };
  const fixedVariant = selected.modelVariant?.trim() ?? "";
  if (fixedVariant && !choice.model.variants.includes(fixedVariant)) {
    return { ...choice, model: null, variant: "", lane, reason: `The ${inherited ? "app conversation" : "selected"} model ${choice.model.modelLabel} no longer offers thinking effort "${fixedVariant}". Update ${inherited ? "the app model defaults" : "this coworker's effort setting"}; no different effort was selected.` };
  }
  return {
    ...choice,
    lane,
    variant: effortForTurn({ kind: replyKindForLane(messageLane), stop, fixedVariant, variants: choice.model.variants }),
  };
}

/**
 * The model for one lane. The coworker's standard model anchors the choice:
 * the standard lane is that model; the quick and deep lanes look only among
 * the same provider's models with known input and output prices no higher than
 * its own. Unknown prices keep the standard model. Every candidate can use
 * tools and is not deprecated. An explicit missing, deprecated, tool-less or
 * excluded standard returns null; only an unspecified standard is recommended.
 * Unknown metadata can retain an explicit anchor's legacy support flags, but
 * cannot qualify a substitution as tool-capable or active.
 */
export function chooseModelForLane(
  catalog: Pick<EngineModelCatalog, "models">,
  lane: ModelLane,
  options: ModelSelectionOptions = {},
): EngineModelOption | null {
  return chooseIndexedModel(catalog, lane, options).model;
}

/**
 * A replacement for an automatic pick, anchored to the original standard BEFORE
 * exclusions. Never cross providers or exceed either known token price. The
 * caller owns consent (never replace a person's fixed model) and the one-retry limit.
 */
export function chooseFallbackModel(
  catalog: Pick<EngineModelCatalog, "models">,
  lane: ModelLane,
  options: { standard: string; exclude: readonly string[]; preferences?: ModelSelectionPreferences },
): EngineModelOption | null {
  return chooseIndexedFallbackModel(catalog, lane, options).model;
}

/**
 * The lane in words. `doing`: "Quick reply on GPT-5 mini", "Thinking deeply
 * on Claude Opus 4", "Replying" (the standard lane names no model). `done`:
 * the same once the reply landed. `via`: the live row's suffix, "quick reply
 * on GPT-5 mini", empty for the standard lane. `detail`: the rail's object,
 * "a quick reply on GPT-5 mini", empty for the standard lane.
 */
export function describeModelChoice(
  lane: ModelLane,
  model: Pick<EngineModelOption, "modelLabel"> | null,
  options: { tense?: "doing" | "done" | "via" | "detail" } = {},
): string {
  const tense = options.tense ?? "doing";
  const words = LANE_WORDS[lane][tense === "detail" ? "via" : tense];
  if (!words) return "";
  const line = lane === "standard" || !model ? words : `${words} on ${model.modelLabel}`;
  return tense === "detail" ? `a ${line}` : line;
}

/** The tier of a model as a person would read it, for the Automatic row's description. */
export function describeModelTier(model: Pick<EngineModelOption, "tier">): string {
  switch (model.tier) {
    case "cloud":
      return "your OpenWork account";
    case "key":
      return "a key on this Mac";
    case "local-server":
      return "a local model server";
    case "free":
      return "OpenWork's free model";
    case "opencode":
      return "OpenCode's catalog";
  }
}

/** A one-line preview of what Automatic would do with the connected catalog, for the picker. */
export function previewAutomaticChoice(catalog: Pick<EngineModelCatalog, "models">, standard: string, preferences?: ModelSelectionPreferences): { quick: EngineModelOption | null; standard: EngineModelOption | null; deep: EngineModelOption | null } {
  return {
    quick: chooseModelForLane(catalog, "quick", { standard, preferences }),
    standard: chooseModelForLane(catalog, "standard", { standard, preferences }),
    deep: chooseModelForLane(catalog, "deep", { standard, preferences }),
  };
}

export type ModelChoicePreview =
  | { state: "ready"; model: EngineModelOption; variant: string }
  | { state: "unavailable" | "context"; detail: string };

export function describeModelPreview(preview: ModelChoicePreview | undefined): string {
  if (!preview) return "Current choice needs model context.";
  if (preview.state !== "ready") return preview.state === "context" ? preview.detail : `Currently unavailable: ${preview.detail}`;
  const effort = preview.variant ? ` · ${preview.variant[0]?.toUpperCase()}${preview.variant.slice(1)}` : "";
  return `Currently: ${preview.model.modelLabel} · ${preview.model.providerLabel}${effort}`;
}

export function resolveModelPreview(
  catalog: Pick<EngineModelCatalog, "models">,
  purpose: ModelPurpose,
  defaults: ModelDefaults,
  coworker: Parameters<typeof resolveDiscussionModel>[1] & { thinkingModel?: string; thinkingModelVariant?: string; deliveryModel?: string; deliveryModelVariant?: string } = { model: "" },
  requestText = "",
): ModelChoicePreview {
  if (purpose === "conversation") {
    const choice = resolveDiscussionModel(catalog, coworker, requestText, defaults);
    return choice.model ? { state: "ready", model: choice.model, variant: choice.variant } : { state: "unavailable", detail: choice.reason };
  }
  const field = purpose === "thinking" ? "thinkingModel" : "deliveryModel";
  const selected = purpose !== "facilitator" && coworker[field]?.trim()
    ? { model: coworker[field]?.trim() ?? "", modelVariant: coworker[`${field}Variant`] ?? "" }
    : defaults[purpose];
  if (purpose === "facilitator" && !selected.model && !preferredRoleModel(catalog, purpose)) return { state: "context", detail: "Chosen when group participants are known; group overrides take priority." };
  const nativeDefaults = catalog.models.filter((model) => model.isProviderDefault);
  const standard = coworker.model || (nativeDefaults.length === 1 ? nativeDefaults[0]?.id : undefined);
  const automatic = !selected.model && (purpose === "facilitator" || usesAppConversationDefault(coworker))
    ? chooseAutomaticRoleModel(catalog, purpose, { standard, preferences: coworker.modelSelectionPreferences })
    : null;
  const choice = selected.model
    ? { model: catalog.models.find((model) => model.id === selected.model) ?? null, reason: "The saved model is not available from a connected provider." }
    : automatic ?? chooseIndexedModel(catalog, purpose === "thinking" ? "deep" : "standard", { standard: standard || recommendModel(catalog)?.id, preferences: coworker.modelSelectionPreferences });
  const model = choice.model;
  if (!model) return { state: "unavailable", detail: choice.reason };
  if (purpose !== "facilitator" && (!(model.intelligence ? model.intelligence.tools === true : model.toolCall) || model.status === "deprecated")) return { state: "unavailable", detail: "The selected Worker model does not offer active tool support." };
  try {
    const variant = effortForTurn({ kind: purpose === "facilitator" ? "facilitator" : "worker-turn", stop: effortStopOf(coworker.effortPreference),
      fixedVariant: selected.modelVariant?.trim() || automatic?.variant || "", variants: model.variants });
    return { state: "ready", model, variant };
  } catch (error) {
    return { state: "unavailable", detail: error instanceof Error ? error.message : "The selected effort is unavailable." };
  }
}

export type OnboardingModelRecommendations = { defaults: ModelDefaults; previews: Record<ModelPurpose, ModelChoicePreview> };

export function resolveOnboardingModelDefaults(
  catalog: Pick<EngineModelCatalog, "models">,
  current: ModelDefaults = DEFAULT_MODEL_DEFAULTS,
  providerId?: string,
): OnboardingModelRecommendations {
  const scoped = { models: catalog.models.filter((model) => providerId === undefined || model.providerId === providerId) };
  const role = (purpose: ModelPurpose): { selection: ModelDefault; preview: ModelChoicePreview } => {
    const saved = { ...current[purpose] };
    if (saved.model.trim()) return { selection: saved, preview: resolveModelPreview(catalog, purpose, current) };
    const choice = chooseAutomaticRoleModel(scoped, purpose);
    const model = choice.model;
    if (!model) return { selection: saved, preview: { state: "unavailable", detail: choice.reason } };
    if (!preferredRoleModel(scoped, purpose) && scoped.models.some((candidate) => candidate.id !== model.id && candidate.tier === model.tier
      && chooseIndexedModel({ models: [candidate] }, "standard").model && !sameModelBoundary(candidate, model))) {
      return { selection: saved, preview: { state: "unavailable", detail: "Multiple connected provider or credential choices are available. Choose an explicit role model; no connection was selected automatically." } };
    }
    const selection = { ...saved, model: model.id };
    const preview = resolveModelPreview(scoped, purpose, { ...current, [purpose]: selection });
    return { selection: preview.state === "ready" ? selection : saved, preview };
  };
  const conversation = role("conversation"), thinking = role("thinking"), delivery = role("delivery"), facilitator = role("facilitator");
  return {
    defaults: { conversation: conversation.selection, thinking: thinking.selection, delivery: delivery.selection, facilitator: facilitator.selection },
    previews: { conversation: conversation.preview, thinking: thinking.preview, delivery: delivery.preview, facilitator: facilitator.preview },
  };
}
