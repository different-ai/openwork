"use client";

import { detectPlatform, type DetectedPlatform } from "@openwork/ui/react";
import { useEffect, useState } from "react";
import {
  getDesktopHandoffGrant,
  getDesktopHandoffOpenworkUrl,
  rememberDesktopHandoffGrant,
} from "../_lib/desktop-handoff";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { detectedInstallPlatform, downloadCtaLabel, installDownloadHref } from "../_lib/install-download";
import { isMobileUserAgent } from "../_lib/platform";
import { useDesktopHandoffStatus } from "../_lib/use-desktop-handoff-status";
import { JoinAlert, JoinFrame, JoinHeading, JoinPrimaryButton, JoinQuietButton, JoinText } from "./join-frame";
import type { OrganizationBrand } from "./organization-brand-identity";

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
  organizationName: string;
  brand: OrganizationBrand;
  desktopAuthRequested: boolean;
  desktopAuthScheme: string;
  onContinueInBrowser: () => void;
};

export function JoinOrgSuccess({
  organizationName,
  brand,
  desktopAuthRequested,
  desktopAuthScheme,
  onContinueInBrowser,
}: JoinOrgSuccessProps) {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);
  const [platformReady, setPlatformReady] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [desktopOpenworkUrl, setDesktopOpenworkUrl] = useState<string | null>(null);
  const [desktopGrant, setDesktopGrant] = useState<string | null>(null);
  const [downloadHref, setDownloadHref] = useState<string | null>(null);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    let cancelled = false;
    void detectPlatform()
      .then((platform) => {
        if (cancelled) {
          return;
        }
        setDetected(platform ?? { os: "macos", arch: "arm64", osVersion: null, source: "ua" });
        setPlatformReady(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setDetected({ os: "macos", arch: "arm64", osVersion: null, source: "ua" });
        setPlatformReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function startInstallerDownload(href: string) {
    const link = document.createElement("a");
    link.href = href;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.setAttribute("data-testid", "join-org-download-link");
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function handleGetApp() {
    setInstallBusy(true);
    setActionError(null);

    try {
      // Joining made this organization active, so the signed-in install routes
      // serve its approved desktop version.
      const { response, payload } = await requestJson("/v1/me/install-config", { method: "GET" }, 12000);
      if (!response.ok) {
        throw new Error(getInstallConfigErrorMessage(payload, response.status));
      }

      const platform = detectedInstallPlatform(detected) ?? "mac-arm64";
      const href = installDownloadHref(platform);
      setDownloadHref(href);
      startInstallerDownload(href);
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
    <JoinFrame state="joined" organization={{ name: organizationName, brand }} testId="join-org-success">
            <JoinHeading
              title={`You're in. Welcome to ${organizationName}.`}
              copy={desktopAuthRequested
                ? "Your team setup is ready. Return to OpenWork to continue where you left off."
                : `Get the desktop app to start working with ${organizationName}'s setup.`}
            />

          {isMobile === null ? (
            <JoinText muted>Preparing your next step...</JoinText>
          ) : isMobile ? (
            <div className="grid gap-3">
              <div className="grid gap-2 rounded-lg bg-[#fafafa] p-3.5" data-testid="join-org-mobile-note">
                <p className="m-0 text-sm font-medium text-slate-950">OpenWork runs on your computer.</p>
                <p className="m-0 text-sm leading-6 text-slate-600">
                  Email the install link to yourself and continue when you&apos;re back at your desk.
                </p>
              </div>
              <JoinPrimaryButton onClick={() => void handleEmailDownload()} disabled={emailBusy || emailSent} testId="join-org-email-download">
{emailBusy ? "Sending..." : emailSent ? "Sent" : "Email me the download link"}
</JoinPrimaryButton>
              {emailSent ? <JoinText muted>Sent. Check your inbox when you&apos;re back at your desk.</JoinText> : null}
            </div>
          ) : desktopAuthRequested ? (
            desktopOpenworkUrl ? (
              <ReturnToOpenWorkStatus openworkUrl={desktopOpenworkUrl} grant={desktopGrant} organizationName={organizationName} />
            ) : (
              <JoinPrimaryButton onClick={() => void handleReturnToOpenWork()} disabled={handoffBusy} testId="join-org-return-openwork">
{handoffBusy ? "Returning to OpenWork..." : "Return to OpenWork"}
</JoinPrimaryButton>
            )
          ) : !platformReady ? (
            <JoinText muted>Preparing your next step...</JoinText>
          ) : (
            <div className="grid gap-3">
              <JoinPrimaryButton onClick={() => void handleGetApp()} disabled={installBusy} testId="join-org-get-app" downloadHref={downloadHref ?? undefined}>
{installBusy ? "Preparing your download..." : downloadCtaLabel(detected?.os ?? null)}
</JoinPrimaryButton>
              <JoinQuietButton onClick={() => void handleReturnToOpenWork()} disabled={handoffBusy} testId="join-org-open-app">
{handoffBusy ? "Opening OpenWork..." : "Already have OpenWork? Open it."}
</JoinQuietButton>
            </div>
          )}

          <JoinQuietButton onClick={onContinueInBrowser} testId="join-org-continue-browser">
Continue in the browser
</JoinQuietButton>

          {actionError ? (
            <div className="grid gap-3">
              <JoinAlert>{actionError}</JoinAlert>
              {desktopAuthRequested ? null : (
                <a href={OPENWORK_DOWNLOAD_URL} className="den-button-secondary min-h-12 w-full">
                  Open the public download page
                </a>
              )}
            </div>
          ) : null}
    </JoinFrame>
  );
}
