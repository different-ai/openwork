"use client";

import { useEffect, useState } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { createOrganizationInstallLink } from "../_lib/install-link-data";
import { isMobileUserAgent } from "../_lib/platform";
import { OnboardingShell } from "./onboarding-shell";
import { OrganizationBrandIdentity, type OrganizationBrand } from "./organization-brand-identity";

const OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download";

type JoinOrgSuccessProps = {
  organizationId: string;
  organizationName: string;
  brand: OrganizationBrand;
  onContinueInBrowser: () => void;
};

export function JoinOrgSuccess({
  organizationId,
  organizationName,
  brand,
  onContinueInBrowser,
}: JoinOrgSuccessProps) {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
            <h1 className="m-0 max-w-[22ch] text-balance text-[2rem] font-semibold leading-[1.03] tracking-[-0.055em] text-slate-950 sm:text-[2.6rem]">
              You&apos;re in, welcome to{" "}
              <OrganizationBrandIdentity organizationName={organizationName} brand={brand} />
              &apos;s {brand.appName}
            </h1>
            <p className="m-0 max-w-2xl text-sm leading-6 text-slate-600">
              The desktop app is where OpenWork runs on your computer and puts your team&apos;s setup to work.
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
              <a href={OPENWORK_DOWNLOAD_URL} className="den-button-secondary w-full sm:w-fit">
                Open the public download page
              </a>
            </div>
          ) : null}
        </div>
      </section>
    </OnboardingShell>
  );
}
