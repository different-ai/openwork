"use client";

import { useFeatureIntro, useFeatureIntroRuntime } from "../_features/feature-intros";
import { useConnectorsIntroFacts } from "./connectors-intro-facts";

export function ConnectorsAddIntro() {
  const facts = useConnectorsIntroFacts(useFeatureIntroRuntime().enabled);
  useFeatureIntro("connectors.add", facts);
  return null;
}
