"use client";

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
            <div className="absolute inset-0 z-0 bg-[#011627]" />
            <div className="absolute inset-0 z-0 bg-[linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:44px_44px]" />
            <div className="absolute right-8 top-8 z-0 h-32 w-32 rounded-full border border-white/10" />
            <div className="absolute bottom-8 right-12 z-0 h-20 w-44 rounded-2xl border border-white/10 bg-white/5" />

            <div className="relative z-10 flex h-full flex-col justify-between gap-10">
              <div className="flex items-center gap-3">
                <img src="/openwork-logo-transparent.svg" alt="OpenWork" className="h-9 w-auto" />
                <span className="text-[13px] font-medium text-white/80">OpenWork Cloud</span>
              </div>

              <div className="grid gap-4">
                <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                  OpenWork Cloud
                </span>
                <h1 className="max-w-[12ch] text-[2.25rem] font-semibold leading-none tracking-normal text-white md:text-[3rem]">
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
