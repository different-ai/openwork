import { useEffect, useRef } from "react";
import type { RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { LocalModeScreen } from "@/ui/local-mode";
import { OnboardingWelcome } from "@/ui/onboarding";

export function OnboardingReplay({ step, onStep, onExit, runtime, session }: {
  step: "welcome" | "ai";
  onStep: (step: "welcome" | "ai") => void;
  onExit: () => void;
  runtime: RuntimeInfo;
  session: DenSession | null;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { pageRef.current?.querySelector("h1")?.focus({ preventScroll: true }); }, [step]);

  return <div ref={pageRef} className="h-full min-w-0 flex-1 overflow-y-auto" data-testid="onboarding-replay" onKeyDownCapture={(event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onExit();
  }}>
    {step === "welcome"
      ? <OnboardingWelcome replay onExit={onExit} onContinueLocally={() => onStep("ai")} />
      : <LocalModeScreen replay runtime={runtime} session={session} onBack={() => onStep("welcome")} onContinue={onExit} />}
  </div>;
}
