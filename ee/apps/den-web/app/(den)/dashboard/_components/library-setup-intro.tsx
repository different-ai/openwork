"use client";

import { useFeatureIntro, type FeatureIntroKey } from "../_features/feature-intros";

export function LibrarySetupIntro({ introKey }: { introKey: Extract<FeatureIntroKey, "library.connectors.add" | "library.share" | "library.models.key"> }) {
  useFeatureIntro(introKey, null);
  return null;
}
