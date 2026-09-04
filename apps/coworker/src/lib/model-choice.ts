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
 * words ("quickly", "think carefully") win over the shape of the message, and
 * background work (Workers, assignments) always uses the standard model.
 */
import type { ModelChosenBy } from "./bridge.ts";
import { recommendModel, type EngineModelCatalog, type EngineModelOption } from "./threads.ts";

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

/** The person asked for speed. */
const QUICK_HINTS = /\b(quick(ly)?|fast|briefly|in (?:one|a) (?:line|sentence|word)|short answer|tl;?dr|just (?:tell|say|give)|yes or no|one[- ]liner|no need to think)\b/i;
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
 * Which lane a message belongs in. Explicit words about speed or depth win;
 * then the shape of the ask: a greeting or a one-line question that needs no
 * work is quick, research/plans/comparisons/drafts/code and long or many-part
 * messages are deep, and anything that asks the coworker to *do* something is
 * at least standard.
 */
export function classifyRequest(prompt: string): ModelLane {
  const text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "standard";
  const deepHint = DEEP_HINTS.test(text);
  const quickHint = QUICK_HINTS.test(text);
  if (quickHint && !deepHint) return "quick";
  if (deepHint) return "deep";
  if (CODE_SHAPE.test(prompt)) return "deep";
  const words = text.split(" ").length;
  const questions = (text.match(/\?/g) ?? []).length;
  const listed = (String(prompt).match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  if (DEEP_SHAPES.test(text) || words > DEEP_MIN_WORDS || questions >= 3 || listed >= 3) return "deep";
  if (CHATTER.test(text)) return "quick";
  if (words <= QUICK_MAX_WORDS && questions <= 1 && !WORK_VERBS.test(text) && !/\b(?:why|how)\b/i.test(text)) return "quick";
  return "standard";
}

/** Names providers give their fastest models. */
const FAST_NAMES = /\b(?:mini|flash(?:-lite)?|haiku|lite|nano|fast|small|instant|turbo|8b|7b|3b|1b|micro|tiny)\b|-(?:mini|flash|haiku|lite|nano|small|fast)(?:$|[-\d])/i;
/** Names providers give their most capable or most thoughtful models. */
const DEEP_NAMES = /\b(?:opus|pro|max|ultra|large|thinking|reason(?:er|ing)?|deep|r1|o[1-9](?:-pro)?|405b|235b|120b|70b|72b)\b|-(?:pro|max|thinking|large)(?:$|[-\d])/i;

function usable(model: EngineModelOption, excluded: ReadonlySet<string>): boolean {
  return model.toolCall && model.status !== "deprecated" && !excluded.has(model.id);
}

/**
 * A lane pick never costs more than the standard model. One provider can mix
 * free and paid models (the free provider does: a free standard model beside
 * dozens of paid ones), so "same provider" alone is no promise about the bill.
 */
export function costsNoMoreThan(candidate: Pick<EngineModelOption, "cost">, standard: Pick<EngineModelOption, "cost">): boolean {
  return candidate.cost.input <= standard.cost.input && candidate.cost.output <= standard.cost.output;
}

function newestFirst(left: EngineModelOption, right: EngineModelOption): number {
  return right.releaseDate.localeCompare(left.releaseDate) || Number(right.isProviderDefault) - Number(left.isProviderDefault) || left.label.localeCompare(right.label);
}

function nameOf(model: EngineModelOption): string {
  return `${model.modelId} ${model.modelLabel}`;
}

/**
 * The model for one lane. The coworker's standard model anchors the choice:
 * the standard lane is that model; the quick and deep lanes look only among
 * the same provider's models that cost no more than it (one account, and never
 * a bigger bill than the person already accepted) and fall back to the
 * standard model when nothing better exists there. Every
 * candidate can use tools and is not deprecated. Null only when no connected
 * model can do the job at all.
 */
export function chooseModelForLane(
  catalog: Pick<EngineModelCatalog, "models">,
  lane: ModelLane,
  options: { standard?: string; exclude?: readonly string[] } = {},
): EngineModelOption | null {
  const excluded = new Set(options.exclude ?? []);
  const candidates = catalog.models.filter((model) => usable(model, excluded));
  if (candidates.length === 0) return null;
  const standard =
    candidates.find((model) => model.id === (options.standard ?? "")) ??
    recommendModel({ models: candidates });
  if (!standard || lane === "standard") return standard;

  const siblings = candidates.filter((model) => model.providerId === standard.providerId && model.id !== standard.id && costsNoMoreThan(model, standard));
  const standardIsFast = !standard.reasoning && FAST_NAMES.test(nameOf(standard));
  const standardIsDeep = standard.reasoning && DEEP_NAMES.test(nameOf(standard));

  if (lane === "quick") {
    // Already on a fast model: stay. Otherwise the newest fast, non-reasoning
    // sibling; then a non-reasoning standard model keeps itself; then any
    // non-reasoning sibling; then the standard model.
    if (standardIsFast) return standard;
    const fast = siblings.filter((model) => !model.reasoning && FAST_NAMES.test(nameOf(model))).sort(newestFirst);
    if (fast.length > 0) return fast[0] ?? standard;
    if (!standard.reasoning) return standard;
    const plain = siblings.filter((model) => !model.reasoning).sort(newestFirst);
    return plain[0] ?? standard;
  }

  // Deep: already on the most capable kind: stay. Otherwise the most capable
  // reasoning sibling by name, newest first; then a reasoning standard model
  // keeps itself; then any reasoning sibling; then the standard model.
  if (standardIsDeep) return standard;
  const reasoning = siblings.filter((model) => model.reasoning);
  const named = reasoning.filter((model) => DEEP_NAMES.test(nameOf(model))).sort(newestFirst);
  if (named.length > 0) return named[0] ?? standard;
  if (standard.reasoning) return standard;
  return reasoning.sort(newestFirst)[0] ?? standard;
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
      return "the free model";
  }
}

/** A one-line preview of what Automatic would do with the connected catalog, for the picker. */
export function previewAutomaticChoice(catalog: Pick<EngineModelCatalog, "models">, standard: string): { quick: EngineModelOption | null; standard: EngineModelOption | null; deep: EngineModelOption | null } {
  return {
    quick: chooseModelForLane(catalog, "quick", { standard }),
    standard: chooseModelForLane(catalog, "standard", { standard }),
    deep: chooseModelForLane(catalog, "deep", { standard }),
  };
}

