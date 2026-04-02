"use client";

import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isSamePathname } from "../_lib/client-route";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="den-stat-card grid gap-2">
      <p className="m-0 text-[14px] font-medium text-[var(--dls-text-primary)]">{title}</p>
      <p className="m-0 text-[13px] leading-[1.6] text-[var(--dls-text-secondary)]">{body}</p>
    </div>
  );
}

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="den-frame grid gap-3 p-6 md:p-7">
      <div className="grid gap-3">
        <p className="den-eyebrow">OpenWork Cloud</p>
        <h2 className="den-title-lg">{title}</h2>
        <p className="den-copy">{body}</p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--dls-accent)]" />
      </div>
    </div>
  );
}

export function AuthScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const routingRef = useRef(false);
  const { user, sessionHydrated, desktopAuthRequested, resolveUserLandingRoute } = useDenFlow();
  const hasResolvedSession = sessionHydrated && Boolean(user) && !desktopAuthRequested;

  useEffect(() => {
    if (!hasResolvedSession || routingRef.current) {
      return;
    }

    routingRef.current = true;
    void resolveUserLandingRoute()
      .then((target) => {
        if (target && !isSamePathname(pathname, target)) {
          router.replace(target);
        }
      })
      .finally(() => {
        routingRef.current = false;
      });
  }, [hasResolvedSession, pathname, resolveUserLandingRoute, router]);

  if (!sessionHydrated) {
    return (
      <section className="den-page flex w-full items-center py-4 lg:min-h-[calc(100vh-2.5rem)]">
        <LoadingPanel title="Checking your session." body="Loading your Cloud account state..." />
      </section>
    );
  }

  return (
    <section className="den-page flex w-full items-center py-4 lg:min-h-[calc(100vh-2.5rem)]">
      <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="order-2 flex flex-col gap-6 lg:order-1">
          <div className="den-frame relative min-h-[300px] overflow-hidden px-7 py-8 md:px-10 md:py-10">
            <div className="absolute inset-0 z-0">
              <Dithering
                speed={0}
                shape="warp"
                type="4x4"
                size={2.5}
                scale={1}
                frame={30214.2}
                colorBack="#00000000"
                colorFront="#FEFEFE"
                style={{ backgroundColor: "#142033", width: "100%", height: "100%" }}
              >
                <PaperMeshGradient
                  speed={0.1}
                  distortion={0.8}
                  swirl={0.1}
                  grainMixer={0}
                  grainOverlay={0}
                  frame={176868.9}
                  colors={["#0F172A", "#1E40AF", "#4C1D95", "#0F766E"]}
                  style={{ width: "100%", height: "100%" }}
                />
              </Dithering>
            </div>

            <div className="relative z-10 flex h-full flex-col justify-between gap-10">
              <div className="flex items-center gap-3">
                <img src="/openwork-logo-transparent.svg" alt="OpenWork" className="h-9 w-auto" />
                <span className="text-[13px] font-medium text-white/80">OpenWork Cloud</span>
              </div>

              <div className="grid gap-4">
                <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                  OpenWork Cloud
                </span>
                <h1 className="max-w-[12ch] text-[2.25rem] font-semibold leading-[0.95] tracking-[-0.06em] text-white md:text-[3rem]">
                  One setup, every seat.
                </h1>
                <p className="max-w-[34rem] text-[15px] leading-7 text-white/80">
                  Configure once. Your whole team gets the same tools, agents, and providers.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard
              title="Shared config"
              body="Set it up once, then push it to the org."
            />
            <FeatureCard
              title="Cloud agents"
              body="Workflows that keep running while your team is away."
            />
            <FeatureCard
              title="Your models"
              body="Bring your own provider when the team is ready."
            />
          </div>
        </div>

        <div className="order-1 lg:order-2">
          {hasResolvedSession ? (
            <LoadingPanel
              title="Redirecting to your workspace."
              body="We found your account and are sending you to the right Cloud destination now."
            />
          ) : (
            <AuthPanel />
          )}
        </div>
      </div>
    </section>
  );
}
