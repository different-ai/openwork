"use client";

import { detectPlatform, DownloadPlatformGrid, type DetectedPlatform, type DownloadPlatformGroup, type DownloadPlatformOption } from "@openwork/ui/react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { parseOrgListPayload, type DenOrgSummary } from "../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../_lib/org-scope";
import { useDenFlow } from "../_providers/den-flow-provider";
import { OrgSelectionScreen } from "../dashboard/_features/org-selection/org-selection-screen";
import { DenButton } from "./ui/button";
import { DenSkeleton } from "./ui/skeleton";
import { getInstallConfigErrorMessage } from "../_lib/install-errors";
import { LINK_STEP, parseGuideStep, type GuideStep } from "../_lib/install-guide";
import { installDownloadHref, installPageUrl, type InstallPlatform, installerFileName } from "../_lib/install-download";
import { isMobileUserAgent } from "../_lib/platform";
import { InstallVisual } from "./install-visual";
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

async function fetchInstallConfig(organizationId: string) {
  const { response, payload } = await requestJson(
    "/v1/me/install-config",
    { method: "GET", headers: { [ORG_SCOPE_HEADER]: organizationId } },
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
  const { user } = useDenFlow();
  return <InstallOrganizationPicker key={user?.id} />;
}

async function selectInstallOrganization(organizationId: string) {
  const { response, payload } = await requestJson("/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId }),
  }, 12000);
  if (!response.ok) throw new Error(getErrorMessage(payload, "Could not select this organization. Try again."));
}

/** Generic install links confer no membership and carry no organization credential. */
function InstallOrganizationPicker() {
  const { signOut } = useDenFlow();
  const [orgs, setOrgs] = useState<DenOrgSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setOrgs(null); setSelectedId(null); setError(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) { url.searchParams.delete("token"); window.history.replaceState(null, "", url); }
    void (async () => {
      try {
        const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET", cache: "no-store" }, 12000);
        if (!response.ok) throw new Error("Could not verify your organizations. Try again.");
        const directory = parseOrgListPayload(payload);
        if (!isRecord(payload) || !Array.isArray(payload.orgs) || directory.orgs.length !== payload.orgs.length) throw new Error("Could not verify your organizations. Try again.");
        const onlyOrg = directory.orgs[0];
        if (directory.orgs.length === 1 && onlyOrg && !cancelled) {
          await selectInstallOrganization(onlyOrg.id);
          if (!cancelled) setSelectedId(onlyOrg.id);
        }
        if (!cancelled) setOrgs(directory.orgs);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not verify your organizations. Try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);
  async function pick(slug: string) {
    const org = orgs?.find((entry) => entry.slug === slug);
    if (!org || pending) return;
    setPending(true); setError(null);
    try { await selectInstallOrganization(org.id); setSelectedId(org.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not select this organization. Try again."); }
    finally { setPending(false); }
  }
  if (selectedId) return <InstallGuide key={selectedId} organizationId={selectedId} />;
  if (orgs?.length) return <OrgSelectionScreen orgs={orgs} pending={pending} errorMessage={error} onPick={(slug) => void pick(slug)} onSignOut={() => void signOut()} />;
  return <OnboardingShell state="install-loading" width="wide" background="surface"><section className="grid gap-4" aria-busy={!error && orgs === null} aria-label={!error && orgs === null ? "Checking organization access" : undefined}>
    {!error && orgs === null ? <><DenSkeleton className="h-8 w-64" /><DenSkeleton className="h-12 w-full" /><DenSkeleton className="h-12 w-full" /></> : <>
      <h1 className="den-title-lg">{error ? "Organization check unavailable" : "Join an organization to install"}</h1>
      {error ? <><p className="den-copy" role="alert">{error}</p><DenButton onClick={() => setAttempt((value) => value + 1)}>Try again</DenButton></> : <DenButton href="/organization">Create or join an organization</DenButton>}
    </>}
  </section></OnboardingShell>;
}

function InstallGuide({ organizationId }: { organizationId: string }) {
  const searchParams = useSearchParams();
  const [config, setConfig] = useState<InstallConfig | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "requested">("idle");
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

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
    setCurrentLink(installPageUrl());
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
        const parsed = await fetchInstallConfig(organizationId);
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
  }, [organizationId]);

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
    setDownloadState("requested");
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
              <p className="den-copy max-w-2xl" data-testid="install-organization">Organization: {config.clientName}</p>
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
                <DownloadPlatformGrid groups={downloadGroups} openInNewTab />
                {/* Reload so the auth provider reads the desktop handoff parameters on mount. */}
                <a className="den-button-secondary w-fit" href={DESKTOP_SIGN_IN_PATH}>
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
    <OnboardingShell state="install" width="enterprise" background="surface">
      <section data-testid="install-page">
        <div className="grid gap-2 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 text-left sm:p-8 md:px-10 md:py-9" data-testid="install-card">
          <div className="grid justify-items-start gap-2 border-b border-slate-100 pb-6">
            <span className="text-[13px] font-medium text-slate-500">
              <OrganizationBrandIdentity
                organizationName={config.clientName}
                brand={{ appName: config.appName, logoUrl: config.logoUrl, iconUrl: config.iconUrl }}
              />
            </span>
            <h1 className="m-0 text-[1.5rem] font-semibold leading-tight tracking-[-0.03em] text-slate-950 sm:text-[1.7rem]">
              Set up OpenWork Enterprise
            </h1>
          </div>

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
                    openInNewTab
                    recommendedTestId="install-download-primary"
                    onDownload={(option: DownloadPlatformOption) => beginDownload(option.label, option.href)}
                    variant="flat"
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
                      <p className="m-0 text-sm font-medium text-slate-950">Download requested</p>
                      <p className="m-0 text-[13px] leading-5 text-slate-500">Check your browser's downloads for {downloadLabel}. If the file does not appear, retry the download.</p>
                      <a className="den-button-secondary w-fit" href={downloadHref} target="_blank" rel="noreferrer" onClick={() => beginDownload(downloadLabel, downloadHref)}>Retry download</a>
                      <DenButton className="w-fit" onClick={() => advanceGuide(2)}>I have the installer</DenButton>
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
        </div>
      </section>
    </OnboardingShell>
  );
}
