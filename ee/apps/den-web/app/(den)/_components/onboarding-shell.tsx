"use client";

import { DitheredOnboardingShell } from "@openwork/ui/react";
import type { DitheredOnboardingShellProps } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useWebGlSupported } from "../_lib/use-webgl-supported";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const SURFACE_WIDTHS = {
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

/**
 * Same dither field as the signed-in organization picker, so activation flows
 * that continue a Den session keep that surface instead of the lighter blue
 * pre-sign-in onboarding wash.
 */
function SurfaceShell({
  children,
  state,
  width,
}: {
  children: ReactNode;
  state: string;
  width: keyof typeof SURFACE_WIDTHS;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    () => true,
  );
  const webGlSupported = useWebGlSupported();
  const shaderSpeed = reducedMotion ? 0 : 0.01;

  return (
    <div
      className="relative isolate min-h-dvh overflow-y-auto bg-[var(--dls-surface)] px-4 py-8 text-[var(--dls-text-primary)] sm:py-12"
      data-testid="join-org-root"
      data-state={state}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-[0.1]"
        data-motion={shaderSpeed === 0 ? "reduced" : "ambient"}
        data-shader-speed={shaderSpeed}
        data-testid="join-org-background"
      >
        {webGlSupported ? (
          <Dithering
            speed={shaderSpeed}
            shape="warp"
            type="2x2"
            size={20.3}
            scale={1.19}
            frame={264559.21}
            colorBack="#00000000"
            colorFront="#000000"
            style={{ width: "100%", height: "100%" }}
          />
        ) : null}
      </div>

      <main
        className={`relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full ${SURFACE_WIDTHS[width]} flex-col justify-center sm:min-h-[calc(100dvh-6rem)]`}
        data-testid="join-org-foreground"
      >
        {children}
      </main>
    </div>
  );
}

export function OnboardingShell({
  children,
  state,
  width = "compact",
  background = "onboarding",
}: {
  children: ReactNode;
  state: string;
  width?: DitheredOnboardingShellProps["width"];
  background?: "onboarding" | "surface";
}) {
  if (background === "surface") {
    return (
      <SurfaceShell state={state} width={width}>
        {children}
      </SurfaceShell>
    );
  }

  return (
    <DitheredOnboardingShell state={state} width={width}>
      {children}
    </DitheredOnboardingShell>
  );
}
