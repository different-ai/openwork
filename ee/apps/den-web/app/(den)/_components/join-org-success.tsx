"use client";

import { useEffect, useState } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { createOrganizationInstallLink } from "../_lib/install-link-data";
import { isMobileUserAgent } from "../_lib/platform";

const OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download";

const capabilities = [
  {
    title: "Edit spreadsheets",
    description: "Create, clean, and transform CSV and Excel files.",
  },
  {
    title: "Control your browser",
    description: "Automate the built-in browser for repetitive web tasks.",
  },
  {
    title: "Organize files",
    description: "Read, write, and manage files and folders.",
  },
  {
    title: "Automate tasks",
    description: "Build reusable workflows with skills and commands.",
  },
  {
    title: "Generate content",
    description: "Draft documents, emails, and reports.",
  },
  {
    title: "Connect to APIs",
    description: "Plug into external services and tools via MCP.",
  },
];

type JoinOrgSuccessProps = {
  organizationId: string;
  organizationName: string;
  onContinueInBrowser: () => void;
};

export function JoinOrgSuccess({ organizationId, organizationName, onContinueInBrowser }: JoinOrgSuccessProps) {
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
      window.location.assign(await createOrganizationInstallLink(organizationId));
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
    <section className="den-page py-4 lg:py-6" data-testid="join-org-success">
      <div className="den-frame grid max-w-[48rem] gap-6 p-6 md:p-8">
        <div className="grid gap-2">
          <p className="den-eyebrow">OpenWork Cloud</p>
          <h1 className="den-title-xl max-w-[16ch]">You&apos;re in, welcome to {organizationName}</h1>
          <p className="den-copy">The desktop app is where OpenWork runs on your computer and puts your team&apos;s setup to work.</p>
        </div>

        {isMobile === null ? (
          <p className="den-copy">Preparing your next step...</p>
        ) : isMobile ? (
          <div className="grid gap-5">
            <div className="den-frame-inset grid gap-2 rounded-[1.5rem] p-5" data-testid="join-org-mobile-note">
              <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">OpenWork runs on your computer.</p>
              <p className="den-copy">You&apos;re in — next time you&apos;re at your computer, download the desktop app to put your team to work.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleEmailDownload()}
                disabled={emailBusy || emailSent}
                data-testid="join-org-email-download"
              >
                {emailBusy ? "Sending..." : emailSent ? "Sent" : "Email me the download link"}
              </button>
            </div>
            {emailSent ? <div className="den-notice is-info">Sent — check your inbox when you&apos;re back at your desk.</div> : null}
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {capabilities.map((capability) => (
                <div key={capability.title} className="den-frame-inset rounded-[1.25rem] p-4">
                  <p className="m-0 text-sm font-medium text-[var(--dls-text-primary)]">{capability.title}</p>
                  <p className="m-0 mt-1 text-xs leading-snug text-[var(--dls-text-secondary)]">{capability.description}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void handleGetApp()}
                disabled={installBusy}
                data-testid="join-org-get-app"
              >
                {installBusy ? "Preparing your download..." : "Get the desktop app"}
              </button>
              {actionError ? (
                <a
                  href={OPENWORK_DOWNLOAD_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="den-button-secondary w-full sm:w-auto"
                  data-testid="join-org-download"
                >
                  Download the desktop app
                </a>
              ) : null}
            </div>
          </div>
        )}

        <button
          type="button"
          className="w-fit text-sm text-[var(--dls-text-secondary)] underline-offset-4 hover:underline"
          onClick={onContinueInBrowser}
          data-testid="join-org-continue-browser"
        >
          Continue in the browser
        </button>

        {actionError ? <div className="den-notice is-error">{actionError}</div> : null}
      </div>
    </section>
  );
}
