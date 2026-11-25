"use client";

import { FeatureIntroBox, useFeatureIntro, useFeatureIntroRuntime } from "../_features/feature-intros";
import { pickIntroCta } from "../_features/feature-intros/model";

export function PluginSourcesIntro({ githubSources }: { githubSources: number | null }) {
  const runtime = useFeatureIntroRuntime();
  const facts = githubSources === null ? null : { githubSources };
  const { size, intro } = useFeatureIntro("plugins.sources", facts);
  const ctx = intro && facts ? runtime.contextFor(intro.key, facts) : null;
  if (!size || !intro || !ctx) return null;
  const cta = pickIntroCta(intro, ctx);
  return (
    <div className="mb-6">
      <FeatureIntroBox intro={intro} cta={cta} note={null} onCtaClick={() => runtime.record(intro.key, "cta_clicked")} />
    </div>
  );
}
