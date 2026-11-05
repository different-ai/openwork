import type { FeatureIntroEventType, FeatureIntroState } from "@openwork/types/den/feature-intros";
import type {
  FeatureIntro,
  FeatureIntroContext,
  FeatureIntroCta,
  FeatureIntroKey,
  FeatureIntroMatch,
  FeatureIntroSetupState,
} from "./types";

/** Dots clear and dismissed banners stay hidden for 30 days (DESIGN.md I9). */
export const FEATURE_INTRO_QUIET_MS = 30 * 24 * 60 * 60 * 1000;
/** Visiting the same page again within this window does not record another "seen". */
export const FEATURE_INTRO_SEEN_THROTTLE_MS = 60 * 60 * 1000;

export type FeatureIntroSize = "fullscreen" | "box" | "banner";
export type FeatureIntroKnownSetup = FeatureIntroSetupState | "unknown";

type SearchParamsLike = { get(name: string): string | null };

function pathSegments(path: string): string[] {
  return path.split("?")[0].split("/").filter(Boolean);
}

export function introPathMatches(pattern: string, pathname: string): boolean {
  const expected = pathSegments(pattern);
  const actual = pathSegments(pathname);
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment.startsWith(":") || segment === actual[index]);
}

function tabMatches(match: FeatureIntroMatch, search: SearchParamsLike | null): boolean {
  if (match.tab === undefined) return true;
  return search?.get(match.tabParam ?? "tab") === match.tab;
}

function literalSegments(pattern: string): number {
  return pathSegments(pattern).filter((segment) => !segment.startsWith(":")).length;
}

/**
 * Most specific first: a literal path beats a `:param` one (`/connectors/new`
 * over `/connectors/:id`), then an intro matching path + tab beats one
 * matching the path alone. Returns null when no intro covers the page.
 */
export function matchFeatureIntro<I extends { match: FeatureIntroMatch }>(
  intros: readonly I[],
  pathname: string,
  search: SearchParamsLike | null,
): I | null {
  const matching = intros.filter((intro) => introPathMatches(intro.match.path, pathname));
  const mostLiteral = Math.max(0, ...matching.map((intro) => literalSegments(intro.match.path)));
  const onPath = matching.filter((intro) => literalSegments(intro.match.path) === mostLiteral);
  return onPath.find((intro) => intro.match.tab !== undefined && tabMatches(intro.match, search))
    ?? onPath.find((intro) => intro.match.tab === undefined)
    ?? null;
}

/** Depth of a key: "ai-gateway" 0, "ai-gateway.limits" 1. Used to pick the most specific intro. */
export function introKeyDepth(key: FeatureIntroKey): number {
  return key.split(".").length - 1;
}

export function rootIntroKey(key: FeatureIntroKey): string {
  return key.split(".")[0];
}

/** The member's state for this registry version; an older version counts as never seen. */
export function introStateFor(
  states: readonly FeatureIntroState[],
  key: FeatureIntroKey,
  version: number,
): FeatureIntroState | null {
  const row = states.find((state) => state.introKey === key);
  return row && row.introVersion >= version ? row : null;
}

function within(iso: string | null, now: number, windowMs: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at < windowMs;
}

/**
 * Quiet unseen dot (I9): `!setUp && (lastSeenAt == null || now - lastSeenAt > 30d)`.
 * When the page hasn't reported its setup yet, only a never-viewed intro shows one.
 */
export function introDotVisible(setup: FeatureIntroKnownSetup, state: FeatureIntroState | null, now: number): boolean {
  if (setup === "done") return false;
  if (setup === "unknown") return !state?.lastSeenAt;
  return !within(state?.lastSeenAt ?? null, now, FEATURE_INTRO_QUIET_MS);
}

export function introBannerDismissed(state: FeatureIntroState | null, now: number): boolean {
  return within(state?.dismissedAt ?? null, now, FEATURE_INTRO_QUIET_MS);
}

export function shouldRecordSeen(state: FeatureIntroState | null, now: number): boolean {
  return !within(state?.lastSeenAt ?? null, now, FEATURE_INTRO_SEEN_THROTTLE_MS);
}

export type FeatureIntroSizeChoice = { size: FeatureIntroSize; target: "self" | "parent" } | null;

/**
 * Size follows setup state (I2):
 * - section (parent) not set up → full screen of the section intro, in place of the page;
 * - this intro not set up → full screen for a section, box for a tab or sub-page;
 * - partly set up → banner above the content;
 * - set up → nothing.
 */
export function selectIntroSize(input: {
  state: FeatureIntroSetupState;
  parentState: FeatureIntroSetupState | null;
}): FeatureIntroSizeChoice {
  if (input.parentState === "none") return { size: "fullscreen", target: "parent" };
  if (input.state === "none") return { size: input.parentState === null ? "fullscreen" : "box", target: "self" };
  if (input.state === "partial") return { size: "banner", target: "self" };
  return null;
}

export function pickIntroCta(intro: FeatureIntro, ctx: FeatureIntroContext): FeatureIntroCta | null {
  return intro.ctas.find((cta) => cta.when(ctx)) ?? null;
}

/** Optimistic local copy of what the server records for one event. */
export function applyIntroEvent(
  states: readonly FeatureIntroState[],
  event: { introKey: FeatureIntroKey; introVersion: number; type: FeatureIntroEventType },
  nowIso: string,
): FeatureIntroState[] {
  const existing = states.find((state) => state.introKey === event.introKey);
  const base: FeatureIntroState = existing && existing.introVersion === event.introVersion
    ? existing
    : { introKey: event.introKey, introVersion: event.introVersion, firstSeenAt: null, lastSeenAt: null, dismissedAt: null, ctaClickedAt: null };
  const next: FeatureIntroState = event.type === "seen"
    ? { ...base, firstSeenAt: base.firstSeenAt ?? nowIso, lastSeenAt: nowIso }
    : event.type === "dismissed"
      ? { ...base, dismissedAt: nowIso }
      : { ...base, ctaClickedAt: nowIso };
  return [...states.filter((state) => state.introKey !== event.introKey), next];
}
