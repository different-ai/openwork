"use client";

import { detectPlatform, DownloadPlatformGrid, type DetectedPlatform, type DownloadPlatformGroup, type DownloadPlatformOption } from "@openwork/ui/react";
import { Check, ChevronDown, Download, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "../_lib/den-flow";
import {
  getDesktopHandoffGrant,
  getDesktopHandoffOpenworkUrl,
  rememberDesktopHandoffGrant,
} from "../_lib/desktop-handoff";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { CONFIRM_RUNNING_STEP, parseGuideStep, TOTAL_GUIDE_STEPS, type GuideStep } from "../_lib/install-guide";
import { buildInstallDownloadHref, type InstallPlatform, installerFileName } from "../_lib/install-download";
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
  activationUrl: string;
  activationExpiresAt: string;
  desktopVersion: string;
  distribution: "cloud" | "enterprise";
};

const RETURN_TO_OPENWORK_URL = "openwork://open";
const INSTALL_PLATFORMS: InstallPlatform[] = ["mac-arm64", "mac-x64", "win-x64", "linux-x64", "linux-arm64"];


type InstallerOs = "macos" | "windows" | "linux";

type OpenGuidance = {
  actions: [string, string];
  trust: { title: string; body: string } | null;
};

function detectedInstallPlatform(detected: DetectedPlatform | null): InstallPlatform | null {
  if (!detected) return null;
  if (detected.os === "windows") return "win-x64";
  if (detected.os === "macos" && detected.arch === "arm64") return "mac-arm64";
  if (detected.os === "macos" && detected.arch === "x64") return "mac-x64";
  if (detected.os === "linux" && detected.arch === "arm64") return "linux-arm64";
  if (detected.os === "linux") return "linux-x64";
  return null;
}

function installerOsFor(platform: InstallPlatform | null, detected: DetectedPlatform | null): InstallerOs | null {
  if (platform) {
    if (platform.startsWith("mac-")) return "macos";
    return platform === "win-x64" ? "windows" : "linux";
  }
  return detected?.os ?? null;
}

/** Copy for opening the downloaded installer, per operating system. */
function openGuidance(os: InstallerOs | null, fileName: string | null): OpenGuidance {
  const openFile = fileName
    ? `Double-click ${fileName} in Downloads.`
    : "Open the OpenWork Enterprise download in your Downloads folder.";

  if (os === "macos") {
    return {
      actions: [openFile, "Drag OpenWork Enterprise to Applications, then open it."],
      trust: {
        title: "macOS confirms apps downloaded from the internet",
        body: "Choose Open when macOS asks you to confirm the signed OpenWork Enterprise app.",
      },
    };
  }
  if (os === "windows") {
    return {
      actions: [openFile, "Complete the OpenWork Enterprise setup, then open the app."],
      trust: {
        title: "Windows may warn before it opens the installer",
        body: "If you see “Windows protected your PC”, choose More info, then Run anyway.",
      },
    };
  }
  if (os === "linux") {
    return {
      actions: [
        "Make the downloaded AppImage executable.",
        "Open the OpenWork Enterprise AppImage.",
      ],
      trust: null,
    };
  }
  return {
    actions: [openFile, `Choose Install in the installer window.`],
    trust: {
      title: "Your computer may ask before it opens the installer",
      body: "If you see a warning about an app from the internet, choose to open it anyway. This is normal for a new app.",
    },
  };
}

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
  const activationUrl = typeof value.activationUrl === "string" ? value.activationUrl.trim() : "";
  const activationExpiresAt = typeof value.activationExpiresAt === "string" ? value.activationExpiresAt : "";
  const desktopVersion = typeof value.desktopVersion === "string" ? value.desktopVersion.trim() : "";
  const distribution = value.distribution;

  if (!clientName || !isUrl(webUrl) || !isUrl(apiUrl) || typeof requireSignin !== "boolean") {
    return null;
  }
  if (logoUrl !== null && (typeof logoUrl !== "string" || !isUrl(logoUrl))) {
    return null;
  }
  if (iconUrl !== null && (typeof iconUrl !== "string" || !isUrl(iconUrl))) {
    return null;
  }
  if (connectUrl !== null && typeof connectUrl !== "string") {
    return null;
  }
  if (connectExpiresAt !== null && (typeof connectExpiresAt !== "string" || Number.isNaN(Date.parse(connectExpiresAt)))) {
    return null;
  }
  if (
    !isUrl(activationUrl)
    || Number.isNaN(Date.parse(activationExpiresAt))
    || !desktopVersion
    || (distribution !== "cloud" && distribution !== "enterprise")
  ) {
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
    activationUrl,
    activationExpiresAt,
    desktopVersion,
    distribution,
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

type StepState = "complete" | "active" | "pending";

const STEP_SHELL: Record<StepState, string> = {
  complete: "border-[#e7eaef] bg-[#fafbfc]",
  active: "border-[#b9cafa] bg-[#f8faff] shadow-[0_12px_30px_rgba(62,99,221,0.08)]",
  pending: "border-[#e1e4e8] bg-[#f7f8fa]",
};

const STEP_BADGE: Record<StepState, string> = {
  complete: "border-[1.5px] border-[#c9cfd7] bg-white text-[#7a828e]",
  active: "bg-[#101828] text-white",
  pending: "border-[1.5px] border-[#101828] text-[#101828]",
};

function InstallStep({
  index,
  state,
  title,
  description,
  expanded,
  onExpand,
  testId,
  children,
}: {
  index: number;
  state: StepState;
  title: string;
  description: string;
  expanded: boolean;
  onExpand: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <li className={`rounded-[18px] border ${STEP_SHELL[state]}`} data-state={state} data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-start gap-4 p-5 text-left disabled:cursor-default sm:px-7 sm:py-6"
        aria-expanded={expanded}
        disabled={state === "pending"}
        onClick={onExpand}
      >
        <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${STEP_BADGE[state]}`} aria-hidden="true">
          {state === "complete" ? "✓" : index}
        </span>
        <span className="grid grow gap-1">
          <span className={`text-base font-semibold ${state === "complete" ? "text-[#667085]" : "text-[#101828]"}`}>{title}</span>
          {expanded ? <span className="text-[13px] leading-5 text-[#60646c]">{description}</span> : null}
        </span>
        <ChevronDown className={`mt-0.5 size-5 shrink-0 text-[#667085] ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {expanded ? <div className="grid gap-4 px-5 pb-5 sm:pb-6 sm:pl-[4.25rem] sm:pr-7">{children}</div> : null}
    </li>
  );
}

function CopyLinkRow({
  value,
  copied,
  onCopy,
  testId,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-[#e1e4e8] bg-[#fafbfc] px-3 py-2.5" data-testid={testId}>
      <input
        className="min-w-0 grow bg-transparent text-[11px] text-[#344054] outline-none"
        value={value}
        readOnly
        onFocus={(event) => event.currentTarget.select()}
      />
      <button type="button" className="shrink-0 text-[11px] font-semibold text-[#101828] hover:underline" onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
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
  const [downloadPlatform, setDownloadPlatform] = useState<InstallPlatform | null>(null);
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);
  const [currentLink, setCurrentLink] = useState("");
  const initialStep = parseGuideStep(searchParams.get("step"));
  const [guideStep, setGuideStep] = useState<GuideStep>(initialStep);
  const [expandedStep, setExpandedStep] = useState<GuideStep>(initialStep);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [desktopGrant, setDesktopGrant] = useState<string | null>(null);
  const [connectLink, setConnectLink] = useState("");
  const [connectCopied, setConnectCopied] = useState(false);
  const [returnCopied, setReturnCopied] = useState(false);
  const downloadStartedTimer = useRef<number | null>(null);
  const handoffStatus = useDesktopHandoffStatus(desktopGrant);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    setCurrentLink(window.location.href);
    let cancelled = false;
    void detectPlatform().then((platform) => {
      if (!cancelled) setDetected(platform);
    });
    return () => {
      cancelled = true;
    };
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
          { href: installHref(config, "win-x64", token), label: "x64 app", arch: "x64" },
        ],
      },
      {
        os: "linux",
        title: "Linux",
        options: [
          { href: installHref(config, "linux-x64", token), label: "AppImage (x64)", arch: "x64" },
          { href: installHref(config, "linux-arm64", token), label: "AppImage (ARM64)", arch: "arm64" },
        ],
      },
    ];
  }, [config, token]);

  const platformByHref = useMemo<Record<string, InstallPlatform>>(() => {
    if (!config) {
      return {};
    }
    return Object.fromEntries(INSTALL_PLATFORMS.map((platform) => [installHref(config, platform, token), platform]));
  }, [config, token]);

  async function copyCurrentLink() {
    try {
      await navigator.clipboard.writeText(currentLink || window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setConnectError("Could not copy automatically. Select the install link and copy it manually.");
    }
  }

  function advanceGuide(nextStep: 2 | 3 | 4) {
    setGuideStep(nextStep);
    setExpandedStep(nextStep);
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(nextStep));
    window.history.replaceState(null, "", url);
  }

  function beginDownload(label: string, href: string) {
    setDownloadLabel(label);
    setDownloadHref(href);
    setDownloadPlatform(platformByHref[href] ?? null);
    setDownloadState("preparing");
    advanceGuide(2);
    if (downloadStartedTimer.current !== null) {
      window.clearTimeout(downloadStartedTimer.current);
    }
    downloadStartedTimer.current = window.setTimeout(() => {
      setDownloadState("started");
      downloadStartedTimer.current = null;
    }, 5000);
  }

  async function beginConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/auth/desktop-handoff",
        {
          method: "POST",
          body: JSON.stringify({ desktopScheme: "openwork" }),
        },
        12000,
      );
      if (!response.ok) {
        throw new Error(response.status === 401
          ? "Sign in to your Den portal before activating OpenWork Enterprise."
          : `Could not create an activation link (${response.status}).`);
      }
      const nextConnectLink = getDesktopHandoffOpenworkUrl(payload);
      const grant = getDesktopHandoffGrant(payload, nextConnectLink);
      if (!nextConnectLink || !grant) {
        throw new Error("Den did not return a valid OpenWork Enterprise activation link.");
      }
      rememberDesktopHandoffGrant(grant);
      setDesktopGrant(grant);
      setConnectLink(nextConnectLink);
      advanceGuide(4);
      window.location.assign(nextConnectLink);
    } catch (connectFailure) {
      setConnectError(connectFailure instanceof Error ? connectFailure.message : "Could not open OpenWork. Try again.");
    } finally {
      setConnecting(false);
    }
  }

  async function copyConnectionLink() {
    try {
      await navigator.clipboard.writeText(connectLink);
      setConnectCopied(true);
      window.setTimeout(() => setConnectCopied(false), 1800);
    } catch {
      setConnectError("Could not copy automatically. Select the OpenWork link and copy it manually.");
    }
  }

  async function prepareAndCopyConnectionLink() {
    setConnecting(true);
    setConnectError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/auth/desktop-handoff",
        {
          method: "POST",
          body: JSON.stringify({ desktopScheme: "openwork" }),
        },
        12000,
      );
      if (!response.ok) {
        throw new Error(response.status === 401
          ? "Sign in to your Den portal before creating an activation link."
          : `Could not create an activation link (${response.status}).`);
      }
      const nextConnectLink = getDesktopHandoffOpenworkUrl(payload);
      const grant = getDesktopHandoffGrant(payload, nextConnectLink);
      if (!nextConnectLink || !grant) {
        throw new Error("Den did not return a valid OpenWork Enterprise activation link.");
      }
      rememberDesktopHandoffGrant(grant);
      setDesktopGrant(grant);
      setConnectLink(nextConnectLink);
      await navigator.clipboard.writeText(nextConnectLink);
      setConnectCopied(true);
      window.setTimeout(() => setConnectCopied(false), 1800);
    } catch (copyFailure) {
      setConnectError(copyFailure instanceof Error ? copyFailure.message : "Could not copy a fresh OpenWork link.");
    } finally {
      setConnecting(false);
    }
  }

  async function copyReturnLink() {
    try {
      await navigator.clipboard.writeText(RETURN_TO_OPENWORK_URL);
      setReturnCopied(true);
      window.setTimeout(() => setReturnCopied(false), 1800);
    } catch {
      setConnectError("Could not copy automatically. Select the OpenWork link and copy it manually.");
    }
  }

  if (busy) {
    return (
      <OnboardingShell state="install-loading" width="wide" background="surface">
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
      <OnboardingShell state="install-error" width="wide" background="surface">
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

  if (config.distribution === "cloud") {
    return (
      <OnboardingShell state="install" width="full" background="surface">
        <section data-testid="install-page">
          <div className="grid gap-6 rounded-[1.75rem] border border-[#e7eaef] bg-[#fcfcfd] p-5 text-center sm:p-6 md:p-8" data-testid="install-card">
            <div className="grid justify-items-center gap-3">
              <h1 className="m-0 text-[2rem] font-semibold leading-[1.04] tracking-[-0.05em] text-slate-950 sm:text-[2.4rem]">
                Download OpenWork
              </h1>
              <p className="den-copy max-w-2xl">Choose the version for your computer, install it, and open OpenWork.</p>
            </div>

            {isMobile ? (
              <div className="den-frame-inset grid gap-3 rounded-[1.5rem] p-5 text-left" data-testid="install-mobile-note">
                <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">OpenWork Cloud runs on your computer.</p>
                <p className="den-copy">Open this link on your Mac, Windows, or Linux machine.</p>
                <button type="button" className="den-button-secondary w-full sm:w-auto" onClick={() => void copyCurrentLink()}>
                  {copied ? "Copied" : "Copy install link"}
                </button>
              </div>
            ) : (
              <div className="grid gap-5 text-left">
                <DownloadPlatformGrid groups={downloadGroups} />
                <a className="den-button-secondary w-fit" href={RETURN_TO_OPENWORK_URL}>
                  I already installed OpenWork
                </a>
              </div>
            )}
          </div>
        </section>
      </OnboardingShell>
    );
  }

  const installerFile = installerFileName(
    downloadPlatform ?? detectedInstallPlatform(detected),
    config.desktopVersion,
  );
  const guidance = openGuidance(installerOsFor(downloadPlatform, detected), installerFile);

  return (
    <OnboardingShell state="install" width="full" background="surface">
      <section data-testid="install-page">
        <div className="grid gap-6 rounded-[1.75rem] border border-[#e1e5eb] bg-white p-5 text-center shadow-[0_18px_55px_rgba(16,24,40,0.06)] sm:p-6 md:p-8" data-testid="install-card">
          <div className="grid justify-items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-[#d3e0fb] bg-[#f4f7ff] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#3e63dd]">
              <span className="size-1.5 rounded-full bg-[#3e63dd]" aria-hidden="true" />
              Step {guideStep} of {TOTAL_GUIDE_STEPS}
            </div>
            <h1 className="m-0 grid max-w-[22ch] gap-1 text-[2rem] font-semibold leading-[1.04] tracking-[-0.05em] text-slate-950 sm:text-[2.4rem]">
              <span>Download OpenWork Enterprise</span>
              <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-[0.18em] gap-y-1">
                <span>for</span>
                <OrganizationBrandIdentity
                  organizationName={config.clientName}
                  brand={{ appName: config.appName, logoUrl: config.logoUrl, iconUrl: config.iconUrl }}
                />
              </span>
            </h1>
            <p className="den-copy max-w-xl">Complete one step at a time. We&apos;ll guide you from download to activation.</p>
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
            <InstallStep
              index={1}
              state={guideStep > 1 ? "complete" : "active"}
              title="Download OpenWork Enterprise"
              description="This is the signed desktop app itself. Den sends your browser directly to the matching GitHub release asset."
              expanded={expandedStep === 1}
              onExpand={() => setExpandedStep(1)}
              testId="install-guide-step-download"
            >
                  <DownloadPlatformGrid
                    groups={downloadGroups}
                    recommendedTestId="install-download-primary"
                    onDownload={(option: DownloadPlatformOption) => beginDownload(option.label, option.href)}
                  />
                  <button
                    type="button"
                    className="w-fit text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
                    onClick={() => advanceGuide(2)}
                    data-testid="install-skip-download"
                  >
                    I already have OpenWork Enterprise
                  </button>
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
            </InstallStep>

            <InstallStep
              index={2}
              state={guideStep === 2 ? "active" : guideStep > 2 ? "complete" : "pending"}
              title="Install and open OpenWork Enterprise"
              description={guideStep < 2
                ? "Only continue once the download finished on this computer."
                : "Run the installer, then launch the app."}
              expanded={expandedStep === 2 && guideStep >= 2}
              onExpand={() => setExpandedStep(2)}
              testId="install-guide-step-open"
            >
                  <div className="grid content-start gap-3">
                      {installerFile ? (
                        <div className="flex items-center gap-2.5 rounded-[10px] border border-[#e1e4e8] bg-[#fafbfc] px-3 py-2.5" data-testid="install-file-chip">
                          <span className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-[#e1e4e8] bg-white" aria-hidden="true">
                            <Download className="size-[15px] text-[#344054]" />
                          </span>
                          <span className="grid min-w-0 gap-0.5">
                            <span className="truncate text-[13px] font-semibold text-[#101828]">{installerFile}</span>
                            <span className="text-xs text-[#60646c]">Saved in your Downloads folder</span>
                          </span>
                        </div>
                      ) : null}

                      <ol className="m-0 grid list-none gap-2.5 p-0">
                        {guidance.actions.map((action, index) => (
                          <li key={action} className="flex items-start gap-2.5">
                            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#eef1f5] text-xs font-semibold text-[#344054]" aria-hidden="true">
                              {index + 1}
                            </span>
                            <span className="text-[13px] leading-5 text-[#344054]">{action}</span>
                          </li>
                        ))}
                      </ol>

                      {guidance.trust ? (
                        <p className="m-0 flex items-start gap-2 text-[13px] leading-[17px] text-[#7a5714]" data-testid="install-os-trust-note">
                          <ShieldCheck className="mt-px size-[15px] shrink-0" aria-hidden="true" />
                          {guidance.trust.body}
                        </p>
                      ) : null}

                      <button
                        type="button"
                        className="grid min-h-10 w-fit place-items-center rounded-[9px] bg-[#101828] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-black"
                        data-testid="install-app-ready"
                        onClick={() => advanceGuide(CONFIRM_RUNNING_STEP)}
                      >
                        The app is installed and open
                      </button>
                  </div>
            </InstallStep>

            <InstallStep
              index={3}
              state={guideStep === 3 ? "active" : guideStep > 3 ? "complete" : "pending"}
              title="Confirm the app is running, then activate"
              description={guideStep < 3
                ? "Activation only works while OpenWork Enterprise is open on this computer."
                : "Check both lines below, then send the one-time activation link from this page."}
              expanded={expandedStep === 3 && guideStep >= 3}
              onExpand={() => setExpandedStep(3)}
              testId="install-guide-step-confirm-running"
            >
                  <div className="grid content-start gap-3">
                      <ul className="m-0 grid list-none gap-2 p-0" data-testid="install-running-checklist">
                        {[
                          `${config.appName} is installed and open on this computer.`,
                          "It is waiting on its activation screen.",
                        ].map((item) => (
                          <li key={item} className="flex items-start gap-2.5">
                            <Check className="mt-0.5 size-4 shrink-0 text-[#30a46c]" aria-hidden="true" />
                            <span className="text-[13px] leading-5 text-[#344054]">{item}</span>
                          </li>
                        ))}
                      </ul>

                      <p className="m-0 text-[13px] leading-[17px] text-[#60646c]" data-testid="install-handoff-note">
                        {config.appName} stays locked until this signed-in page sends it a one-time activation link.
                      </p>

                      <button
                        type="button"
                        className="grid min-h-10 w-fit place-items-center rounded-[9px] bg-[#101828] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-black disabled:opacity-60"
                        data-testid="install-connect-open"
                        disabled={connecting}
                        onClick={() => void beginConnect()}
                      >
                        {connecting ? "Preparing…" : "Activate OpenWork Enterprise"}
                      </button>

                      <details className="grid gap-2 border-t border-[#e1e4e8] pt-3 [&[open]_svg]:rotate-180">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-[#344054] [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3 shrink-0 text-[#7a808a] transition-transform" aria-hidden="true" />
                          Nothing happening on your computer?
                        </summary>
                        <p className="m-0 text-[13px] leading-[17px] text-[#60646c]">Create a fresh one-time activation link and copy it if your browser cannot open the app automatically.</p>
                        <button
                          type="button"
                          className="w-fit text-[11px] font-medium text-[#667085] underline-offset-4 hover:text-[#101828] hover:underline"
                          data-testid="install-connect-copy"
                          disabled={connecting}
                          onClick={() => void prepareAndCopyConnectionLink()}
                        >
                          {connectCopied ? "Copied a fresh activation link" : "Copy a fresh activation link"}
                        </button>
                      </details>
                  </div>

                  {connectError ? <p className="m-0 text-sm text-red-600" role="alert">{connectError}</p> : null}
            </InstallStep>

            <InstallStep
              index={4}
              state={guideStep === 4 ? "active" : "pending"}
              title="Confirm activation"
              description="Keep this page open while OpenWork Enterprise consumes the one-time link and signs you in."
              expanded={expandedStep === 4 && guideStep === 4}
              onExpand={() => setExpandedStep(4)}
              testId="install-guide-step-signin"
            >
                  <div className="grid gap-3" aria-live="polite">
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <a
                        className="grid h-11 shrink-0 place-items-center rounded-[11px] bg-[#101828] px-6 text-[13px] font-semibold text-white transition-colors hover:bg-black sm:w-[18rem]"
                        href={RETURN_TO_OPENWORK_URL}
                      >
                        Return to OpenWork Enterprise
                      </a>
                      {handoffStatus.status === "consumed" ? null : (
                        <p className="m-0 flex grow items-center gap-3 rounded-[11px] border border-[#e1e4e8] bg-white px-4 text-[13px] text-[#60646c]">
                          <span className="size-4 animate-spin rounded-full border-2 border-[#b0b7c3] border-t-[#101828]" aria-hidden="true" />
                          Waiting for OpenWork Enterprise…
                        </p>
                      )}
                    </div>

                    {handoffStatus.status === "consumed" ? (
                      <div className="flex items-start gap-3 rounded-[11px] border border-[#e7eaef] bg-[#fafbfc] px-3.5 py-3" data-testid="install-connected">
                        <span className="grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] border-[#c9cfd7] bg-white text-[11px] font-bold text-[#30a46c]" aria-hidden="true">✓</span>
                        <span className="grid gap-0.5">
                          <span className="text-[13px] font-semibold text-[#1c2024]">OpenWork Enterprise is activated</span>
                          <span className="text-[11px] text-[#60646c]">The app consumed the one-time link and signed you in to {config.clientName}.</span>
                        </span>
                      </div>
                    ) : handoffStatus.status === "unknown" ? (
                      <p className="m-0 text-sm text-amber-700">This one-time link expired. Return to step 3 and create a fresh activation link.</p>
                    ) : null}

                    {handoffStatus.status === "consumed" ? (
                      <CopyLinkRow value={RETURN_TO_OPENWORK_URL} copied={returnCopied} onCopy={() => void copyReturnLink()} />
                    ) : connectLink ? (
                      <div className="grid gap-2">
                        <p className="m-0 text-[11px] text-[#7a808a]">Nothing opened? Copy this {config.appName} link and open it anywhere links work.</p>
                        <CopyLinkRow value={connectLink} copied={connectCopied} onCopy={() => void copyConnectionLink()} />
                      </div>
                    ) : null}
                  </div>
            </InstallStep>
          </ol>
        )}
        </div>
      </section>
    </OnboardingShell>
  );
}
