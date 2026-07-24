"use client";

import { useEffect, useState } from "react";
import {
  getDesktopHandoffGrant,
  getDesktopHandoffOpenworkUrl,
  rememberDesktopHandoffGrant,
} from "../_lib/desktop-handoff";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { createOrganizationInstallLink } from "../_lib/install-link-data";
import { isMobileUserAgent } from "../_lib/platform";
import { useDesktopHandoffStatus } from "../_lib/use-desktop-handoff-status";
import { OnboardingShell } from "./onboarding-shell";
import { OrganizationBrandIdentity, type OrganizationBrand } from "./organization-brand-identity";

const OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download";

function ReturnToOpenWorkStatus({
  openworkUrl,
  grant,
  organizationName,
}: {
  openworkUrl: string;
  grant: string | null;
  organizationName: string;
}) {
  const { status, timedOut } = useDesktopHandoffStatus(grant);
  const [copied, setCopied] = useState(false);

  async function copyOpenworkUrl() {
    await navigator.clipboard.writeText(openworkUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (status === "consumed") {
    return (
      <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700" data-testid="desktop-connected" aria-live="polite">
        Connected — {organizationName} is ready in OpenWork.
      </div>
    );
  }

  if (timedOut || status === "unknown") {
    return (
      <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600" data-testid="desktop-handoff-troubleshoot" aria-live="polite">
        <p className="m-0">
          Nothing opened?{" "}
          <button type="button" className="font-medium text-slate-950 underline-offset-4 hover:underline" onClick={() => window.location.assign(openworkUrl)}>
            Return to OpenWork again
          </button>
        </p>
        <div className="grid gap-2">
          <p className="m-0">Still stuck? Copy this sign-in link into OpenWork:</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="den-input min-w-0 flex-1 text-xs" value={openworkUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="den-button-secondary sm:w-auto" onClick={() => void copyOpenworkUrl()}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <p className="m-0 text-sm text-slate-500" aria-live="polite">
      Returning to OpenWork…
    </p>
  );
}

type JoinOrgSuccessProps = {
  organizationId: string;
  organizationName: string;
  brand: OrganizationBrand;
  desktopAuthRequested: boolean;
  desktopAuthScheme: string;
  onContinueInBrowser: () => void;
};

export function JoinOrgSuccess({
  organizationId,
  organizationName,
  brand,
  desktopAuthRequested,
  desktopAuthScheme,
  onContinueInBrowser,
}: JoinOrgSuccessProps) {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [desktopOpenworkUrl, setDesktopOpenworkUrl] = useState<string | null>(null);
  const [desktopGrant, setDesktopGrant] = useState<string | null>(null);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
  }, []);

  async function handleGetApp() {
    setInstallBusy(true);
    setActionError(null);

    try {
      window.location.assign(await createOrganizationInstallLink(organizationId, false));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not prepare your download.");
    } finally {
      setInstallBusy(false);
    }
  }

  async function handleReturnToOpenWork() {
    setHandoffBusy(true);
    setActionError(null);

    try {
      const { response, payload } = await requestJson(
        "/v1/auth/desktop-handoff",
        { method: "POST", body: JSON.stringify({ desktopScheme: desktopAuthScheme }) },
        12000,
      );
      if (!response.ok) {
        setActionError(getErrorMessage(payload, `Could not return to OpenWork (${response.status}).`));
        return;
      }

      const openworkUrl = getDesktopHandoffOpenworkUrl(payload);
      if (!openworkUrl) {
        setActionError("OpenWork sign-in was prepared, but no app link was returned.");
        return;
      }

      const grant = getDesktopHandoffGrant(payload, openworkUrl);
      rememberDesktopHandoffGrant(grant);
      setDesktopOpenworkUrl(openworkUrl);
      setDesktopGrant(grant);
      window.location.assign(openworkUrl);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not return to OpenWork.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function handleEmailDownload() {
    setEmailBusy(true);
    setActionError(null);

    try {
      const { response, payload } = await requestJson("/v1/me/send-download-link", { method: "POST" }, 12000);
      if (!response.ok) {
        setActionError(getErrorMessage(payload, `Could not send the download link (${response.status}).`));
        return;
      }
      setEmailSent(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not send the download link.");
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <OnboardingShell state="joined" width="wide">
      <section data-testid="join-org-success">
        <div className="grid gap-5 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 sm:p-8 md:p-10">
          <div className="grid gap-3">
            <h1 className="m-0 grid max-w-full gap-1 text-[2rem] font-semibold leading-[1.03] tracking-[-0.055em] text-slate-950 sm:text-[2.6rem]">
              <span>You&apos;re in, welcome to</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-[0.18em] gap-y-1">
                <OrganizationBrandIdentity organizationName={organizationName} brand={brand} />
                <span className="whitespace-nowrap">&apos;s {brand.appName}</span>
              </span>
            </h1>
            <p className="m-0 max-w-2xl text-sm leading-6 text-slate-600">
              {desktopAuthRequested
                ? "Your team setup is ready. Return to OpenWork to continue where you left off."
                : "The desktop app is where OpenWork runs on your computer and puts your team's setup to work."}
            </p>
          </div>

          {isMobile === null ? (
            <p className="m-0 text-sm text-slate-500">Preparing your next step...</p>
          ) : isMobile ? (
            <div className="grid gap-3">
              <div className="grid gap-2 rounded-2xl bg-slate-50 p-4" data-testid="join-org-mobile-note">
                <p className="m-0 text-sm font-medium text-slate-950">OpenWork runs on your computer.</p>
                <p className="m-0 text-sm leading-6 text-slate-600">
                  Email the install link to yourself and continue when you&apos;re back at your desk.
                </p>
              </div>
              <button
                type="button"
                className="den-button-primary w-full sm:w-fit"
                onClick={() => void handleEmailDownload()}
                disabled={emailBusy || emailSent}
                data-testid="join-org-email-download"
              >
                {emailBusy ? "Sending..." : emailSent ? "Sent" : "Email me the download link"}
              </button>
              {emailSent ? <div className="den-notice is-info">Sent — check your inbox when you&apos;re back at your desk.</div> : null}
            </div>
          ) : desktopAuthRequested ? (
            desktopOpenworkUrl ? (
              <ReturnToOpenWorkStatus openworkUrl={desktopOpenworkUrl} grant={desktopGrant} organizationName={organizationName} />
            ) : (
              <button
                type="button"
                className="den-button-primary w-full sm:w-fit"
                onClick={() => void handleReturnToOpenWork()}
                disabled={handoffBusy}
                data-testid="join-org-return-openwork"
              >
                {handoffBusy ? "Returning to OpenWork..." : "Return to OpenWork"}
              </button>
            )
          ) : (
            <button
              type="button"
              className="den-button-primary w-full sm:w-fit"
              onClick={() => void handleGetApp()}
              disabled={installBusy}
              data-testid="join-org-get-app"
            >
              {installBusy ? "Preparing your download..." : "Get the desktop app"}
            </button>
          )}

          <button
            type="button"
            className="w-fit text-sm text-slate-500 underline-offset-4 hover:text-slate-950 hover:underline"
            onClick={onContinueInBrowser}
            data-testid="join-org-continue-browser"
          >
            Continue in the browser
          </button>

          {actionError ? (
            <div className="grid gap-3">
              <div className="den-notice is-error">{actionError}</div>
              {desktopAuthRequested ? null : (
                <a href={OPENWORK_DOWNLOAD_URL} className="den-button-secondary w-full sm:w-fit">
                  Open the public download page
                </a>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </OnboardingShell>
  );
}
