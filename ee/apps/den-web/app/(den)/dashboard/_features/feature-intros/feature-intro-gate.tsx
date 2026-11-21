"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
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
  size: FeatureIntroSize | null;
  intro: FeatureIntro | null;
  element: ReactNode;
};

const nothing: FeatureIntroResolution = { size: null, intro: null, element: null };

export function useFeatureIntro(key: FeatureIntroKey, facts: FeatureIntroFacts | null | undefined): FeatureIntroResolution {
  const runtime = useFeatureIntroRuntime();
  const { enabled, loaded, reportFacts, registerActive, record, stateFor, contextFor } = runtime;
  const intro = enabled ? getFeatureIntro(key) : null;
  const ready = Boolean(intro) && facts !== null && facts !== undefined;
  const factsSignature = facts ? JSON.stringify(facts) : null;
  const recorded = useRef(new Set<FeatureIntroKey>());
  const reporter = useId();

  useEffect(() => {
    if (!intro) return;
    return registerActive(key);
  }, [intro, key, registerActive]);

  useEffect(() => {
    if (!ready || !facts) return;
    return reportFacts(reporter, key, facts);
  }, [ready, reporter, key, factsSignature, reportFacts]);

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

export function FeatureIntroGate({
  introKey,
  facts,
  children,
}: {
  introKey: FeatureIntroKey;
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

export function useFeatureIntroUnseen(): (key: FeatureIntroKey | null | undefined) => boolean {
  const { enabled, loaded, setupFor, stateFor } = useFeatureIntroRuntime();
  return (key) => Boolean(key && enabled && loaded && getFeatureIntro(key) && introDotVisible(setupFor(key), stateFor(key), Date.now()));
}

export function useFeatureIntroDot(key: FeatureIntroKey | null): boolean {
  const { enabled, loaded, setupFor, stateFor } = useFeatureIntroRuntime();
  if (!key || !enabled || !loaded || !getFeatureIntro(key)) return false;
  return introDotVisible(setupFor(key), stateFor(key), Date.now());
}
