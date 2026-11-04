"use client";

import { FeatureIntroBox, useFeatureIntro, useFeatureIntroRuntime } from "../_features/feature-intros";
import { pickIntroCta } from "../_features/feature-intros/model";

/**
 * The Sources tab's intro while no GitHub account is connected (DESIGN.md I2).
 * Sources has no parent intro (an empty organization connects GitHub here), so
 * the hook resolves it as a section; it is drawn as a box above the provider
 * cards instead, because their Connect buttons start the GitHub install and
 * cannot be a link. Null while loading, set up, or with the flag off.
 */
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
