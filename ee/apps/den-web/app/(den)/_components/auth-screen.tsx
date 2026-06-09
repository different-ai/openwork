"use client";

import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isSamePathname } from "../_lib/client-route";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
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

function SessionStatusPanel({ mode }: { mode: "checking" | "redirecting" }) {
  const status = mode === "checking"
    ? {
        title: "Checking account",
        body: "If you are already signed in, we will open your workspace. Otherwise you can continue here.",
      }
    : {
        title: "Opening workspace",
        body: "You are signed in. We are taking you to the right Cloud destination.",
      };

  return (
    <div className="den-frame flex min-h-[420px] flex-col justify-between gap-8 p-6 md:p-7" role="status" aria-live="polite">
      <div className="grid gap-3">
        <p className="den-eyebrow">Account</p>
        <div className="rounded-[1.5rem] border border-[var(--dls-border)] bg-[var(--dls-hover)]/60 p-4">
          <div className="flex items-start gap-3">
            <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--dls-accent)] opacity-30" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--dls-accent)]" />
            </span>
            <div className="min-w-0">
              <p className="m-0 text-[14px] font-medium text-[var(--dls-text-primary)]">{status.title}</p>
              <p className="mt-1 text-[13px] leading-6 text-[var(--dls-text-secondary)]">{status.body}</p>
            </div>
          </div>
        </div>
      </div>
      <p className="m-0 text-xs leading-5 text-[var(--dls-text-secondary)]">
        No action needed.
      </p>
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

    const oauthRoute = typeof window === "undefined" ? null : getMcpOAuthSelectOrganizationRoute(window.location.search);
    if (oauthRoute && !isSamePathname(pathname, oauthRoute)) {
      router.replace(oauthRoute);
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

  return (
    <section className="den-page flex w-full items-start py-3 sm:py-4 lg:min-h-[calc(100vh-2.5rem)] lg:items-center">
      <div className="grid w-full gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="order-1 flex flex-col gap-4 sm:gap-6">
          <div className="den-frame relative min-h-[210px] overflow-hidden px-5 py-6 sm:min-h-[260px] sm:px-7 sm:py-8 md:px-10 md:py-10 lg:min-h-[300px]">
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

              <div className="grid gap-3 sm:gap-4">
                <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                  OpenWork Cloud
                </span>
                <h1 className="max-w-[13ch] text-[2rem] font-semibold leading-[0.95] tracking-[-0.06em] text-white sm:text-[2.35rem] md:text-[3rem]">
                  One setup, every seat.
                </h1>
                <p className="max-w-[34rem] text-[14px] leading-6 text-white/80 sm:text-[15px] sm:leading-7">
                  Configure once. Your whole team gets the same tools, agents, and providers.
                </p>
              </div>
            </div>
          </div>

          <div className="hidden gap-4 md:grid md:grid-cols-3">
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

        <div className="order-2">
          {!sessionHydrated ? (
            <SessionStatusPanel mode="checking" />
          ) : hasResolvedSession ? (
            <SessionStatusPanel mode="redirecting" />
          ) : (
            <AuthPanel />
          )}
        </div>
      </div>
    </section>
  );
}
