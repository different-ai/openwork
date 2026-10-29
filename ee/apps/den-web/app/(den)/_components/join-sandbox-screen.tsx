"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sandboxJoinedSchema, sandboxJoinPreviewSchema, type SandboxJoinPreview } from "@openwork/types/den/sandbox-organizations";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { JoinOrgSuccess } from "./join-org-success";
import { OnboardingCard } from "./onboarding-card";
import { OnboardingShell } from "./onboarding-shell";
import type { OrganizationBrand } from "./organization-brand-identity";

const brand: OrganizationBrand = { appName: "OpenWork", logoUrl: null, iconUrl: null };
const primaryActionClassName = "den-button-primary min-h-12 w-full focus:outline-hidden focus:ring-4 focus:ring-slate-950/10";

const unavailable: Record<Exclude<SandboxJoinPreview["state"], "open">, { title: string; copy: string }> = {
  closed: { title: "This sandbox is closed.", copy: "It is no longer accepting people. Ask whoever shared the link for a new one." },
  expired: { title: "This sandbox has ended.", copy: "Ask whoever shared the link for a new one." },
  full: { title: "This sandbox is full.", copy: "Every seat is taken. Ask whoever shared the link for another sandbox." },
};

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "long" });

function Heading({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="grid gap-2.5">
      <h1 className="m-0 text-balance text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-slate-950 sm:text-[38px] sm:leading-[46px]">{title}</h1>
      <p className="m-0 text-[15px] leading-[23px] text-slate-600">{copy}</p>
    </div>
  );
}

function Alert({ children }: { children: string }) {
  return <div className="rounded-2xl border border-rose-200 bg-white px-4 py-3 text-sm font-medium leading-6 text-rose-700" role="alert">{children}</div>;
}

export function JoinSandboxScreen({ token }: { token: string }) {
  const router = useRouter();
  const { user, sessionHydrated, desktopAuthRequested, desktopAuthScheme } = useDenFlow();
  const [preview, setPreview] = useState<SandboxJoinPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setPreviewError("This sandbox link is incomplete. Ask for a new link."); return; }
    void requestJson(`/v1/sandbox-join/preview?token=${encodeURIComponent(token)}`, { method: "GET" }, 12_000).then(({ response, payload }) => {
      if (cancelled) return;
      if (!response.ok) { setPreviewError(getErrorMessage(payload, "This sandbox link is not valid. Ask for a new link.")); return; }
      const parsed = sandboxJoinPreviewSchema.safeParse(payload);
      if (parsed.success) setPreview(parsed.data);
      else setPreviewError("The sandbox details were incomplete. Refresh to try again.");
    }).catch((error: unknown) => {
      if (!cancelled) setPreviewError(error instanceof Error ? error.message : "Could not load this sandbox.");
    });
    return () => { cancelled = true; };
  }, [token]);

  async function join() {
    setJoining(true);
    setJoinError(null);
    try {
      const { response, payload } = await requestJson("/v1/sandbox-join", { method: "POST", body: JSON.stringify({ token }) }, 30_000);
      if (!response.ok) { setJoinError(getErrorMessage(payload, `Could not join the sandbox (${response.status}).`)); return; }
      if (!sandboxJoinedSchema.safeParse(payload).success) { setJoinError("Could not confirm you joined. Refresh to check."); return; }
      setJoined(true);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Could not join the sandbox.");
    } finally {
      setJoining(false);
    }
  }

  if (joined && preview) {
    return (
      <JoinOrgSuccess
        organizationName={preview.organizationName}
        brand={brand}
        desktopAuthRequested={desktopAuthRequested}
        desktopAuthScheme={desktopAuthScheme}
        onContinueInBrowser={() => router.replace("/dashboard")}
      />
    );
  }

  const organization = preview ? { name: preview.organizationName, brand } : null;
  return (
    <OnboardingShell state={previewError ? "error" : preview ? "ready" : "loading"} width="wide" background="surface">
      <OnboardingCard organization={organization}>
        <div className="grid gap-6" data-testid="join-sandbox">
          {previewError ? <Heading title="This link isn't available." copy={previewError} /> : null}
          {!previewError && !preview ? (
            <div className="grid gap-5" aria-busy="true">
              <Heading title="Loading sandbox." copy="Checking the link..." />
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-slate-900" /></div>
            </div>
          ) : null}
          {preview && preview.state !== "open" ? <Heading title={unavailable[preview.state].title} copy={unavailable[preview.state].copy} /> : null}
          {preview && preview.state === "open" ? (
            <>
              <Heading
                title={`Try OpenWork in ${preview.organizationName}.`}
                copy={`A private sandbox with included AI models${preview.connectors.length ? " and sample work apps" : ""}. You'll join as ${preview.joinRole === "admin" ? "an admin" : "a member"}. Open until ${dateLabel(preview.expiresAt)}.`}
              />
              {preview.connectors.length ? (
                <div className="grid gap-2" data-testid="join-sandbox-connectors">
                  <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Sample apps</p>
                  <p className="m-0 text-sm leading-6 text-slate-700">{preview.connectors.join(", ")}. The data is fictional, and only you see your copy.</p>
                </div>
              ) : null}
              {!sessionHydrated ? null : user ? (
                <div className="grid gap-3">
                  <p className="m-0 text-sm text-slate-600">Joining as <span className="font-medium text-slate-950">{user.email}</span></p>
                  {joinError ? <Alert>{joinError}</Alert> : null}
                  <button type="button" className={primaryActionClassName} data-testid="join-sandbox-submit" disabled={joining} onClick={() => void join()}>
                    {joining ? "Joining..." : "Join sandbox"}
                  </button>
                </div>
              ) : (
                <div data-testid="join-sandbox-auth">
                  {/* Email first, like the main sign-in page: an existing account is asked for its password instead of
                      being sent to a code screen. Signing up with an email that already has an account sends no code. */}
                  <AuthPanel
                    bare
                    hideIntro
                    emailFirstFlow
                    emailStepContent={{ title: "Enter your email to join.", submitLabel: "Next" }}
                    signUpContent={{ submitLabel: "Create account" }}
                    signInContent={{ title: "Sign in to continue.", copy: "Sign in, then join the sandbox.", submitLabel: "Sign in" }}
                    verificationContent={{ title: "Check your inbox.", copy: "Enter the six-digit code we sent you.", submitLabel: "Verify" }}
                  />
                </div>
              )}
            </>
          ) : null}
        </div>
      </OnboardingCard>
    </OnboardingShell>
  );
}
