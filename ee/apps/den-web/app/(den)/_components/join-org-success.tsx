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

function DesktopHandoffStatus({
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
  const resolvedOrganizationName = organizationName.trim() || "your team";

  async function copyOpenworkUrl() {
    await navigator.clipboard.writeText(openworkUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (status === "consumed") {
    return (
      <div className="den-frame-inset rounded-[1.5rem] px-4 py-3 text-center text-sm font-medium text-emerald-700" data-testid="desktop-connected" aria-live="polite">
        ✓ Connected — OpenWork is set up for {resolvedOrganizationName}
      </div>
    );
  }

  if (timedOut || status === "unknown") {
    return (
      <div className="den-frame-inset grid gap-3 rounded-[1.5rem] px-4 py-3 text-sm text-[var(--dls-text-secondary)]" data-testid="desktop-handoff-troubleshoot" aria-live="polite">
        <p className="m-0">
          Nothing opened?{" "}
          <button type="button" className="font-medium text-[var(--dls-text-primary)] underline-offset-4 hover:underline" onClick={() => window.location.assign(openworkUrl)}>
            Open OpenWork again
          </button>
        </p>
        <div className="grid gap-2">
          <p className="m-0">Still stuck? Paste this sign-in code in OpenWork:</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="den-input min-w-0 flex-1 text-xs" value={openworkUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="den-button-secondary sm:w-auto" onClick={() => void copyOpenworkUrl()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <p className="m-0 text-sm text-[var(--dls-text-secondary)]" aria-live="polite">
      Opening OpenWork now…
    </p>
  );
}

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

  async function handleOpenDesktop() {
    setHandoffBusy(true);
    setActionError(null);

    try {
      const { response, payload } = await requestJson(
        "/v1/auth/desktop-handoff",
        { method: "POST", body: JSON.stringify({ desktopScheme: "openwork" }) },
        12000,
      );
      if (!response.ok) {
        setActionError(getErrorMessage(payload, `Could not prepare OpenWork sign-in (${response.status}).`));
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
      setActionError(error instanceof Error ? error.message : "Could not open OpenWork.");
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

            {desktopOpenworkUrl ? (
              <DesktopHandoffStatus openworkUrl={desktopOpenworkUrl} grant={desktopGrant} organizationName={organizationName} />
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="den-button-primary w-full sm:w-auto"
                  onClick={() => void handleOpenDesktop()}
                  disabled={handoffBusy || installBusy}
                  data-testid="join-org-open-openwork"
                >
                  {handoffBusy ? "Opening OpenWork..." : "Open OpenWork"}
                </button>
                <button
                  type="button"
                  className="den-button-secondary w-full sm:w-auto"
                  onClick={() => void handleGetApp()}
                  disabled={installBusy || handoffBusy}
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
            )}
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
