"use client";

import { DitheredOnboardingShell } from "@openwork/ui/react";
import type { DitheredOnboardingShellProps } from "@openwork/ui/react";
import type { ReactNode } from "react";

export function OnboardingShell({
  children,
  state,
  width = "compact",
}: {
  children: ReactNode;
  state: string;
  width?: DitheredOnboardingShellProps["width"];
}) {
  return (
    <DitheredOnboardingShell state={state} width={width}>
      {children}
    </DitheredOnboardingShell>
  );
}
