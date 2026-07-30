"use client";

import { Dithering } from "@paper-design/shaders-react";
import { useSyncExternalStore, type ReactNode } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const widthClasses = {
  compact: "max-w-md",
  wide: "max-w-3xl",
  full: "max-w-5xl",
} as const;

function subscribeToReducedMotion(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getReducedMotionSnapshot() {
  return typeof window === "undefined"
    ? true
    : window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export type DitheredOnboardingShellProps = {
  children: ReactNode;
  state: string;
  width?: keyof typeof widthClasses;
  rootTestId?: string;
  backgroundTestId?: string;
  foregroundTestId?: string;
};

/**
 * Shared Den/desktop onboarding surface. Keep the fixed seed and palette in
 * one place so the enterprise activation gate is visually identical to the
 * pixel-dither onboarding experience that hands control to it.
 */
export function DitheredOnboardingShell({
  children,
  state,
  width = "compact",
  rootTestId = "join-org-root",
  backgroundTestId = "join-org-background",
  foregroundTestId = "join-org-foreground",
}: DitheredOnboardingShellProps) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    () => true,
  );
  const shaderSpeed = reducedMotion ? 0 : 0.012;

  return (
    <div
      className="relative isolate min-h-dvh overflow-y-auto bg-[#f8fbff] px-4 py-8 text-slate-950 sm:py-12"
      data-testid={rootTestId}
      data-state={state}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#f8fbff] opacity-[0.09]"
        data-motion={shaderSpeed === 0 ? "reduced" : "ambient"}
        data-shader-speed={shaderSpeed}
        data-testid={backgroundTestId}
      >
        <Dithering
          speed={shaderSpeed}
          shape="warp"
          type="4x4"
          size={2.4}
          scale={0.9}
          frame={24017.6}
          colorBack="#F8FBFF"
          colorFront="#8FB7E8"
          style={{ backgroundColor: "#F8FBFF", width: "100%", height: "100%" }}
        />
      </div>

      <main
        className={`relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full ${widthClasses[width]} flex-col justify-center sm:min-h-[calc(100dvh-6rem)]`}
        data-testid={foregroundTestId}
      >
        {children}
      </main>
    </div>
  );
}
