"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, KeyRound, ArrowUpRight, Mail, ArrowRight } from "lucide-react";
import { DownloadOpenWorkCard, type DownloadCardInstallers } from "@openwork/ui/react";
import { DenBadge } from "../../_components/ui/badge";
import { SetupFrame } from "../../_components/setup-frame";
import {
  getCustomLlmProvidersRoute,
  getInferenceRoute,
  getOrgDashboardRoute,
  getOnboardingToolsRoute,
  getYourConnectionsRoute,
  getWebRoute,
} from "../../_lib/den-org";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

import { isMobileUserAgent } from "../../_lib/platform";

const APP_INSTALLED_KEY = "openwork:onboarding:app-installed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function useLocalStorageFlag(key: string) {
  const [value, setValue] = useState(false);

  useEffect(() => {
    try {
      setValue(localStorage.getItem(key) === "1");
    } catch {
      // localStorage unavailable
    }
  }, [key]);

  function toggle(next: boolean) {
    setValue(next);
    try {
      if (next) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      // localStorage unavailable
    }
  }

  return [value, toggle] as const;
}

function useInferenceEnabled() {
  return useQuery({
    queryKey: ["onboarding", "inference"] as const,
    queryFn: async (): Promise<boolean> => {
      const { response, payload } = await requestJson("/v1/inference", { method: "GET" }, 12000);
      if (!response.ok) return false;
      const inference = isRecord(payload) && isRecord(payload.inference) ? payload.inference : null;
      return inference?.enabled === true;
    },
    staleTime: 30_000,
  });
}

function OpenWorkMark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/openwork-mark.svg" alt="" aria-hidden className={className} />
  );
}

function MobileOpenWorkOptions({ orgSlug, webAvailable }: { orgSlug: string | null; webAvailable: boolean }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function emailDownload() {
    if (sending || sent) return;
    setSending(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/me/send-download-link", { method: "POST" }, 12000);
      if (!response.ok) {
        setError(response.status >= 500
          ? "Could not send your link right now. Please try again."
          : getErrorMessage(payload, "Could not send your link. Please try again."));
        return;
      }
      setSent(true);
    } catch {
      setError("Could not send your link. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-3" data-testid="onboarding-mobile-options">
      <div className="rounded-2xl bg-neutral-50 p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white"><OpenWorkMark className="size-6" /></span>
          <div><h3 className="text-sm font-semibold text-neutral-950">OpenWork Desktop</h3><p className="mt-1 text-xs text-neutral-500">For when you’re back at your desk.</p></div>
        </div>
        <p className="mt-4 text-sm leading-6 text-neutral-600">Work with your files and team tools on your computer. Send a download link to your account’s email.</p>
        <button type="button" onClick={() => void emailDownload()} disabled={sending || sent} className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 px-3 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-default disabled:bg-neutral-200 disabled:text-neutral-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950">
          {sent ? <Check className="size-4" aria-hidden /> : <Mail className="size-4" aria-hidden />}
          {sending ? "Sending…" : sent ? "Download link sent" : "Email me the download link"}
        </button>
        {sent ? <p role="status" className="mt-3 text-xs leading-5 text-neutral-600">Check your inbox. Open the link on your computer when you’re ready.</p> : null}
        {error ? <p role="alert" className="mt-3 text-sm leading-5 text-red-700">{error}</p> : null}
      </div>
      {webAvailable ? <div className="rounded-2xl bg-neutral-50 p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white"><OpenWorkMark className="size-6" /></span>
          <div><h3 className="text-sm font-semibold text-neutral-950">OpenWork Web</h3><p className="mt-1 text-xs text-neutral-500">Your cloud workspace, in the browser.</p></div>
        </div>
        <p className="mt-4 text-sm leading-6 text-neutral-600">Keep going from here. Explore cloud access and plans without installing the desktop app.</p>
        <Link href={getWebRoute(orgSlug)} className="mt-3 flex min-h-12 items-center justify-between gap-2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-neutral-950 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950">Try OpenWork Web<ArrowRight className="size-4" aria-hidden /></Link>
      </div> : null}
    </div>
  );
}

export function MarketplaceOnboardingScreen({
  installers,
  releaseTag,
}: {
  installers?: DownloadCardInstallers | null;
  releaseTag?: string;
}) {
  const { activeOrg, orgSlug, orgContext } = useOrgDashboard();
  const { data: modelsEnabled = false, isLoading: modelsLoading } = useInferenceEnabled();
  const [appInstalled, setAppInstalled] = useLocalStorageFlag(APP_INSTALLED_KEY);

  const [mobileDevice, setMobileDevice] = useState(false);
  useEffect(() => {
    setMobileDevice(isMobileUserAgent() || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  }, []);

  const orgName = activeOrg?.name ?? "your team";

  return (
    <SetupFrame
      step="ready"
      embedded
      title="Put your tools to work."
      description={`Start a chat. Build dashboards, run workflows, and use ${orgName}’s tools—with the model you choose.`}
    >
      <div className="grid gap-8" data-testid="marketplace-onboarding">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-50 px-4 py-3 text-xs text-neutral-500">
          <span>More useful with your team’s tools.</span>
          <Link href={getOnboardingToolsRoute(orgSlug)} className="font-medium text-neutral-900 underline-offset-4 hover:underline">Choose team tools →</Link>
        </div>
        <section aria-labelledby="setup-download-heading" className="grid gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--dls-border)] text-xs font-medium text-[var(--dls-text-secondary)]">1</span>
            <div>
              <h2 id="setup-download-heading" className="text-base font-semibold tracking-tight text-[var(--dls-text-primary)]">Choose where to start</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--dls-text-secondary)]">Chat with your files and team tools, in one place.</p>
            </div>
          </div>
          <div className={mobileDevice ? "block" : "sm:hidden"}>
            <MobileOpenWorkOptions orgSlug={orgSlug} webAvailable={orgContext?.capabilities.openworkWeb === true} />
          </div>
          <div className={mobileDevice ? "hidden" : "hidden sm:grid sm:gap-4"}>
            <DownloadOpenWorkCard installers={installers} releaseTag={releaseTag} compact appIcon={<OpenWorkMark className="size-6" />} />
            <div className="flex items-center justify-between gap-3 text-xs text-[var(--dls-text-secondary)]">
              {appInstalled ? (
                <span className="inline-flex items-center gap-2" role="status">
                  <Check className="size-3.5" aria-hidden /> Installation marked complete
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="onboarding-app-installed"
                  onClick={() => setAppInstalled(true)}
                  className="rounded-sm text-sm font-medium underline-offset-4 hover:text-[var(--dls-text-primary)] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--dls-text-primary)]"
                >
                  I&apos;ve already installed it →
                </button>
              )}
              <span>Sign in with the same account.</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="setup-models-heading" className="grid gap-4 border-t border-[var(--dls-border)] pt-7">
          <div className="flex items-start gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--dls-border)] text-xs font-medium text-[var(--dls-text-secondary)]">2</span>
            <div className="min-w-0 flex-1">
              <h2 id="setup-models-heading" className="text-base font-semibold tracking-tight text-[var(--dls-text-primary)]">Choose what powers your work</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--dls-text-secondary)]" role="status">
                {modelsLoading
                  ? "Checking OpenWork Models…"
                  : modelsEnabled
                    ? "OpenWork Models are on for this workspace."
                    : "Choose your model and provider. Use OpenWork Models or bring your own account—you can set this up later."}
              </p>
            </div>
            {modelsEnabled ? <DenBadge icon={Check}>Models on</DenBadge> : null}
          </div>
          <div className="divide-y divide-[var(--dls-border)] overflow-hidden rounded-2xl border border-[var(--dls-border)]">
            <div className="flex items-start gap-3 p-4 sm:p-5" data-testid="onboarding-choice-openwork-models">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--dls-hover)]"><OpenWorkMark /></div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-[var(--dls-text-primary)]">OpenWork Models</h3>
                <p className="mt-1 text-[13px] leading-5 text-[var(--dls-text-secondary)]">Managed models, billed per member. No API keys to look after.</p>
                <Link href={getInferenceRoute(orgSlug)} className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-[var(--dls-text-primary)] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--dls-text-primary)]">
                  {modelsEnabled ? "Manage models" : "Turn on models"}<ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            </div>
            <div className="flex items-start gap-3 p-4 sm:p-5" data-testid="onboarding-choice-byok">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--dls-hover)]"><KeyRound className="size-[18px] text-[var(--dls-text-secondary)]" aria-hidden /></div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-[var(--dls-text-primary)]">Bring your Own Keys</h3>
                <p className="mt-1 text-[13px] leading-5 text-[var(--dls-text-secondary)]">Connect your provider or gateway. Keep your own billing and model choices.</p>
                <Link href={getCustomLlmProvidersRoute(orgSlug)} className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-[var(--dls-text-primary)] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--dls-text-primary)]">
                  Add a provider<ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        </section>

        <div className="rounded-2xl bg-neutral-50 p-5 text-sm leading-6 text-neutral-600">
          <h3 className="font-medium text-neutral-950">One connection. Your team’s tools.</h3>
          <p className="mt-1 text-[13px]">OpenWork’s MCP gateway brings shared tools into compatible AI apps. Each person uses their own connected accounts and team permissions.</p>
          <Link href={getYourConnectionsRoute(orgSlug)} className="mt-3 inline-block font-medium text-neutral-900 underline-offset-4 hover:underline">Connect your accounts →</Link>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--dls-border)] pt-5 text-sm">
          <span className="text-[var(--dls-text-secondary)]">Keep setting up at your own pace.</span>
          <Link href={getOrgDashboardRoute(orgSlug)} className="rounded-sm font-medium text-[var(--dls-text-primary)] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--dls-text-primary)]">
            Go to dashboard →
          </Link>
        </footer>
      </div>
    </SetupFrame>
  );
}
