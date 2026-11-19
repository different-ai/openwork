"use client";

import { useFeatureIntro, useFeatureIntroRuntime } from "../_features/feature-intros";
import { useConnectorsIntroFacts } from "./connectors-intro-facts";

/**
 * Registers the "Add a connector" intro on Manage's catalog and setup forms so
 * `?` can explain them (DESIGN.md I8). It never shows on its own (the form is
 * the setup step) and renders nothing.
 */
export function ConnectorsAddIntro() {
  const facts = useConnectorsIntroFacts(useFeatureIntroRuntime().enabled);
  useFeatureIntro("connectors.add", facts);
  return null;
}
