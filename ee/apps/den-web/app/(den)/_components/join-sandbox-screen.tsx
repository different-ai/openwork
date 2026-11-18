"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sandboxJoinedSchema, sandboxJoinPreviewSchema, type SandboxJoinPreview } from "@openwork/types/den/sandbox-organizations";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { JoinOrgSuccess } from "./join-org-success";
import { JoinAlert, JoinFacts, JoinFrame, JoinHeading, JoinLoadingBar, JoinPrimaryButton, JoinText, JoinWorkspaceValue } from "./join-frame";
import type { OrganizationBrand } from "./organization-brand-identity";

const brand: OrganizationBrand = { appName: "OpenWork", logoUrl: null, iconUrl: null };
const unavailable: Record<Exclude<SandboxJoinPreview["state"], "open">, { title: string; copy: string }> = {
  closed: { title: "This sandbox is closed.", copy: "It is no longer accepting people. Ask whoever shared the link for a new one." },
  expired: { title: "This sandbox has ended.", copy: "Ask whoever shared the link for a new one." },
  full: { title: "This sandbox is full.", copy: "Every seat is taken. Ask whoever shared the link for another sandbox." },
};

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "long" });

const Heading = JoinHeading;
const Alert = JoinAlert;

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
    <JoinFrame state={previewError ? "error" : preview ? "ready" : "loading"} organization={organization}>
        <div className="grid gap-[18px]" data-testid="join-sandbox">
          {previewError ? <Heading title="This link isn't available." copy={previewError} /> : null}
          {!previewError && !preview ? (
            <div className="grid gap-5" aria-busy="true">
              <Heading title="Loading sandbox." copy="Checking the link..." />
              <JoinLoadingBar />
            </div>
          ) : null}
          {preview && preview.state !== "open" ? <Heading title={unavailable[preview.state].title} copy={unavailable[preview.state].copy} /> : null}
          {preview && preview.state === "open" ? (
            <>
                  <Heading title={`Try OpenWork in ${preview.organizationName}.`} copy={`A private sandbox with included AI models${preview.connectors.length ? " and sample work apps" : ""}.`} />
                  <JoinFacts
                    testId="join-sandbox-facts"
                    rows={[
                      { label: "Sandbox", value: <JoinWorkspaceValue name={preview.organizationName} /> },
                      { label: "You join as", value: preview.joinRole === "super-admin" ? "Super admin" : preview.joinRole === "admin" ? "Admin" : "Member" },
                      { label: "Open until", value: dateLabel(preview.expiresAt) },
                      ...(preview.connectors.length ? [{ label: "Sample apps", value: <span data-testid="join-sandbox-connectors" className="truncate">{preview.connectors.join(", ")}</span> }] : []),
                      ...(sessionHydrated && user ? [{ label: "Joining as", value: user.email }] : []),
                    ]}
                  />
                  {preview.connectors.length ? <JoinText muted>The sample data is fictional, and only you see your copy.</JoinText> : null}
              {!sessionHydrated ? null : user ? (
                <div className="grid gap-3">
                  {joinError ? <Alert>{joinError}</Alert> : null}
                  <JoinPrimaryButton testId="join-sandbox-submit" disabled={joining} onClick={() => void join()}>
                    {joining ? "Joining..." : "Join sandbox"}
                  </JoinPrimaryButton>
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
    </JoinFrame>
  );
}
