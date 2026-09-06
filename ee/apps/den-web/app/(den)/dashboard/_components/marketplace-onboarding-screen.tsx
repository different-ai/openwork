"use client";

import { OnboardingTeamPreview } from "./onboarding-team-preview";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Mail, ArrowRight } from "lucide-react";
import { DownloadOpenWorkCard, type DownloadCardInstallers } from "@openwork/ui/react";
import { SetupFrame } from "../../_components/setup-frame";
import {
  getCustomLlmProvidersRoute,
  getInferenceRoute,
  getOrgDashboardRoute,
  getOnboardingToolsRoute,
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
  const { orgId } = useOrgDashboard();
  return useQuery({
    queryKey: ["onboarding", "inference", orgId],
    enabled: Boolean(orgId),
    queryFn: async (): Promise<boolean> => {
      const { response, payload } = await requestJson("/v1/inference", { method: "GET", headers: orgId ? { "x-openwork-org-id": orgId } : {} }, 12000);
      if (!response.ok) throw new Error("Could not check model access.");
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
  const { data: modelsEnabled = false, isPending: modelsLoading, isError: modelsError } = useInferenceEnabled();
  const [appInstalled, setAppInstalled] = useLocalStorageFlag(APP_INSTALLED_KEY);

  const [mobileDevice, setMobileDevice] = useState(false);
  useEffect(() => {
    setMobileDevice(isMobileUserAgent() || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  }, []);

  const orgName = activeOrg?.name ?? "your team";
  const joinedMembers = orgContext?.members.filter((member) => member.joinedAt !== null);

  return (
    <SetupFrame
      step="ready"
      title="Your team is set up."
      description={`Review ${orgName}’s starting point, then open your workspace.`}
      aside={<OnboardingTeamPreview />}
    >
      <div className="grid gap-6" data-testid="marketplace-onboarding">
        <section aria-label="Team setup review" className="text-sm leading-6 text-neutral-600">
          <h2 className="font-semibold text-neutral-950">Your workspace is ready</h2>
          <p className="mt-2">{orgContext ? `${joinedMembers?.length} ${joinedMembers?.length === 1 ? "member" : "members"} · ${orgContext.invitations.filter((invitation) => invitation.status === "pending").length} pending invitations` : "Checking your team…"}</p>
          <Link href={getOnboardingToolsRoute(orgSlug)} className="mt-3 inline-block text-xs underline underline-offset-4">Edit shared tools</Link>
        </section>
        <section aria-labelledby="setup-models-heading" className="border-t border-neutral-200 pt-5">
          <h2 id="setup-models-heading" className="text-sm font-medium text-neutral-900">Model access</h2>
          <p className="mt-2 min-h-12 text-sm leading-6 text-neutral-500 sm:min-h-6" role="status">
            {modelsLoading ? "Checking OpenWork Models…" : modelsError ? "Couldn’t check OpenWork Models." : modelsEnabled ? "OpenWork Models are on for this workspace." : "OpenWork Models are off. You can set up models later."}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
            <Link href={getInferenceRoute(orgSlug)} className="underline underline-offset-4">{modelsEnabled ? "Manage models" : "Set up models"}</Link>
            <Link href={getCustomLlmProvidersRoute(orgSlug)} className="underline underline-offset-4">Use your own provider</Link>
          </div>
        </section>
        <section data-testid="onboarding-finish">
          <Link href={getOrgDashboardRoute(orgSlug)} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-950 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800">
            Finish setup<ArrowRight className="size-4" aria-hidden />
          </Link>
        </section>
        <details className="border-t border-neutral-200 pt-5">
          <summary className="cursor-pointer text-sm font-medium text-neutral-700">Get the desktop app <span className="font-normal text-neutral-400">· Optional</span></summary>
          <div className="mt-4 grid gap-4">
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
          </div>
        </details>

      </div>
    </SetupFrame>
  );
}
