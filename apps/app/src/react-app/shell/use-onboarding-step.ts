import { useCallback, useRef } from "react";
import { captureOnboardingEvent } from "../../app/lib/analytics";

type OnboardingStep = "welcome" | "signin" | "composer" | "organization" | "resources" | "attribution" | "provider";

export function useOnboardingStep(step: OnboardingStep, shown = true) {
  const visible = useRef<OnboardingStep | null>(null);
  return useCallback((node: HTMLElement | null) => {
    if (!node) return;
    if (shown && visible.current !== step) captureOnboardingEvent(`onboarding_${step}_shown`);
    visible.current = shown ? step : null;
  }, [shown, step]);
}
