"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

export function WorkspaceClaimScreen({ token }: { token: string }) {
  const router = useRouter();
  const { user, sessionHydrated, signOut } = useDenFlow();
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

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

      const accepted = parseAcceptedClaim(payload);
      router.replace(getOrgDashboardRoute(accepted?.organizationSlug ?? null));
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Could not claim the workspace.");
    } finally {
      setClaimBusy(false);
    }
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
      <section className="den-page grid gap-6 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:py-6">
        <div className="den-frame grid gap-6 p-6 md:p-8">
          <div className="grid gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <div className="grid gap-2">
              <p className="den-copy">Claim the workspace OpenWork set up for you</p>
              <h1 className="den-title-xl max-w-[14ch]">Take ownership</h1>
            </div>
          </div>

          <div className="den-frame-inset grid gap-3 rounded-[1.5rem] p-5">
            <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">
              Sign in to become the owner.
            </p>
            <p className="den-copy">
              Your workspace and first skill are already set up. Sign in or create an account to attach yourself as the human owner and add billing.
            </p>
          </div>
        </div>

        <AuthPanel
          eyebrow="Claim workspace"
          signUpContent={{
            title: "Claim your workspace.",
            copy: "Create an account to take ownership.",
            submitLabel: "Create account and claim",
            togglePrompt: "Already on Cloud?",
            toggleActionLabel: "Sign in",
          }}
          signInContent={{
            title: "Claim your workspace.",
            copy: "Sign in to take ownership.",
            submitLabel: "Sign in to claim",
            togglePrompt: "Need a new account?",
            toggleActionLabel: "Create one",
          }}
        />
      </section>
    );
  }

  // Signed in: confirm ownership.
  return (
    <section className="den-page py-4 lg:py-6">
      <div className="den-frame grid max-w-[44rem] gap-6 p-6 md:p-8">
        <div className="grid gap-3">
          <p className="den-eyebrow">OpenWork Cloud</p>
          <div className="grid gap-2">
            <p className="den-copy">Claim the workspace OpenWork set up for you</p>
            <h1 className="den-title-xl max-w-[14ch]">Take ownership</h1>
          </div>
        </div>

        <div className="den-frame-inset grid gap-1 rounded-[1.5rem] px-4 py-3">
          <p className="den-label">Signed in as</p>
          <p className="m-0 text-sm font-medium text-[var(--dls-text-primary)]">{user.email}</p>
        </div>

        <div className="grid gap-4">
          <p className="den-copy">
            Claiming attaches this account as the owner of the workspace and unlocks billing and teammates.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="den-button-primary w-full sm:w-auto"
              onClick={() => void handleClaim()}
              disabled={claimBusy}
            >
              {claimBusy ? "Claiming..." : "Claim this workspace"}
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

        {claimError ? <div className="den-notice is-error">{claimError}</div> : null}
      </div>
    </section>
  );
}
