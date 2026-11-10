import { AUTO_ROUTER_THINKING_LEVELS, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";

/**
 * Cursor through the AI Gateway (feature `gatewayMemberApiKeys`).
 *
 * Cursor reaches other models only by overriding its OpenAI API key and base URL, and each model is
 * added by typing one string that is both its id and the name Cursor shows. A Gateway model id
 * (`gwm_…`, 84 characters) is unreadable there, so Cursor gets its own names:
 *
 *   openwork/<model name as a slug>-<last 4 characters of the model's id>[:<thinking level>]
 *   openwork/claude-opus-5.5-k3f9
 *   openwork/claude-opus-5.5-k3f9:high
 *
 * The Gateway's Cursor endpoint resolves a name against the models the key's member can use: by
 * the id ending first, then by the slug when two models share an ending. The name selects a model;
 * it never grants one.
 *
 * No relative value imports beyond this package's own modules: Den web resolves them from source.
 */

export const CURSOR_MODEL_PREFIX = "openwork/";
/** Characters of the model's id a name ends with. */
export const CURSOR_MODEL_ID_SUFFIX_LENGTH = 4;
/** Appended to the Gateway's API base URL (`…/api/v1`) for Cursor's "Override OpenAI Base URL". */
export const CURSOR_BASE_URL_PATH = "/cursor";

/** TypeID suffix alphabet (Crockford base32, lowercase). */
const ID_SUFFIX = /^[0-9a-hjkmnp-tv-z]{4,26}$/;

/** `https://gateway.example/api/v1` becomes `https://gateway.example/api/v1/cursor`. */
export function cursorBaseUrl(gatewayApiBaseUrl: string): string {
  return `${gatewayApiBaseUrl.replace(/\/+$/, "")}${CURSOR_BASE_URL_PATH}`;
}

/** "Claude Opus 5.5" becomes "claude-opus-5.5". */
export function cursorModelSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug || "model";
}

function isThinkingLevel(value: string): value is AutoRouterThinkingLevel {
  return AUTO_ROUTER_THINKING_LEVELS.some((level) => level === value);
}

/**
 * The name a person types into Cursor. `modelId` is the model's `ipm_…` id or a `gwm_…` alias of
 * it: both end with the same characters.
 */
export function cursorModelName(input: { name: string; modelId: string; thinking?: AutoRouterThinkingLevel }): string {
  const base = `${CURSOR_MODEL_PREFIX}${cursorModelSlug(input.name)}-${input.modelId.toLowerCase().slice(-CURSOR_MODEL_ID_SUFFIX_LENGTH)}`;
  return input.thinking && input.thinking !== "default" ? `${base}:${input.thinking}` : base;
}

export type ParsedCursorModelName = {
  slug: string;
  /** What the model's id must end with. */
  idSuffix: string;
  thinking: AutoRouterThinkingLevel;
};

/** Reads a typed name, forgiving case, surrounding spaces and a missing `openwork/`. */
export function parseCursorModelName(value: unknown): ParsedCursorModelName | null {
  if (typeof value !== "string") return null;
  let rest = value.trim().toLowerCase();
  if (rest.startsWith(CURSOR_MODEL_PREFIX)) rest = rest.slice(CURSOR_MODEL_PREFIX.length);
  let thinking: AutoRouterThinkingLevel = "default";
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const level = rest.slice(colon + 1);
    if (!isThinkingLevel(level)) return null;
    thinking = level;
    rest = rest.slice(0, colon);
  }
  const dash = rest.lastIndexOf("-");
  if (dash <= 0) return null;
  const slug = rest.slice(0, dash);
  const idSuffix = rest.slice(dash + 1);
  if (!ID_SUFFIX.test(idSuffix)) return null;
  return { slug, idSuffix, thinking };
}

export type CursorModelMatch<T> = { kind: "found"; model: T } | { kind: "none" } | { kind: "ambiguous" };

/**
 * Finds the one model a name means. The id ending decides; the slug only breaks a tie between
 * models that share an ending, so a name still works after its model is renamed.
 */
export function matchCursorModel<T extends { name: string; modelId: string }>(parsed: ParsedCursorModelName, models: readonly T[]): CursorModelMatch<T> {
  const byId = models.filter((model) => model.modelId.toLowerCase().endsWith(parsed.idSuffix));
  if (byId.length === 1 && byId[0]) return { kind: "found", model: byId[0] };
  if (byId.length === 0) return { kind: "none" };
  const byName = byId.filter((model) => cursorModelSlug(model.name) === parsed.slug);
  if (byName.length === 1 && byName[0]) return { kind: "found", model: byName[0] };
  return { kind: "ambiguous" };
}

/**
 * Claude Code through the AI Gateway (feature `gatewayMemberApiKeys`) uses the same names, with no
 * thinking level (Claude Code sends its own) and `[1m]` on models with a 1M token context window:
 * Claude Code assumes 200k otherwise and compacts early.
 */
export const CLAUDE_CODE_BASE_URL_PATH = "/claude-code";
export const CLAUDE_CODE_LONG_CONTEXT = 1_000_000;

/** `https://gateway.example/api/v1` becomes `https://gateway.example/api/v1/claude-code` (ANTHROPIC_BASE_URL). */
export function claudeCodeBaseUrl(gatewayApiBaseUrl: string): string {
  return `${gatewayApiBaseUrl.replace(/\/+$/, "")}${CLAUDE_CODE_BASE_URL_PATH}`;
}

export function claudeCodeModelName(input: { name: string; modelId: string; contextWindow?: number | null }): string {
  const base = cursorModelName({ name: input.name, modelId: input.modelId });
  return (input.contextWindow ?? 0) >= CLAUDE_CODE_LONG_CONTEXT ? `${base}[1m]` : base;
}

/** Reads a name Claude Code sends, dropping its `[1m]`-style context marker. */
export function parseClaudeCodeModelName(value: unknown): ParsedCursorModelName | null {
  return typeof value === "string" ? parseCursorModelName(value.replace(/\[[^\]]*\]\s*$/, "")) : null;
}
