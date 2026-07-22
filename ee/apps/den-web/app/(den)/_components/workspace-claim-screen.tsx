"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { getDesktopGrant } from "../_lib/desktop-handoff";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import {
  PENDING_WORKSPACE_CLAIM_STORAGE_KEY,
  getOrgDashboardRoute,
} from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";

function LoadingCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4 lg:py-6">
      <div className="den-frame grid max-w-[44rem] gap-4 p-6 md:p-7">
        <p className="den-eyebrow">OpenWork Cloud</p>
        <div className="grid gap-2">
          <h1 className="den-title-lg">{title}</h1>
          <p className="den-copy">{body}</p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--dls-accent)]" />
        </div>
      </div>
    </section>
  );
}

type AcceptedClaim = {
  organizationName: string;
  organizationSlug: string;
};

const AUTO_ACCEPT_WORKSPACE_CLAIM_STORAGE_KEY = "openwork:web:auto-accept-workspace-claim";

function parseAcceptedClaim(payload: unknown): AcceptedClaim | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const organization = (payload as { organization?: unknown }).organization;
  if (typeof organization !== "object" || organization === null) {
    return null;
  }

  const name = (organization as { name?: unknown }).name;
  const slug = (organization as { slug?: unknown }).slug;

  return {
    organizationName: typeof name === "string" ? name : "your workspace",
    organizationSlug: typeof slug === "string" ? slug : "",
  };
}

function getOpenworkUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const url = (payload as { openworkUrl?: unknown }).openworkUrl;
  return typeof url === "string" && url.trim() ? url : null;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function inviteTeammates(inviteEmails: readonly string[]): Promise<string> {
  const results = await Promise.allSettled(
    inviteEmails.map((email) =>
      requestJson("/v1/invitations", { method: "POST", body: JSON.stringify({ email, role: "member" }) }, 12000),
    ),
  );

  const succeeded = results.filter((result) => result.status === "fulfilled" && result.value.response.ok).length;
  const failed = inviteEmails.length - succeeded;

  if (failed === 0) {
    return `Invited ${pluralize(succeeded, "teammate")}.`;
  }
  if (succeeded === 0) {
    return `Could not invite ${pluralize(failed, "teammate")}. You can invite them later from Manage Members.`;
  }
  return `Invited ${pluralize(succeeded, "teammate")}; ${pluralize(failed, "invite")} did not go through. You can retry from Manage Members.`;
}

export function WorkspaceClaimScreen({
  token,
  prefilledEmail,
  inviteEmails = [],
}: {
  token: string;
  prefilledEmail?: string;
  inviteEmails?: string[];
}) {
  const router = useRouter();
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedOrg, setClaimedOrg] = useState<AcceptedClaim | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffAttempted, setHandoffAttempted] = useState(false);
  const [inviteSummary, setInviteSummary] = useState<string | null>(null);
  const autoClaimAttempted = useRef(false);
  const isLoopback = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  // Persist the token so sign-in / sign-up returns the user to this page.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (token) {
      window.sessionStorage.setItem(PENDING_WORKSPACE_CLAIM_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(PENDING_WORKSPACE_CLAIM_STORAGE_KEY);
    }
  }, [token]);

  useEffect(() => {
    if (!sessionHydrated || user || !token || typeof window === "undefined") return;
    window.sessionStorage.setItem(AUTO_ACCEPT_WORKSPACE_CLAIM_STORAGE_KEY, token);
  }, [sessionHydrated, token, user]);

  async function handleClaim() {
    if (!token) {
      setClaimError("Missing claim link.");
      return;
    }

    setClaimBusy(true);
    setClaimError(null);

    try {
      const { response, payload } = await requestJson(
        "/v1/bootstrap/claims/accept",
        {
          method: "POST",
          body: JSON.stringify({ token }),
        },
        12000,
      );

      if (!response.ok) {
        setClaimError(
          getErrorMessage(
            payload,
            response.status === 404
              ? "This claim link is missing, expired, or already used."
              : `Could not claim the workspace (${response.status}).`,
          ),
        );
        return;
      }

      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PENDING_WORKSPACE_CLAIM_STORAGE_KEY);
      }

      if (inviteEmails.length > 0) {
        // The claim above just made this account the owner (and set it as
        // the session's active organization), so it can now invite
        // teammates through the same endpoint Manage Members uses. Show the
        // result briefly before moving on - this is best-effort: a failed
        // invite never blocks the claim, the owner can always retry from
        // Manage Members.
        const summary = await inviteTeammates(inviteEmails);
        setInviteSummary(summary);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1400));
      }

      // Don't navigate away immediately - offer to sign the already-running
      // desktop app in with zero retyped credentials, reusing the same
      // one-time handoff grant the normal "connect desktop" flow already
      // uses. The human chooses; we never auto-redirect them into an OS
      // "open this link?" prompt without asking.
      setClaimedOrg(parseAcceptedClaim(payload));
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Could not claim the workspace.");
    } finally {
      setClaimBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionHydrated || !user || !token || claimBusy || claimedOrg || autoClaimAttempted.current) return;
    if (window.sessionStorage.getItem(AUTO_ACCEPT_WORKSPACE_CLAIM_STORAGE_KEY) !== token) return;

    autoClaimAttempted.current = true;
    window.sessionStorage.removeItem(AUTO_ACCEPT_WORKSPACE_CLAIM_STORAGE_KEY);
    void handleClaim();
  }, [claimBusy, claimedOrg, sessionHydrated, token, user]);

  async function createDesktopHandoff(): Promise<string> {
    const { response, payload } = await requestJson(
      "/v1/auth/desktop-handoff",
      {
        method: "POST",
        body: JSON.stringify({ desktopScheme: "openwork" }),
      },
      12000,
    );

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Could not prepare a desktop sign-in link (${response.status}).`));
    }

    const openworkUrl = getOpenworkUrl(payload);
    if (!openworkUrl) {
      throw new Error("Desktop sign-in succeeded, but no app link was returned.");
    }

    return openworkUrl;
  }

  async function handleOpenDesktop() {
    setHandoffBusy(true);
    setHandoffError(null);
    setHandoffAttempted(true);

    try {
      window.location.assign(await createDesktopHandoff());
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : "Could not open OpenWork.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function handleCopySignInCode() {
    setCopyBusy(true);
    setCodeCopied(false);
    setHandoffError(null);

    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard is not available in this browser.");
      }

      const grant = getDesktopGrant(await createDesktopHandoff());
      if (!grant) {
        throw new Error("Desktop sign-in succeeded, but no one-time code was returned.");
      }

      await navigator.clipboard.writeText(grant);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 1800);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : "Could not copy the sign-in code.");
    } finally {
      setCopyBusy(false);
    }
  }

  function continueInBrowser() {
    router.replace(getOrgDashboardRoute(claimedOrg?.organizationSlug ?? null));
  }

  if (!token) {
    return (
      <section className="den-page py-4 lg:py-6">
        <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
          <div className="grid gap-2">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-lg">This claim link can&apos;t be opened.</h1>
            <p className="den-copy">The link is missing its claim token. Re-open the link from your setup, or ask for a new one.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/" className="den-button-primary w-full sm:w-auto">
              Back to OpenWork Cloud
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!sessionHydrated) {
    return <LoadingCard title="Loading workspace claim." body="Checking your account state..." />;
  }

  // Signed out: collect credentials, then resume on this page automatically.
  if (!user) {
    return (
      <section className="den-page py-6 lg:py-10">
        <div className="mx-auto grid w-full max-w-[32rem] gap-5">
          <div className="grid gap-2 text-center">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-lg">Claim your workspace</h1>
            <p className="den-copy">
              Sign in or create an account to become the owner. Your workspace is already set up.
            </p>
          </div>

          <AuthPanel
            eyebrow="Workspace owner"
            // Prefill only - never locked. The claim token (not the email) is
            // what authorizes accepting this claim, so the human can still
            // claim with a different email if they want to.
            prefilledEmail={prefilledEmail}
            prefillKey={token}
            signUpContent={{
              title: "Create your account",
              copy: "You will become the workspace owner.",
              submitLabel: "Create account and claim",
            }}
            signInContent={{
              title: "Sign in to continue",
              copy: "You will become the workspace owner.",
              submitLabel: "Sign in and claim",
            }}
          />
        </div>
      </section>
    );
  }

  // Claimed: offer to sign the desktop app in with zero retyped credentials,
  // or continue in the browser.
  if (claimedOrg) {
    return (
      <section
        className={`flex min-h-dvh w-full items-center justify-center px-5 py-8 ${isLoopback ? "bg-[#edf6ff]" : ""}`}
        data-demo-claim={isLoopback ? "true" : undefined}
      >
        <div className={`den-frame mx-auto grid w-full max-w-[38rem] gap-7 p-7 text-center md:p-10 ${isLoopback ? "border-blue-200/80 bg-white/90 shadow-[0_28px_80px_-44px_rgba(37,99,235,0.45)]" : ""}`}>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-[0_12px_28px_-14px_rgba(37,99,235,0.8)]">
            <Check className="size-6" strokeWidth={2.5} aria-hidden />
          </div>

          <div className="grid justify-items-center gap-3">
            <p className={`den-eyebrow ${isLoopback ? "text-blue-700" : ""}`}>{isLoopback ? "Demo workspace ready" : "Workspace ready"}</p>
            <h1 className="den-title-lg max-w-[22ch]">{claimedOrg.organizationName} is yours.</h1>
            <p className="den-copy max-w-[46ch]">
              {isLoopback
                ? "Copy the one-time code, then paste it into OpenWork to finish signing in."
                : "Open the desktop app to finish signing in. You will not need to enter your password again."}
            </p>
          </div>

          <div className="grid gap-3">
            {isLoopback ? (
              <button
                type="button"
                className="den-button-primary w-full bg-blue-600 shadow-[0_16px_34px_-18px_rgba(37,99,235,0.75)] hover:!bg-blue-700"
                onClick={() => void handleCopySignInCode()}
                disabled={handoffBusy || copyBusy}
              >
                <Copy className="size-4" aria-hidden />
                {copyBusy ? "Copying..." : codeCopied ? "Code copied" : "Copy sign-in code"}
              </button>
            ) : (
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleOpenDesktop()}
                disabled={handoffBusy || copyBusy}
              >
                {handoffBusy ? "Opening OpenWork..." : "Open OpenWork"}
              </button>
            )}

            <div className="flex flex-col items-center justify-center gap-2 text-sm sm:flex-row sm:gap-5">
              {isLoopback ? (
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center gap-1.5 px-2 font-medium text-[var(--dls-text-primary)] transition hover:text-blue-700 disabled:opacity-60"
                  onClick={() => void handleOpenDesktop()}
                  disabled={handoffBusy || copyBusy}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {handoffBusy ? "Opening OpenWork..." : "Open OpenWork"}
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center gap-1.5 px-2 font-medium text-[var(--dls-text-secondary)] transition hover:text-[var(--dls-text-primary)] disabled:opacity-60"
                  onClick={() => void handleCopySignInCode()}
                  disabled={handoffBusy || copyBusy}
                >
                  <Copy className="size-3.5" aria-hidden />
                  {copyBusy ? "Copying..." : codeCopied ? "Code copied" : "Copy sign-in code"}
                </button>
              )}
              <span className="hidden text-[var(--dls-border)] sm:inline" aria-hidden>•</span>
              <button
                type="button"
                className="min-h-10 px-2 font-medium text-[var(--dls-text-secondary)] transition hover:text-[var(--dls-text-primary)] disabled:opacity-60"
                onClick={continueInBrowser}
                disabled={handoffBusy || copyBusy}
              >
                Continue in browser instead
              </button>
            </div>
          </div>

          {codeCopied ? (
            <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
              In OpenWork, choose &quot;Paste sign-in code&quot; and paste it once.
            </div>
          ) : null}

          {handoffAttempted && !handoffError ? (
            <p className="den-copy text-sm">
              Opening OpenWork now. If nothing happens (for example, the app isn&apos;t installed on this machine), use &quot;Continue in browser instead&quot;.
            </p>
          ) : null}
          {handoffError ? <div className="den-notice is-error">{handoffError}</div> : null}
        </div>
      </section>
    );
  }

  // Signed in: confirm ownership.
  return (
    <section className="den-page py-6 lg:py-10">
      <div className="den-frame mx-auto grid max-w-[34rem] gap-6 p-6 md:p-8">
        <div className="grid gap-2">
          <p className="den-eyebrow">OpenWork Cloud</p>
          <h1 className="den-title-lg">Claim your workspace</h1>
          <p className="den-copy">Confirm this account to become the owner.</p>
        </div>

        <div className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3">
          <p className="den-label">Signed in as</p>
          <p className="m-0 text-sm font-medium text-[var(--dls-text-primary)]">{user.email}</p>
        </div>

        <div className="grid gap-4">
          {inviteEmails.length > 0 ? (
            <div className="den-frame-inset rounded-[1.5rem] px-4 py-3">
              <p className="den-label">Will invite on claim</p>
              <p className="m-0 text-sm text-[var(--dls-text-primary)]">{inviteEmails.join(", ")}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="den-button-primary w-full sm:w-auto"
              onClick={() => void handleClaim()}
              disabled={claimBusy}
            >
              {claimBusy ? (inviteSummary ?? "Claiming...") : "Claim this workspace"}
            </button>
            <button
              type="button"
              className="den-button-secondary w-full sm:w-auto"
              onClick={() => void signOut()}
              disabled={claimBusy}
            >
              Use a different account
            </button>
          </div>
        </div>

        {inviteSummary ? <div className="den-notice is-info">{inviteSummary}</div> : null}
        {claimError ? <div className="den-notice is-error">{claimError}</div> : null}
      </div>
    </section>
  );
}
