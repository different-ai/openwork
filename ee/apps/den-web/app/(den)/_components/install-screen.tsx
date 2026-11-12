"use client";

import { detectPlatform, DownloadPlatformGrid, type DetectedPlatform, type DownloadPlatformGroup, type DownloadPlatformOption } from "@openwork/ui/react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { requestJson } from "../_lib/den-flow";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { LINK_STEP, parseGuideStep, type GuideStep } from "../_lib/install-guide";
import { installDownloadHref, type InstallPlatform, installerFileName } from "../_lib/install-download";
import { isMobileUserAgent } from "../_lib/platform";
import { InstallVisual } from "./install-visual";
import type { OrganizationBrand } from "./organization-brand-identity";
import { JoinHeading, JoinPanel, JoinText } from "./join-frame";
import { SetupQuietButton } from "./setup-frame-parts";
import { DenButton } from "./ui/button";

type InstallConfig = {
  appName: string;
  clientName: string;
  webUrl: string;
  apiUrl: string;
  requireSignin: boolean;
  logoUrl: string | null;
  iconUrl: string | null;
  desktopVersion: string;
  distribution: "cloud" | "enterprise";
};

const DESKTOP_SIGN_IN_PATH = "/?mode=sign-in&desktopAuth=1&desktopScheme=openwork";
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
  if (
    !desktopVersion
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
    desktopVersion,
    distribution,
  };
}

async function fetchInstallConfig() {
  const { response, payload } = await requestJson(
    "/v1/me/install-config",
    { method: "GET" },
    12000,
  );
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Sign in to your Den portal to install OpenWork.");
    }
    throw new Error(getInstallConfigErrorMessage(payload, response.status));
  }
  const parsed = parseInstallConfig(payload);
  if (!parsed) {
    throw new Error("This install link returned incomplete setup details.");
  }
  return parsed;
}

type StepState = "complete" | "active" | "pending";

const STEP_BADGE: Record<StepState, string> = {
  complete: "bg-emerald-50 text-emerald-600",
  active: "bg-[#101828] text-white",
  pending: "bg-slate-100 text-slate-400",
};

function InstallStep({
  index,
  state,
  title,
  expanded,
  onExpand,
  testId,
  children,
}: {
  index: number;
  state: StepState;
  title: ReactNode;
  expanded: boolean;
  onExpand: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <li className="border-b border-slate-100 last:border-b-0" data-state={state} data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-center gap-3.5 px-0 py-4 text-left disabled:cursor-default sm:py-[1.125rem]"
        aria-expanded={expanded}
        disabled={state === "pending"}
        onClick={onExpand}
      >
        <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${STEP_BADGE[state]}`} aria-hidden="true">
          {state === "complete" ? <Check className="size-3.5" strokeWidth={2.5} /> : index}
        </span>
        <span className={`grow text-[15px] font-semibold tracking-[-0.01em] ${state === "complete" ? "text-slate-400" : "text-slate-950"}`}>{title}</span>
        <ChevronDown className={`size-4 shrink-0 text-slate-300 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {expanded ? <div className="grid gap-3.5 pb-6 pl-[2.625rem]">{children}</div> : null}
    </li>
  );
}

export function InstallScreen() {
  const searchParams = useSearchParams();
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
  const [connectError, setConnectError] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const downloadStartedTimer = useRef<number | null>(null);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    // Install pages once carried a one-off token; it is ignored now, so drop
    // it from the address before anyone copies and shares it again.
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url);
    }
    setCurrentLink(url.toString());
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
      setBusy(true);
      setError(null);
      try {
        const parsed = await fetchInstallConfig();
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
  }, []);

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
          { href: installDownloadHref("mac-arm64"), label: "Apple Silicon (M1+)", arch: "arm64" },
          { href: installDownloadHref("mac-x64"), label: "Intel", arch: "x64" },
        ],
      },
      {
        os: "windows",
        title: "Windows",
        options: [
          { href: installDownloadHref("win-x64"), label: "x64 app", arch: "x64" },
        ],
      },
      {
        os: "linux",
        title: "Linux",
        options: [
          { href: installDownloadHref("linux-x64"), label: "AppImage (x64)", arch: "x64" },
          { href: installDownloadHref("linux-arm64"), label: "AppImage (ARM64)", arch: "arm64" },
        ],
      },
    ];
  }, [config]);

  const platformByHref = useMemo<Record<string, InstallPlatform>>(() => {
    if (!config) {
      return {};
    }
    return Object.fromEntries(INSTALL_PLATFORMS.map((platform) => [installDownloadHref(platform), platform]));
  }, [config]);



  async function copyCurrentLink() {
    try {
      await navigator.clipboard.writeText(currentLink || window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setConnectError("Could not copy automatically. Select the install link and copy it manually.");
    }
  }

  const workspaceAddress = (() => {
    if (!currentLink) return "";
    try {
      return new URL(currentLink).origin;
    } catch {
      return "";
    }
  })();

  async function copyWorkspaceAddress() {
    try {
      await navigator.clipboard.writeText(workspaceAddress);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1800);
    } catch {
      setConnectError("Could not copy automatically. Select the address and copy it manually.");
    }
  }

  function advanceGuide(nextStep: 2 | 3) {
    setGuideStep(nextStep);
    setExpandedStep(nextStep);
    const url = new URL(window.location.href);
    url.search = "";
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

  if (busy) {
    return (
      <JoinPanel state="install-loading">
        <div className="grid gap-[18px]" data-testid="install-page">
          <JoinHeading title="Loading your install link." copy="Checking your team's OpenWork setup..." />
        </div>
      </JoinPanel>
    );
  }

  if (!config) {
    return (
      <JoinPanel state="install-error">
        <div className="grid gap-[18px]" data-testid="install-page">
          <JoinHeading title="This install link can't be opened." copy={error ?? "Ask your workspace admin for a fresh install link."} />
        </div>
      </JoinPanel>
    );
  }

  if (config.distribution === "cloud") {
    return (
      <JoinPanel state="install">
        <div className="grid gap-[18px]" data-testid="install-page">
          <JoinHeading title="Download OpenWork." copy="Choose the version for your computer, install it, and open OpenWork." />
          {isMobile ? (
            <div className="grid gap-3" data-testid="install-mobile-note">
              <JoinText muted>OpenWork runs on your computer. Open this link on your Mac, Windows, or Linux machine.</JoinText>
              <DenButton variant="secondary" className="w-full" onClick={() => void copyCurrentLink()}>{copied ? "Copied" : "Copy install link"}</DenButton>
            </div>
          ) : (
            <>
              <DownloadPlatformGrid groups={downloadGroups} variant="flat" stacked />
              {/* Reload so the auth provider reads the desktop handoff parameters on mount. */}
              <SetupQuietButton className="self-center rounded-md px-2 py-1" onClick={() => window.location.assign(DESKTOP_SIGN_IN_PATH)}>
                I already installed OpenWork
              </SetupQuietButton>
            </>
          )}
        </div>
      </JoinPanel>
    );
  }

  const installerFile = installerFileName(
    downloadPlatform ?? detectedInstallPlatform(detected),
    config.desktopVersion,
  );
  const guidance = openGuidance(installerOsFor(downloadPlatform, detected), installerFile);

  return (
    <InstallGuideFrame organization={{ name: config.clientName, brand: { appName: config.appName, logoUrl: config.logoUrl, iconUrl: config.iconUrl } }}>
          <div className="pb-3"><JoinHeading title="Set up OpenWork Enterprise." copy={`For ${config.clientName}.`} /></div>

        {isMobile ? (
          <div className="grid gap-3 border-t border-slate-200 pt-5" data-testid="install-mobile-note">
            <p className="m-0 text-base font-medium text-[var(--dls-text-primary)]">{config.appName} runs on your computer.</p>
            <p className="den-copy">Open this link on your Mac, Windows, or Linux machine. You can also copy it and send it to yourself.</p>
            <button type="button" className="den-button-secondary w-full sm:w-auto" onClick={() => void copyCurrentLink()}>
              {copied ? "Copied" : "Copy install link"}
            </button>
          </div>
        ) : (
          <ol className="grid text-left" data-testid="install-guide">
            <InstallStep
              index={1}
              state={guideStep > 1 ? "complete" : "active"}
              title="Download"
              expanded={expandedStep === 1}
              onExpand={() => setExpandedStep(1)}
              testId="install-guide-step-download"
            >
                  <DownloadPlatformGrid
                    groups={downloadGroups}
                    recommendedTestId="install-download-primary"
                    onDownload={(option: DownloadPlatformOption) => beginDownload(option.label, option.href)}
                    variant="flat"
                    stacked
                  />
                  <button
                    type="button"
                    className="w-fit text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-950 hover:underline"
                    onClick={() => advanceGuide(LINK_STEP)}
                    data-testid="install-skip-download"
                  >
                    Already installed? Skip to step 3
                  </button>
                  {downloadState !== "idle" ? (
                    <div className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50 p-4" aria-live="polite" data-testid="install-download-status">
                      {downloadState === "preparing" ? (
                        <>
                          <span className="size-5 animate-spin rounded-full border-2 border-[var(--dls-border-strong)] border-t-[var(--dls-accent)]" aria-hidden="true" />
                          <p className="m-0 text-sm font-medium text-slate-950">Preparing your {downloadLabel} download...</p>
                          <p className="m-0 text-[13px] leading-5 text-slate-500">The first download may take up to a minute. Your browser will begin downloading when it is ready.</p>
                        </>
                      ) : (
                        <>
                          <p className="m-0 text-sm font-medium text-slate-950">Download started</p>
                          <p className="m-0 text-[13px] leading-5 text-slate-500">Your browser is preparing the file. If it does not appear, try the download again.</p>
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
              title="Install and open it"
              expanded={expandedStep === 2 && guideStep >= 2}
              onExpand={() => setExpandedStep(2)}
              testId="install-guide-step-open"
            >
                  <div className="grid content-start gap-3">
                      <InstallVisual
                        os={installerOsFor(downloadPlatform, detected)}
                        appName={config.appName}
                        iconUrl={config.iconUrl}
                      />

                      <p className="m-0 max-w-xl text-sm leading-6 text-slate-600">{guidance.actions.join(" ")}</p>

                      {guidance.trust ? (
                        <p className="m-0 flex items-start gap-2 text-[13px] leading-5 text-amber-700" data-testid="install-os-trust-note">
                          <ShieldCheck className="mt-px size-[15px] shrink-0" aria-hidden="true" />
                          {guidance.trust.body}
                        </p>
                      ) : null}

                      <button
                        type="button"
                        className="grid min-h-10 w-fit place-items-center rounded-xl bg-[#101828] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-black"
                        data-testid="install-app-ready"
                        onClick={() => advanceGuide(LINK_STEP)}
                      >
                        It&apos;s open
                      </button>
                  </div>
            </InstallStep>

            <InstallStep
              index={3}
              state={guideStep === 3 ? "active" : "pending"}
              title="Connect"
              expanded={expandedStep === 3 && guideStep >= 3}
              onExpand={() => setExpandedStep(3)}
              testId="install-guide-step-link"
            >
                  <div className="grid content-start gap-3" aria-live="polite">
                      <p className="m-0 text-sm leading-6 text-slate-600">In the app, enter your workspace address:</p>

                      <div className="flex h-10 w-fit max-w-full items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05)]" data-testid="install-workspace-address">
                        <input
                          className="min-w-0 grow bg-transparent pl-3.5 pr-3 font-mono text-[13px] font-medium text-slate-950 outline-hidden"
                          value={workspaceAddress}
                          readOnly
                          size={Math.max(workspaceAddress.length, 12)}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <button
                          type="button"
                          className="shrink-0 border-l border-slate-200 bg-slate-50 px-3.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950"
                          onClick={() => void copyWorkspaceAddress()}
                        >
                          {addressCopied ? "Copied" : "Copy"}
                        </button>
                      </div>

                      <p className="m-0 max-w-xl text-[13px] leading-5 text-slate-500">
                        Then choose Sign in — sign-in finishes in this browser and sends you back to the app.
                      </p>

                      {connectError ? <p className="m-0 text-sm text-red-600" role="alert">{connectError}</p> : null}
                  </div>
            </InstallStep>
          </ol>
        )}
    </InstallGuideFrame>
  );
}

function InstallGuideFrame({ organization, children }: { organization: { name: string; brand: OrganizationBrand }; children: ReactNode }) {
  return (
    <JoinPanel state="install" organization={organization}>
      <div className="grid gap-2 text-left" data-testid="install-page">{children}</div>
    </JoinPanel>
  );
}
