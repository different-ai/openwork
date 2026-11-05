"use client";

import { useFeatureIntro, type FeatureIntroKey } from "../_features/feature-intros";

/**
 * Registers a My Library setup-step intro (add a connector, share, your own
 * key) on pages its URL match doesn't reach, so `?` can explain the form
 * (DESIGN.md I8). It never shows on its own and renders nothing. It reports
 * no facts: these pages don't load the Library, and an empty report would
 * read as "set up" for the Library's sidebar dot. With the flag off it does
 * nothing.
 */
export function LibrarySetupIntro({ introKey }: { introKey: Extract<FeatureIntroKey, "library.connectors.add" | "library.share" | "library.models.key"> }) {
  useFeatureIntro(introKey, null);
  return null;
}
