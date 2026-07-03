"use client";

import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";
import { Bot, Boxes, Share, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isSamePathname } from "../_lib/client-route";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";

function Feature({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-3.5 px-4 py-5 sm:px-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-md">
        <Icon className="h-[18px] w-[18px] text-white" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-[13px] font-medium leading-tight text-white">{title}</p>
        <p className="m-0 mt-1 text-[11.5px] leading-snug text-white/60">{body}</p>
      </div>
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
    <div className="grid gap-6" role="status" aria-live="polite">
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
      <div className="den-frame relative w-full overflow-hidden">
        <div className="grid lg:grid-cols-[2fr_1fr]">
          {/* Brand panel — hidden on mobile; form-only on small screens */}
          <div className="relative hidden min-h-[220px] overflow-hidden px-6 py-7 sm:px-8 sm:py-9 md:px-10 md:py-10 lg:block lg:min-h-[560px]">
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

            <div className="relative z-10 flex h-full flex-col">
              <div className="flex items-center gap-3">
                <img src="/openwork-logo-transparent.svg" alt="OpenWork" className="h-9 w-auto" />
                <span className="text-[13px] font-medium text-white/80">OpenWork Cloud</span>
              </div>

              {/* Spacers split the space below the logo ~1:2, so the headline
                  starts about a third of the way down and the features sit at
                  the bottom. */}
              <div className="flex-[1]" aria-hidden />

              <div className="grid gap-3 sm:gap-4">
                <h1 className="max-w-[13ch] text-[2rem] font-semibold leading-[0.95] tracking-[-0.06em] text-white sm:text-[2.35rem] md:text-[3rem]">
                  One setup, every seat.
                </h1>
                <p className="max-w-[34rem] text-[14px] leading-6 text-white/80 sm:text-[15px] sm:leading-7">
                  Configure once. Your whole team gets the same tools, agents, and providers.
                </p>
              </div>

              <div className="flex-[2]" aria-hidden />

              <div className="overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/[0.06] backdrop-blur-md">
                <div className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <Feature
                    icon={Share}
                    title="Shared config"
                    body="Set once, push to the org."
                  />
                  <Feature
                    icon={Bot}
                    title="Cloud agents"
                    body="Keep running while you're away."
                  />
                  <Feature
                    icon={Boxes}
                    title="Your models"
                    body="Bring your own provider."
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Auth form */}
          <div className="flex flex-col justify-center border-[var(--dls-border)] px-5 py-6 sm:px-7 sm:py-8 md:px-9 md:py-10 lg:border-l">
            {/* Mobile-only brand header — desktop shows the logo in the gradient panel */}
            <div className="mb-6 flex items-center gap-2 lg:hidden">
              <img src="/openwork-mark.svg" alt="OpenWork" className="h-7 w-auto" />
              <span className="text-[1.15rem] font-semibold tracking-tight text-[var(--dls-text-primary)]">
                OpenWork
              </span>
            </div>
            {!sessionHydrated ? (
              <SessionStatusPanel mode="checking" />
            ) : hasResolvedSession ? (
              <SessionStatusPanel mode="redirecting" />
            ) : (
              <AuthPanel bare />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
