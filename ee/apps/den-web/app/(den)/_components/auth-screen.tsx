"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { isSamePathname } from "../_lib/client-route";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
import { useDenFlow } from "../_providers/den-flow-provider";
import { WorkspaceLoadingScreen } from "./workspace-loading-screen";
import { AuthPanel } from "./auth-panel";
import { OnboardingTexture } from "./onboarding-texture";
import { SetupFrame } from "./setup-frame";
import { TemporaryAuthNotice } from "./temporary-auth-notice";

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
      routingRef.current = true;
      router.replace(oauthRoute);
      return;
    }

    routingRef.current = true;
    let navigationStarted = false;
    void resolveUserLandingRoute()
      .then((target) => {
        if (target && !isSamePathname(pathname, target)) {
          navigationStarted = true;
          router.replace(target);
        }
      })
      .finally(() => {
        // Hold the guard until unmount: provider updates can arrive before navigation commits.
        if (!navigationStarted) routingRef.current = false;
      });
  }, [hasResolvedSession, pathname, resolveUserLandingRoute, router]);

  if (!sessionHydrated || hasResolvedSession) {
    return <WorkspaceLoadingScreen />;
  }

  return (
    <SetupFrame
      step="account"
      panelVisual={<OnboardingTexture />}
      title="Good work starts here."
      description="One account for your desktop, your tools, and your team."
    >
      <div data-testid="auth-landing-frame">
        <div data-testid="auth-landing-form">
          <div className="grid gap-5">
            <TemporaryAuthNotice />
            <AuthPanel bare emailFirstFlow />
          </div>
        </div>
      </div>
    </SetupFrame>
  );
}
