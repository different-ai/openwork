"use client";

import { DitheredOnboardingShell } from "@micx/ui/react";
import type { DitheredOnboardingShellProps } from "@micx/ui/react";
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
