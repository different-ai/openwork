import { FAST_DEFAULT_VARIANT, fastVariantId } from "@openwork/types/cloud-model-fast";
import type { ModelOption } from "@/app/types";
import { isAutoModel, modelTitle } from "./model-catalog";

/**
 * Model picker search that understands what people type:
 *
 *   "opus 5.5 openrouter"  Opus 5.5 from OpenRouter first. When OpenRouter has
 *                          none, or is not connected, the other Opus 5.5s.
 *   "ow anthrpic fast"     Claude models served by OpenWork first, then other
 *                          Anthropic ones; picked with Fast mode when the
 *                          model offers it, and without it when it does not.
 *
 * Model words must match the name (typos forgiven, versions exact). Provider
 * words rank a provider first without hiding the rest. Option words (fast,
 * high, max…) choose how the model runs and never filter the list.
 */

export type ModelSearchIntent = { fast?: true; effort?: string };

export type ModelSearchMatch = { option: ModelOption; score: number; complete: boolean; preferredProvider: boolean };

export type ModelSearchResult = {
  matches: ModelSearchMatch[];
  intent: ModelSearchIntent;
  /** The providers asked for, and whether a full match came from them. */
  provider?: { label: string; found: boolean };
  /** The words that named the model, for "No opus 5.5 on OpenRouter". */
  modelWords: string[];
};

const EFFORTS: Record<string, string> = {
  none: "none", minimal: "minimal", min: "minimal", low: "low", medium: "medium", med: "medium",
  high: "high", xhigh: "xhigh", "x-high": "xhigh", max: "max", maximum: "max",
};
const FAST_WORDS = new Set(["fast", "faster", "priority"]);

/** Providers people name in a search, so one that is not connected is still recognised. */
const KNOWN_PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", openrouter: "OpenRouter", openwork: "OpenWork",
  ollama: "Ollama", mistral: "Mistral", xai: "xAI", groq: "Groq", deepseek: "DeepSeek", bedrock: "Amazon Bedrock",
  azure: "Azure", vertex: "Google Vertex", together: "Together AI", fireworks: "Fireworks", cerebras: "Cerebras",
  perplexity: "Perplexity", lmstudio: "LM Studio", zen: "OpenCode Zen",
};
const ALIASES: Record<string, string> = { ow: "openwork", oai: "openai", or: "openrouter", aws: "bedrock", gcp: "vertex" };
/** A model family answers for its maker wherever it is served: "anthropic" finds Claude on OpenRouter. */
const FAMILIES: Record<string, readonly string[]> = {
  anthropic: ["claude"], openai: ["gpt", "o1", "o3", "o4", "codex"], google: ["gemini", "gemma"],
  mistral: ["mistral", "codestral", "devstral"], xai: ["grok"], deepseek: ["deepseek"],
};

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** Words of a name: "Claude Opus 4.5" → claude, opus, 4.5; "gpt-5.1-mini" → gpt, 5.1, mini; "gpt5" → gpt5, gpt, 5. */
export function nameWords(value: string): string[] {
  return normalize(value).split(/[\s/_:()[\],]+|-(?!\d)|(?<=[a-z])-(?=\d)/).flatMap((word) => {
    const trimmed = word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (!trimmed) return [];
    const parts = trimmed.match(/[a-z]+|\d+(?:\.\d+)*/g) ?? [];
    return parts.length > 1 ? [trimmed, ...parts] : [trimmed];
  });
}

/** Optimal string alignment distance, bounded: a swapped pair counts once ("antrhopic"). */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let older: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, older[j - 2] + 1);
      current.push(value);
    }
    if (Math.min(...current) > limit) return limit + 1;
    older = previous;
    previous = current;
  }
  return previous[b.length];
}

function isSubsequence(query: string, word: string) {
  let index = 0;
  for (const char of word) if (char === query[index]) index++;
  return index === query.length;
}

/** How well one typed word matches one word of a name; 0 when it does not. */
export function wordScore(query: string, word: string): number {
  if (query === word) return 100;
  if (/\d/.test(query)) {
    // Versions are exact: "5" finds 5 and 5.5, but "5.5" never finds 4.5 or 5.1.
    return word.startsWith(query) && (word.length === query.length || word[query.length] === ".") ? 85 : 0;
  }
  if (word.startsWith(query)) return query.length >= 2 || word.length <= 3 ? 80 : 50;
  if (query.length < 3) return 0;
  if (word.includes(query)) return 55;
  const limit = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  if (limit && editDistance(query, word, limit) <= limit) return 60;
  if (limit && word.length > query.length && editDistance(query, word.slice(0, query.length), limit) <= limit) return 50;
  if (query.length >= 4 && isSubsequence(query, word)) return 40;
  return 0;
}

function bestScore(query: string, words: Iterable<string>) {
  let best = 0;
  for (const word of words) best = Math.max(best, wordScore(query, word));
  return best;
}

type ProviderHint = { key: string; label: string; ids: Set<string>; words: Set<string> };

function providerIndex(options: readonly ModelOption[]): ProviderHint[] {
  const hints = new Map<string, ProviderHint>();
  const add = (key: string, label: string, words: readonly string[], id?: string) => {
    const hint = hints.get(key) ?? { key, label, ids: new Set<string>(), words: new Set<string>() };
    for (const word of words) hint.words.add(word);
    if (id) hint.ids.add(id);
    hints.set(key, hint);
  };
  for (const [key, label] of Object.entries(KNOWN_PROVIDERS)) add(key, label, [key, ...nameWords(label)]);
  for (const option of options) {
    const label = option.description?.trim() || option.providerID;
    const words = [...nameWords(option.providerID), ...nameWords(label)];
    // Free Auto and OpenWork Models answer to "openwork"/"ow".
    const key = isAutoModel(option) || option.providerID === "openwork" ? "openwork"
      : Object.keys(KNOWN_PROVIDERS).find((known) => words.includes(known) || normalize(KNOWN_PROVIDERS[known]) === normalize(label)) ?? normalize(label);
    add(key, KNOWN_PROVIDERS[key] ?? label, words, option.providerID);
  }
  return [...hints.values()];
}

function matchProvider(word: string, hints: readonly ProviderHint[]): ProviderHint | undefined {
  const query = ALIASES[word] ?? word;
  let best: { hint: ProviderHint; score: number } | undefined;
  for (const hint of hints) {
    let score = hint.words.has(query) ? 100 : query.length >= 4 ? bestScore(query, hint.words) : 0;
    if (score < 50) continue;
    if (hint.ids.size) score += 1; // A connected provider wins a tie.
    if (!best || score > best.score) best = { hint, score };
  }
  return best?.hint;
}

export function searchModels(options: readonly ModelOption[], query: string): ModelSearchResult {
  const typed = normalize(query).split(/[\s,]+/).map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, "")).filter(Boolean);
  const indexed = options.filter((option) => !option.disabled).map((option) => {
    const title = modelTitle(option);
    return { option, title, words: new Set([...nameWords(title), ...nameWords(option.modelID)]) };
  });
  const allWords = new Set(indexed.flatMap((entry) => [...entry.words]));
  const hints = providerIndex(indexed.map((entry) => entry.option));
  const intent: ModelSearchIntent = {};
  const modelWords: string[] = [];
  const optionalWords: string[] = [];
  const providers: ProviderHint[] = [];
  for (const word of typed) {
    if (FAST_WORDS.has(word) || EFFORTS[word]) {
      if (FAST_WORDS.has(word)) intent.fast = true;
      else intent.effort = EFFORTS[word];
      // "Qwen Max": an option word that is also in a name still ranks that name.
      if (bestScore(word, allWords) >= 80) optionalWords.push(word);
      continue;
    }
    // Provider names win ("anthropic" also appears in OpenRouter ids such as
    // anthropic/claude-…); model names ("claude", "gpt", "gemini") are not providers.
    // A near-miss ("grok" vs Groq) only counts as a provider when it names no model.
    const hint = matchProvider(word, hints);
    const exact = hint?.words.has(ALIASES[word] ?? word) ?? false;
    if (hint && (exact || bestScore(word, allWords) < 80)) { if (!providers.includes(hint)) providers.push(hint); continue; }
    modelWords.push(word);
  }

  const servedBy = (hint: ProviderHint, entry: (typeof indexed)[number]) =>
    hint.ids.has(entry.option.providerID) || entry.words.has(hint.key)
    || (FAMILIES[hint.key] ?? []).some((family) => entry.words.has(family));
  const matches: ModelSearchMatch[] = [];
  for (const entry of indexed) {
    let score = 0;
    let matched = 0;
    for (const word of modelWords) {
      const value = bestScore(word, entry.words);
      if (value > 0) matched++;
      score += value;
    }
    if (modelWords.length > 0 && matched === 0) continue;
    for (const word of optionalWords) if (bestScore(word, entry.words) >= 80) score += 15;
    const providerHits = providers.filter((hint) => servedBy(hint, entry)).length;
    // Provider words alone list that provider's models; with model words they only rank.
    if (modelWords.length === 0 && providers.length > 0 && providerHits === 0) continue;
    const complete = matched === modelWords.length;
    // A model that can honour the typed options (fast, high…) ranks above one that cannot.
    const honoured = intent.fast || intent.effort ? resolveSearchIntent(entry.option, intent).applied.length : 0;
    score += (complete ? 1_000 : matched * 100) + providerHits * 300 + honoured * 150 - entry.title.length / 100;
    matches.push({ option: entry.option, score, complete, preferredProvider: providers.length > 0 && providerHits === providers.length });
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    matches, intent, modelWords,
    ...(providers.length ? { provider: {
      label: providers.map((hint) => hint.label).join(" "),
      found: matches.some((match) => match.complete && match.preferredProvider),
    } } : {}),
  };
}

const capitalize = (value: string) => `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

/** The variant a search asks for on this model, and what the model cannot offer. */
export function resolveSearchIntent(option: Pick<ModelOption, "behaviorOptions">, intent: ModelSearchIntent): { variant?: string | null; applied: string[]; missing: string[] } {
  const values = new Set((option.behaviorOptions ?? []).map((behavior) => behavior.value));
  const applied: string[] = [];
  const missing: string[] = [];
  let effort: string | null = null;
  if (intent.effort) {
    if (values.has(intent.effort)) { effort = intent.effort; applied.push(`${capitalize(intent.effort)} effort`); }
    else missing.push(`${capitalize(intent.effort)} effort`);
  }
  if (intent.fast) {
    if (values.has(FAST_DEFAULT_VARIANT) && values.has(fastVariantId(effort))) {
      applied.unshift("Fast mode");
      return { variant: fastVariantId(effort), applied, missing };
    }
    missing.push("Fast mode");
  }
  return { ...(effort ? { variant: effort } : {}), applied, missing };
}

/** A short tag for a result row when the typed options apply to it ("Fast", "High", "Fast · High"); null when none do. */
export function searchIntentTag(option: Pick<ModelOption, "behaviorOptions">, intent: ModelSearchIntent): string | null {
  if (!intent.fast && !intent.effort) return null;
  const { applied } = resolveSearchIntent(option, intent);
  const tags = applied.map((label) => label === "Fast mode" ? "Fast" : label.replace(/ effort$/, ""));
  return tags.length ? tags.join(" · ") : null;
}

/** One line above the results: what the typed options will do, once, instead of on every row. */
export function searchIntentSummary(intent: ModelSearchIntent): string | null {
  const parts = [intent.fast ? "Fast mode" : null, intent.effort ? `${capitalize(intent.effort)} effort` : null].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} where the model offers it.` : null;
}
