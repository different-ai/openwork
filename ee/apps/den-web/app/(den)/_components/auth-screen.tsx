"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isSamePathname } from "../_lib/client-route";
import { getMcpOAuthSelectOrganizationRoute } from "../_lib/mcp-oauth-route";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { OnboardingTexture } from "./onboarding-texture";
import { McpAppFact, McpStoryTiles, mcpStoryCopy } from "../../mcp/mcp-story";
import { useMcpClient } from "../../mcp/use-mcp-client";
import { SetupFrame } from "./setup-frame";
import { SetupFacts, SetupPanelBody } from "./setup-frame-parts";
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

export function AuthScreen({ agentSignIn = false }: { agentSignIn?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const routingRef = useRef(false);
  const { user, runtimeConfigLoaded, sessionHydrated, desktopAuthRequested, setupPending, authError, webAuthRequested, resolveUserLandingRoute } = useDenFlow();
  const hasResolvedSession = runtimeConfigLoaded && sessionHydrated && Boolean(user) && !authError && (!desktopAuthRequested || setupPending) && !webAuthRequested;

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

  if (agentSignIn) {
    return <AgentSignInScreen status={!runtimeConfigLoaded || !sessionHydrated ? "checking" : hasResolvedSession ? "redirecting" : null} />;
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
          {!runtimeConfigLoaded || !sessionHydrated ? (
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

/**
 * Sign-up while an agent waits (A7): the story names the app that asked, and
 * the panel keeps "Signing in for" above the sign-in so the person never
 * loses track of why they are here.
 */
function AgentSignInScreen({ status }: { status: "checking" | "redirecting" | null }) {
  const [oauthQuery, setOauthQuery] = useState("");
  useEffect(() => {
    setOauthQuery(window.location.search.replace(/^\?/, ""));
  }, []);
  const client = useMcpClient(oauthQuery);
  const story = mcpStoryCopy(client);
  return (
    <SetupFrame
      title={story.title}
      description={story.description}
      aside={<McpStoryTiles client={client} workspaceName={null} />}
      panelVisual={<OnboardingTexture />}
    >
      <div data-testid="auth-landing-frame">
        <div data-testid="auth-landing-form">
          <SetupPanelBody>
            <SetupFacts rows={[{ label: "Signing in for", value: <McpAppFact client={client} /> }]} />
            {status ? (
              <SessionStatusPanel mode={status} />
            ) : (
              <AuthPanel
                bare
                emailFirstFlow
                socialFirst
                emailStepContent={{ title: "Create your account.", copy: "Already have an account? Enter your email and we\u2019ll find it." }}
                agentContext={oauthQuery ? { kind: "mcp-oauth", oauthQuery } : undefined}
              />
            )}
          </SetupPanelBody>
        </div>
      </div>
    </SetupFrame>
  );
}
