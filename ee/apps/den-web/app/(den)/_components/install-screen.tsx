"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "../_lib/den-flow";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { buildInstallDownloadHref, type InstallPlatform } from "../_lib/install-download";
import { isMobileUserAgent } from "../_lib/platform";

type InstallConfig = {
  appName: string;
  clientName: string;
  webUrl: string;
  apiUrl: string;
  requireSignin: boolean;
  logoUrl: string | null;
  connectUrl: string | null;
  connectExpiresAt: string | null;
};

const platformOptions: Array<{ value: InstallPlatform; label: string }> = [
  { value: "mac-arm64", label: "Mac (Apple silicon)" },
  { value: "mac-x64", label: "Mac (Intel)" },
  { value: "win-x64", label: "Windows" },
  { value: "linux-x64", label: "Linux (x64)" },
  { value: "linux-arm64", label: "Linux (ARM64)" },
];

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
  const connectUrl = value.connectUrl ?? null;
  const connectExpiresAt = value.connectExpiresAt ?? null;

  if (!clientName || !isUrl(webUrl) || !isUrl(apiUrl) || typeof requireSignin !== "boolean") {
    return null;
  }
  if (logoUrl !== null && (typeof logoUrl !== "string" || !isUrl(logoUrl))) {
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

function detectPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") {
    return "mac-arm64";
  }

  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "win-x64";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return userAgent.includes("aarch64") || userAgent.includes("arm64") ? "linux-arm64" : "linux-x64";
  }
  return "mac-arm64";
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
  const [platform, setPlatform] = useState<InstallPlatform>("mac-arm64");
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "preparing" | "started">("idle");
  const [downloadLabel, setDownloadLabel] = useState("");
  const [downloadHref, setDownloadHref] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectRecoveryVisible, setConnectRecoveryVisible] = useState(false);
  const [connectCopying, setConnectCopying] = useState(false);
  const [connectCopied, setConnectCopied] = useState(false);
  const [guideStep, setGuideStep] = useState<1 | 2 | 3>(() => {
    const requestedStep = searchParams.get("step");
    return requestedStep === "3" ? 3 : requestedStep === "2" ? 2 : 1;
  });
  const downloadStartedTimer = useRef<number | null>(null);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    setPlatform(detectPlatform());
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

  const secondaryPlatforms = useMemo(() => platformOptions.filter((option) => option.value !== platform), [platform]);

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(window.location.href);
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

  function advanceGuide(nextStep: 2 | 3) {
    setGuideStep(nextStep);
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(nextStep));
    window.history.replaceState(null, "", url);
  }

  function beginGuidedDownload() {
    advanceGuide(2);
  }

  async function beginConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      // Mint immediately before opening the app. The default exchange link is
      // intentionally short lived, while installing can take several minutes.
      const freshConfig = await fetchInstallConfig(token);
      if (!freshConfig.connectUrl) {
        throw new Error("This deployment could not create a desktop connection link.");
      }
      setConfig(freshConfig);
      advanceGuide(3);
      window.location.href = freshConfig.connectUrl;
    } catch (connectFailure) {
      setConnectError(connectFailure instanceof Error
        ? connectFailure.message
        : "Could not create a fresh desktop connection. Try again.");
    } finally {
      setConnecting(false);
    }
  }

  async function copyConnectionLink() {
    setConnectCopying(true);
    setConnectCopied(false);
    setConnectError(null);
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard is not available in this browser.");
      }
      const freshConfig = await fetchInstallConfig(token);
      if (!freshConfig.connectUrl) {
        throw new Error("This deployment could not create a desktop connection link.");
      }
      setConfig(freshConfig);
      await navigator.clipboard.writeText(freshConfig.connectUrl);
      setConnectCopied(true);
      window.setTimeout(() => setConnectCopied(false), 1800);
    } catch (copyFailure) {
      setConnectError(copyFailure instanceof Error
        ? copyFailure.message
        : "Could not copy a fresh desktop connection link. Try again.");
    } finally {
      setConnectCopying(false);
    }
  }

  if (busy) {
    return (
      <section className="den-page grid min-h-dvh place-items-center py-4 lg:py-6" data-testid="install-page">
        <div className="den-frame grid w-full max-w-[44rem] gap-4 p-6 md:p-8">
          <p className="den-eyebrow">OpenWork Desktop</p>
          <h1 className="den-title-lg">Loading your install link.</h1>
          <p className="den-copy">Checking your team's OpenWork setup...</p>
        </div>
      </section>
    );
  }

  if (!config) {
    return (
      <section className="den-page grid min-h-dvh place-items-center py-4 lg:py-6" data-testid="install-page">
        <div className="den-frame grid w-full max-w-[44rem] gap-6 p-6 md:p-8">
          <div className="grid gap-2">
            <p className="den-eyebrow">OpenWork Desktop</p>
            <h1 className="den-title-lg">This install link can't be opened.</h1>
            <p className="den-copy">{error ?? "Ask your workspace admin for a fresh install link."}</p>
          </div>
        </div>
      </section>
    );
  }

  const primaryHref = installHref(config, platform, token);
  const primaryLabel = platformOptions.find((option) => option.value === platform)?.label ?? "your computer";

  return (
    <section className="den-page grid min-h-dvh place-items-center py-4 lg:py-6" data-testid="install-page">
      <div className="den-frame grid w-full max-w-[44rem] gap-6 p-6 text-center md:p-8" data-testid="install-card">
        <div className="grid justify-items-center gap-3">
          <p className="den-eyebrow">{config.appName} Desktop</p>
          {config.logoUrl ? (
            // Organization logos may be served by private on-prem hosts that
            // are intentionally absent from this deployment's image allowlist.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={config.logoUrl} alt={`${config.clientName} wordmark`} className="max-h-16 max-w-64 object-contain object-center" />
          ) : null}
          <h1 className="den-title-xl">Download {config.appName} for {config.clientName}</h1>
          <p className="den-copy">
            Den will stay on this page while you install the standard {config.appName} app, connect it to {config.clientName}, and sign in.
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
        ) : config.connectUrl ? (
          <ol className="grid gap-3 text-left" data-testid="install-guide">
            <li
              className="den-frame-inset grid grid-cols-[2rem_1fr] gap-3 rounded-[1.25rem] p-4"
              data-state={guideStep === 1 ? "active" : "complete"}
              data-testid="install-guide-step-download"
            >
              <span className="grid size-8 place-items-center rounded-full bg-[var(--dls-accent)] font-semibold text-white" aria-hidden="true">
                {guideStep > 1 ? "✓" : "1"}
              </span>
              <div className="grid gap-3">
                <div>
                  <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Download and install</p>
                  <p className="den-copy">Run the normal signed installer. When installation finishes, return to this page.</p>
                </div>
                {guideStep === 1 ? (
                  <div className="grid gap-3">
                    <a
                      className="den-button-primary w-full justify-center sm:w-fit"
                      href={primaryHref}
                      data-testid="install-download-primary"
                      onClick={beginGuidedDownload}
                    >
                      Download for {primaryLabel}
                    </a>
                    <div className="flex flex-wrap gap-2">
                      {secondaryPlatforms.map((option) => (
                        <a
                          key={option.value}
                          className="den-button-secondary"
                          href={installHref(config, option.value, token)}
                          onClick={beginGuidedDownload}
                        >
                          {option.label}
                        </a>
                      ))}
                      <button type="button" className="den-button-secondary" onClick={() => advanceGuide(2)} data-testid="install-skip-download">
                        I already have {config.appName}
                      </button>
                    </div>
                  </div>
                ) : (
                  <a className="w-fit text-sm font-medium text-[var(--dls-accent)] underline-offset-4 hover:underline" href={primaryHref}>
                    Download again
                  </a>
                )}
              </div>
            </li>

            <li
              className="den-frame-inset grid grid-cols-[2rem_1fr] gap-3 rounded-[1.25rem] p-4"
              data-state={guideStep === 2 ? "active" : guideStep > 2 ? "complete" : "pending"}
              data-testid="install-guide-step-open"
            >
              <span className="grid size-8 place-items-center rounded-full border border-[var(--dls-border-strong)] font-semibold text-[var(--dls-text-primary)]" aria-hidden="true">
                {guideStep > 2 ? "✓" : "2"}
              </span>
              <div className="grid gap-3">
                <div>
                  <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Open {config.appName}</p>
                  <p className="den-copy">
                    {guideStep === 1
                      ? `Only continue once ${config.appName} is installed and running on this computer.`
                      : `Open the app and confirm that you want to connect it to ${config.clientName}.`}
                  </p>
                </div>
                {guideStep >= 2 ? (
                  <div className="grid gap-2">
                    <button
                      type="button"
                      className="den-button-primary w-full justify-center sm:w-fit"
                      data-testid="install-connect-open"
                      disabled={connecting}
                      onClick={() => void beginConnect()}
                    >
                      {connecting ? "Preparing connection…" : `Open ${config.appName}`}
                    </button>
                    <button
                      type="button"
                      className="w-fit text-sm text-[var(--dls-text-secondary)] underline-offset-4 hover:underline"
                      data-testid="install-connect-recovery"
                      onClick={() => setConnectRecoveryVisible(true)}
                    >
                      Didn&apos;t open?
                    </button>
                    {connectRecoveryVisible ? (
                      <div className="den-frame-inset grid gap-3 rounded-[1rem] p-3">
                        <p className="den-copy text-sm">
                          Copy a fresh connection link and open it anywhere links work, like your browser&apos;s address bar. The same confirmation will appear.
                        </p>
                        <button
                          type="button"
                          className="den-button-secondary w-full justify-center sm:w-fit"
                          data-testid="install-connect-copy"
                          disabled={connectCopying}
                          onClick={() => void copyConnectionLink()}
                        >
                          {connectCopying ? "Copying..." : connectCopied ? "Copied" : "Copy connection link"}
                        </button>
                      </div>
                    ) : null}
                    {connectError ? (
                      <p className="m-0 text-sm text-red-600" role="alert" data-testid="install-connect-error">
                        {connectError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>

            <li
              className="den-frame-inset grid grid-cols-[2rem_1fr] gap-3 rounded-[1.25rem] p-4"
              data-state={guideStep === 3 ? "active" : "pending"}
              data-testid="install-guide-step-signin"
            >
              <span className="grid size-8 place-items-center rounded-full border border-[var(--dls-border-strong)] font-semibold text-[var(--dls-text-primary)]" aria-hidden="true">3</span>
              <div>
                <p className="m-0 font-semibold text-[var(--dls-text-primary)]">Sign in</p>
                <p className="den-copy">
                  {guideStep === 3
                    ? `Continue in ${config.appName}, confirm ${config.clientName}, and complete the normal organization sign-in.`
                    : `After the app connects, sign in to ${config.clientName}.`}
                </p>
              </div>
            </li>
          </ol>
        ) : (
          <div className="grid justify-items-center gap-4">
            <div className="den-frame-inset grid gap-2 rounded-[1.25rem] p-4 text-left" role="status">
              <p className="m-0 font-medium text-[var(--dls-text-primary)]">This deployment still uses bundled workspace setup.</p>
              <p className="den-copy">Ask an administrator to configure signed desktop handoffs to use the guided standard-installer flow.</p>
            </div>
            <a className="den-button-primary w-full justify-center sm:w-auto" href={primaryHref} data-testid="install-download-primary" onClick={() => beginDownload(primaryLabel, primaryHref)}>
              Download for {primaryLabel}
            </a>
            <div className="flex flex-wrap justify-center gap-2">
              {secondaryPlatforms.map((option) => (
                <a key={option.value} className="den-button-secondary" href={installHref(config, option.value, token)} onClick={() => beginDownload(option.label, installHref(config, option.value, token))}>
                  {option.label}
                </a>
              ))}
            </div>
            {downloadState !== "idle" ? (
              <div className="den-frame-inset grid w-full justify-items-center gap-2 rounded-[1.25rem] p-4" aria-live="polite" data-testid="install-download-status">
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
                    <a className="den-button-secondary" href={downloadHref} onClick={() => beginDownload(downloadLabel, downloadHref)}>
                      Try again
                    </a>
                  </>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
