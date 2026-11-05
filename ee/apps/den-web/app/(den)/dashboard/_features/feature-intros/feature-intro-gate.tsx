"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useFeatureIntroRuntime } from "./feature-intro-provider";
import { FeatureIntroBanner, FeatureIntroBox, FeatureIntroFullscreen } from "./feature-intro-views";
import { getFeatureIntro } from "./intros";
import {
  introBannerDismissed,
  introDotVisible,
  pickIntroCta,
  selectIntroSize,
  shouldRecordSeen,
  type FeatureIntroSize,
} from "./model";
import type { FeatureIntro, FeatureIntroFacts, FeatureIntroKey } from "./types";

export type FeatureIntroResolution = {
  /** What to render; null renders the page unchanged (flag off, no intro, loading, or set up). */
  size: FeatureIntroSize | null;
  /** The intro on screen: the section's for a full screen chosen by its tab, else this one. */
  intro: FeatureIntro | null;
  element: ReactNode;
};

const nothing: FeatureIntroResolution = { size: null, intro: null, element: null };

/**
 * Resolves which intro surface a page shows (DESIGN.md I2) from facts the page
 * already loads. Pass `null` while those are still loading: nothing renders
 * until they are known, so a set-up page never flashes an intro.
 * Also records "seen" once per mount, whether or not an intro is visible.
 */
export function useFeatureIntro(key: FeatureIntroKey, facts: FeatureIntroFacts | null | undefined): FeatureIntroResolution {
  const runtime = useFeatureIntroRuntime();
  const { enabled, loaded, reportFacts, registerActive, record, stateFor, contextFor } = runtime;
  const intro = enabled ? getFeatureIntro(key) : null;
  const ready = Boolean(intro) && facts !== null && facts !== undefined;
  const factsSignature = facts ? JSON.stringify(facts) : null;
  const recorded = useRef(new Set<FeatureIntroKey>());

  useEffect(() => {
    if (!intro) return;
    return registerActive(key);
  }, [intro, key, registerActive]);

  useEffect(() => {
    if (!ready || !facts) return;
    reportFacts(key, facts);
    // factsSignature stands in for `facts` so a new object with the same values doesn't re-report.
  }, [ready, key, factsSignature, reportFacts]);

  const ctx = ready && facts ? contextFor(key, facts) : null;
  const parent = intro?.parent ? getFeatureIntro(intro.parent) : null;
  const parentCtx = parent && facts ? contextFor(parent.key, facts) : null;
  const choice = intro && ctx
    ? selectIntroSize({ state: intro.setupState(ctx), parentState: parent && parentCtx ? parent.setupState(parentCtx) : null })
    : null;
  const shown = choice?.target === "parent" ? parent : intro;
  const shownKey = shown?.key ?? null;

  useEffect(() => {
    if (!ready || !loaded) return;
    const keys = shownKey && shownKey !== key ? [key, shownKey] : [key];
    for (const seenKey of keys) {
      if (recorded.current.has(seenKey)) continue;
      recorded.current.add(seenKey);
      if (shouldRecordSeen(stateFor(seenKey), Date.now())) record(seenKey, "seen");
    }
  }, [ready, loaded, key, shownKey, stateFor, record]);

  if (!choice || !shown || !ctx) return nothing;
  if (choice.size === "banner" && (!loaded || introBannerDismissed(stateFor(shown.key), Date.now()))) return nothing;

  const shownCtx = shown === parent && parentCtx ? parentCtx : ctx;
  const cta = pickIntroCta(shown, shownCtx);
  const actions = {
    cta,
    note: cta?.note?.(shownCtx) ?? null,
    onCtaClick: () => record(shown.key, "cta_clicked"),
  };
  const element = choice.size === "fullscreen"
    ? <FeatureIntroFullscreen intro={shown} {...actions} />
    : choice.size === "box"
      ? <FeatureIntroBox intro={shown} {...actions} />
      : <FeatureIntroBanner intro={shown} {...actions} onDismiss={() => record(shown.key, "dismissed")} />;
  return { size: choice.size, intro: shown, element };
}

/**
 * Wraps a page or tab body. Full screen and box replace `children` (the empty
 * state), a banner sits above them, and set up renders `children` alone.
 * With the `featureIntros` flag off it always renders `children` unchanged.
 */
export function FeatureIntroGate({
  introKey,
  facts,
  children,
}: {
  introKey: FeatureIntroKey;
  /** Setup facts from data the page already loads; null while loading. */
  facts: FeatureIntroFacts | null | undefined;
  children: ReactNode;
}) {
  const { size, element } = useFeatureIntro(introKey, facts);
  if (size === "fullscreen" || size === "box") return <>{element}</>;
  if (size === "banner") {
    return (
      <>
        <div className="mb-6">{element}</div>
        {children}
      </>
    );
  }
  return <>{children}</>;
}

/**
 * Quiet unseen dot lookup (I9), e.g. `unseen: introUnseen("ai-gateway.limits")`
 * on a `TabItem`. Always false with the flag off.
 */
export function useFeatureIntroUnseen(): (key: FeatureIntroKey | null | undefined) => boolean {
  const { enabled, loaded, setupFor, stateFor } = useFeatureIntroRuntime();
  return (key) => Boolean(key && enabled && loaded && getFeatureIntro(key) && introDotVisible(setupFor(key), stateFor(key), Date.now()));
}

export function useFeatureIntroDot(key: FeatureIntroKey | null): boolean {
  const { enabled, loaded, setupFor, stateFor } = useFeatureIntroRuntime();
  if (!key || !enabled || !loaded || !getFeatureIntro(key)) return false;
  return introDotVisible(setupFor(key), stateFor(key), Date.now());
}
