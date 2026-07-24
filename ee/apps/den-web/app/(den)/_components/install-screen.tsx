"use client";

import { DownloadPlatformGrid, type DownloadPlatformGroup, type DownloadPlatformOption } from "@openwork/ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "../_lib/den-flow";
import { LAST_DESKTOP_HANDOFF_GRANT_STORAGE_KEY, readLastDesktopHandoffGrant } from "../_lib/desktop-handoff";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { buildInstallDownloadHref, type InstallPlatform } from "../_lib/install-download";
import { isMobileUserAgent } from "../_lib/platform";
import { useDesktopHandoffStatus } from "../_lib/use-desktop-handoff-status";
import { OnboardingShell } from "./onboarding-shell";
import { OrganizationBrandIdentity } from "./organization-brand-identity";

type InstallConfig = {
  appName: string;
  clientName: string;
  webUrl: string;
  apiUrl: string;
  requireSignin: boolean;
  logoUrl: string | null;
  iconUrl: string | null;
  connectUrl: string | null;
  connectExpiresAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isConnectUrl(value: string) {
  try {
    const url = new URL(value);
    const route = (url.hostname || url.pathname.replace(/^\/+|\/+$/g, "")).toLowerCase();
    if (url.protocol !== "openwork:" || route !== "connect") return false;
    const token = url.searchParams.get("token")?.trim() ?? "";
    const code = url.searchParams.get("code")?.trim() ?? "";
    const apiBaseUrl = url.searchParams.get("apiBaseUrl")?.trim() ?? "";
    return (Boolean(token) && !code && !apiBaseUrl)
      || (!token && /^[A-Za-z0-9_-]{24,128}$/.test(code) && isUrl(apiBaseUrl));
  } catch {
    return false;
  }
}

function parseInstallConfig(value: unknown): InstallConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const clientName = typeof value.clientName === "string" ? value.clientName.trim() : "";
  const appName = typeof value.appName === "string" && value.appName.trim() ? value.appName.trim() : "OpenWork";
  const webUrl = typeof value.webUrl === "string" ? value.webUrl.trim() : "";
  const apiUrl = typeof value.apiUrl === "string" ? value.apiUrl.trim() : "";
  const requireSignin = value.requireSignin;
  const logoUrl = value.logoUrl;
  const iconUrl = value.iconUrl ?? null;
  const connectUrl = value.connectUrl ?? null;
  const connectExpiresAt = value.connectExpiresAt ?? null;

  if (!clientName || !isUrl(webUrl) || !isUrl(apiUrl) || typeof requireSignin !== "boolean") {
    return null;
  }
  if (logoUrl !== null && (typeof logoUrl !== "string" || !isUrl(logoUrl))) {
    return null;
  }
  if (iconUrl !== null && (typeof iconUrl !== "string" || !isUrl(iconUrl))) {
    return null;
  }
  if (connectUrl !== null && (typeof connectUrl !== "string" || !isConnectUrl(connectUrl))) {
    return null;
  }
  if (connectExpiresAt !== null && (typeof connectExpiresAt !== "string" || Number.isNaN(Date.parse(connectExpiresAt)))) {
    return null;
  }

  return {
    appName,
    clientName,
    webUrl,
    apiUrl,
    requireSignin,
    logoUrl,
    iconUrl,
    connectUrl,
    connectExpiresAt,
  };
}

async function fetchInstallConfig(token: string) {
  const { response, payload } = await requestJson(
    `/v1/install-config?token=${encodeURIComponent(token)}`,
    { method: "GET" },
    12000,
  );
  if (!response.ok) {
    throw new Error(getInstallConfigErrorMessage(payload, response.status));
  }
  const parsed = parseInstallConfig(payload);
  if (!parsed) {
    throw new Error("This install link returned incomplete setup details.");
  }
  return parsed;
}

function installHref(config: InstallConfig, platform: InstallPlatform, token: string) {
  return buildInstallDownloadHref(config.apiUrl, platform, token);
}

export function InstallScreen() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [config, setConfig] = useState<InstallConfig | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "preparing" | "started">("idle");
  const [downloadLabel, setDownloadLabel] = useState("");
  const [downloadHref, setDownloadHref] = useState("");
  const [currentLink, setCurrentLink] = useState("");
  const [handoffGrant, setHandoffGrant] = useState<string | null>(null);
  const downloadStartedTimer = useRef<number | null>(null);
  const handoffStatus = useDesktopHandoffStatus(handoffGrant);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    setCurrentLink(window.location.href);
  }, []);

  useEffect(() => {
    function refreshLastHandoffGrant() {
      setHandoffGrant(readLastDesktopHandoffGrant());
    }

    refreshLastHandoffGrant();

    function handleStorage(event: StorageEvent) {
      if (event.key === LAST_DESKTOP_HANDOFF_GRANT_STORAGE_KEY) {
        refreshLastHandoffGrant();
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      if (!token) {
        setError("This install link is missing its token. Ask your organization admin for a fresh link.");
        setBusy(false);
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const parsed = await fetchInstallConfig(token);
        if (cancelled) {
          return;
        }
        setConfig(parsed);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not load this install link.");
          setConfig(null);
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => () => {
    if (downloadStartedTimer.current !== null) {
      window.clearTimeout(downloadStartedTimer.current);
    }
  }, []);

  const downloadGroups = useMemo<DownloadPlatformGroup[]>(() => {
    if (!config) {
      return [];
    }

    return [
      {
        os: "macos",
        title: "macOS",
        options: [
          { href: installHref(config, "mac-arm64", token), label: "Apple Silicon (M1+)", arch: "arm64" },
          { href: installHref(config, "mac-x64", token), label: "Intel", arch: "x64" },
        ],
      },
      {
        os: "windows",
        title: "Windows",
        options: [
          { href: installHref(config, "win-x64", token), label: "x64 Installer", arch: "x64" },
        ],
      },
      {
        os: "linux",
        title: "Linux",
        options: [
          { href: installHref(config, "linux-x64", token), label: "Setup script (x64)", arch: "x64" },
          { href: installHref(config, "linux-arm64", token), label: "Setup script (ARM64)", arch: "arm64" },
        ],
      },
    ];
  }, [config, token]);

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(currentLink || window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function beginDownload(label: string, href: string) {
    setDownloadLabel(label);
    setDownloadHref(href);
    setDownloadState("preparing");
    if (downloadStartedTimer.current !== null) {
      window.clearTimeout(downloadStartedTimer.current);
    }
    downloadStartedTimer.current = window.setTimeout(() => {
      setDownloadState("started");
      downloadStartedTimer.current = null;
    }, 5000);
  }

  if (busy) {
    return (
      <OnboardingShell state="install-loading" width="wide">
        <section className="grid gap-4 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 md:p-8" data-testid="install-page">
          <p className="den-eyebrow">OpenWork Desktop</p>
          <h1 className="den-title-lg">Loading your install link.</h1>
          <p className="den-copy">Checking your team's OpenWork setup...</p>
        </section>
      </OnboardingShell>
    );
  }

  if (!config) {
    return (
      <OnboardingShell state="install-error" width="wide">
        <section className="grid gap-6 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 md:p-8" data-testid="install-page">
          <div className="grid gap-2">
            <p className="den-eyebrow">OpenWork Desktop</p>
            <h1 className="den-title-lg">This install link can't be opened.</h1>
            <p className="den-copy">{error ?? "Ask your workspace admin for a fresh install link."}</p>
          </div>
        </section>
      </OnboardingShell>
    );
  }

  const showInstallTroubleshoot = handoffGrant !== null
    && handoffStatus.status !== "consumed"
    && (handoffStatus.timedOut || handoffStatus.status === "unknown");

  return (
    <OnboardingShell state="install" width="full">
      <section data-testid="install-page">
        <div className="grid gap-6 rounded-[1.75rem] border border-slate-200/80 bg-white p-5 text-center sm:p-6 md:p-8" data-testid="install-card">
          <div className="grid justify-items-center gap-3">
            <h1 className="m-0 grid max-w-[22ch] gap-1 text-[2rem] font-semibold leading-[1.04] tracking-[-0.05em] text-slate-950 sm:text-[2.4rem]">
              <span>Download OpenWork</span>
              <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-[0.18em] gap-y-1">
                <span>for</span>
                <OrganizationBrandIdentity
                  organizationName={config.clientName}
                  brand={{ appName: config.appName, logoUrl: config.logoUrl, iconUrl: config.iconUrl }}
                />
              </span>
            </h1>
            <p className="den-copy">
              This page walks you through connecting this computer to {config.clientName}.
            </p>
          </div>

        {isMobile ? (
          <div className="den-frame-inset grid gap-3 rounded-[1.5rem] p-5" data-testid="install-mobile-note">
            <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">{config.appName} runs on your computer.</p>
            <p className="den-copy">Open this link on your Mac, Windows, or Linux machine. You can also copy it and send it to yourself.</p>
            <button type="button" className="den-button-secondary w-full sm:w-auto" onClick={() => void copyCurrentLink()}>
              {copied ? "Copied" : "Copy install link"}
            </button>
          </div>
        ) : (
          <ol className="grid gap-3 text-left" data-testid="install-guide">
            <li
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-[1.25rem] bg-slate-50 p-4 sm:p-5"
              data-testid="install-guide-step-download"
            >
              <span className="grid size-8 place-items-center rounded-full bg-[var(--dls-accent)] font-semibold text-white" aria-hidden="true">
                1
              </span>
              <div className="grid gap-3">
                <div>
                  <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Download the OpenWork installer</p>
                  <p className="den-copy">It&apos;s a small setup app. When the download finishes, open it and keep this page open.</p>
                </div>
                <div className="grid gap-3">
                  <DownloadPlatformGrid
                    groups={downloadGroups}
                    recommendedTestId="install-download-primary"
                    onDownload={(option: DownloadPlatformOption) => beginDownload(option.label, option.href)}
                  />
                  {downloadState !== "idle" ? (
                    <div className="den-frame-inset grid gap-2 rounded-[1.25rem] p-4" aria-live="polite" data-testid="install-download-status">
                      {downloadState === "preparing" ? (
                        <>
                          <span className="size-5 animate-spin rounded-full border-2 border-[var(--dls-border-strong)] border-t-[var(--dls-accent)]" aria-hidden="true" />
                          <p className="m-0 font-medium text-[var(--dls-text-primary)]">Preparing your {downloadLabel} download...</p>
                          <p className="den-copy">The first download may take up to a minute. Your browser will begin downloading when it is ready.</p>
                        </>
                      ) : (
                        <>
                          <p className="m-0 font-medium text-[var(--dls-text-primary)]">Download started</p>
                          <p className="den-copy">Your browser is preparing the file. If it does not appear, try the download again.</p>
                          <a className="den-button-secondary w-fit" href={downloadHref} onClick={() => beginDownload(downloadLabel, downloadHref)}>
                            Try again
                          </a>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </li>

            <li
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-[1.25rem] bg-slate-50 p-4 sm:p-5"
              data-testid="install-guide-step-open"
            >
              <span className="grid size-8 place-items-center rounded-full border border-[var(--dls-border-strong)] font-semibold text-[var(--dls-text-primary)]" aria-hidden="true">
                2
              </span>
              <div className="grid gap-3">
                <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Open the installer and paste this link:</p>
                <div className="grid gap-2" data-testid="install-copy-link">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input className="den-input min-w-0 flex-1 text-xs" value={currentLink} readOnly onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" className="den-button-secondary sm:w-auto" onClick={() => void copyCurrentLink()}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                  </div>
                </div>
                <p className="den-copy">The installer only continues with a valid link — that&apos;s what connects this computer to {config.clientName}.</p>
              </div>
            </li>

            <li
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-[1.25rem] bg-slate-50 p-4 sm:p-5"
              data-testid="install-guide-step-signin"
            >
              <span className="grid size-8 place-items-center rounded-full border border-[var(--dls-border-strong)] font-semibold text-[var(--dls-text-primary)]" aria-hidden="true">3</span>
              <div className="grid gap-3">
                <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Sign in — this page will confirm when you&apos;re connected.</p>
                <div className="den-frame-inset grid gap-2 rounded-[1rem] p-3" aria-live="polite">
                  {handoffStatus.status === "consumed" ? (
                    <p className="m-0 text-sm font-medium text-emerald-700" data-testid="install-connected">✓ Connected — OpenWork is set up for {config.clientName}</p>
                  ) : (
                    <p className="m-0 text-sm text-[var(--dls-text-secondary)]">Waiting for sign-in…</p>
                  )}
                  {showInstallTroubleshoot ? (
                    <p className="m-0 text-sm text-[var(--dls-text-secondary)]">
                      Still not connected? If the app is not installed, start with step 1. If nothing opened, try the sign-in tab again.
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          </ol>
        )}
        </div>
      </section>
    </OnboardingShell>
  );
}
