"use client";

import { useEffect, useRef } from "react";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { AuthScreen } from "./auth-screen";
import { OnboardingCard } from "./onboarding-card";
import { OnboardingShell } from "./onboarding-shell";

export function VerificationRecoveryScreen({ email }: { email: string }) {
  const { openVerificationStep, user } = useDenFlow();
  const restored = useRef(false);

  useEffect(() => {
    if (!email || restored.current) return;
    restored.current = true;
    openVerificationStep(email);
  }, [email, openVerificationStep]);

  if (user) return <AuthScreen />;

  return (
    <OnboardingShell state="verification">
      <OnboardingCard organization={null}>
        {email ? (
          <div className="grid gap-4">
            <p className="m-0 text-sm font-medium">{email}</p>
            <AuthPanel bare prefilledEmail={email} lockEmail hideEmailField hideLockedEmailSummary />
          </div>
        ) : (
          <p role="alert">Open the recovery link from your verification email to enter your code.</p>
        )}
      </OnboardingCard>
    </OnboardingShell>
  );
}
