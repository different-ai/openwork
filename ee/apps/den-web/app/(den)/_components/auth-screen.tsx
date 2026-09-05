"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isSamePathname } from "../_lib/client-route";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { SetupFrame } from "./setup-frame";
import { TemporaryAuthNotice } from "./temporary-auth-notice";

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
              <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-[var(--dls-text-primary)] opacity-30" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--dls-text-primary)]" />
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
  const { user, sessionHydrated, desktopAuthRequested, webAuthRequested, resolveUserLandingRoute } = useDenFlow();
  const hasResolvedSession = sessionHydrated && Boolean(user) && !desktopAuthRequested && !webAuthRequested;

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
    <SetupFrame
      step="account"
      title="Good work starts here."
      description="One account for your desktop, your tools, and your team."
    >
      <div data-testid="auth-landing-frame">
        <div data-testid="auth-landing-form">
          {!sessionHydrated ? (
            <SessionStatusPanel mode="checking" />
          ) : hasResolvedSession ? (
            <SessionStatusPanel mode="redirecting" />
          ) : (
            <div className="grid gap-5">
              <TemporaryAuthNotice />
              <AuthPanel bare emailFirstFlow />
            </div>
          )}
        </div>
      </div>
    </SetupFrame>
  );
}
