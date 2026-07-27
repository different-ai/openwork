"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, KeyRound } from "lucide-react";
import { DownloadOpenWorkCard, type DownloadCardInstallers } from "@openwork/ui/react";
import { DenBadge } from "../../_components/ui/badge";
import { DenChoiceCard } from "../../_components/ui/choice-card";
import { DenSectionHeader } from "../../_components/ui/section-header";
import {
  getCustomLlmProvidersRoute,
  getInferenceRoute,
  getOrgDashboardRoute,
} from "../../_lib/den-org";
import { requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

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

export function MarketplaceOnboardingScreen({
  installers,
  releaseTag,
}: {
  installers?: DownloadCardInstallers | null;
  releaseTag?: string;
}) {
  const { activeOrg, orgSlug } = useOrgDashboard();
  const { data: modelsEnabled = false, isLoading: modelsLoading } = useInferenceEnabled();
  const [appInstalled, setAppInstalled] = useLocalStorageFlag(APP_INSTALLED_KEY);

  const orgName = activeOrg?.name ?? "your team";
  const requiredDone = appInstalled && modelsEnabled;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-12 pt-8 sm:px-6" data-testid="marketplace-onboarding">
      <header className="max-w-xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">Get started</p>
        <h1 className="mt-3 text-[28px] font-semibold leading-[1.1] tracking-[-0.04em] text-gray-950 sm:text-[32px]">
          {requiredDone ? `${orgName} is ready.` : `Get the OpenWork app`}
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-gray-500">
          {requiredDone
            ? "The desktop app is installed and models are available. Jump into your dashboard whenever you're ready."
            : "OpenWork runs on the desktop. Install the app, then choose OpenWork Models or bring your own keys."}
        </p>
      </header>

      <section className="mt-8 grid gap-3">
        <DenSectionHeader
          title="1. Install the desktop app"
          description="Computer Use, Browser, Image Gen, and Google Workspace only run in the app."
          action={
            appInstalled ? (
              <DenBadge tone="success" icon={Check}>
                Installed
              </DenBadge>
            ) : null
          }
        />
        <DownloadOpenWorkCard installers={installers} releaseTag={releaseTag} />
        {!appInstalled ? (
          <button
            type="button"
            data-testid="onboarding-app-installed"
            onClick={() => setAppInstalled(true)}
            className="w-fit text-[13px] font-medium text-gray-500 transition hover:text-gray-950"
          >
            I&apos;ve already installed it →
          </button>
        ) : null}
      </section>

      <section className="mt-10 grid gap-4">
        <DenSectionHeader
          title="2. Choose how your team uses models"
          description={
            modelsLoading
              ? "Checking whether OpenWork Models are already on…"
              : modelsEnabled
                ? "OpenWork Models are on for this workspace."
                : "Pick one path. You can change this later under Models."
          }
          action={
            modelsEnabled ? (
              <DenBadge tone="success" icon={Check}>
                Models on
              </DenBadge>
            ) : null
          }
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <DenChoiceCard
            testId="onboarding-choice-openwork-models"
            icon={<OpenWorkMark />}
            title="OpenWork Models"
            description="Hosted frontier models for knowledge work. No API keys to manage — every member is provisioned automatically."
            href={getInferenceRoute(orgSlug)}
            ctaLabel={modelsEnabled ? "Manage models" : "Turn on models"}
            ctaVariant="primary"
          />
          <DenChoiceCard
            testId="onboarding-choice-byok"
            icon={<KeyRound className="h-5 w-5 text-gray-700" aria-hidden />}
            title="Bring your Own Keys"
            description="Connect Anthropic, OpenAI, Azure, or any models.dev provider with credentials your org already has."
            href={getCustomLlmProvidersRoute(orgSlug)}
            ctaLabel="Add providers"
            ctaVariant="secondary"
          />
        </div>
      </section>

      <footer className="mt-10 border-t border-gray-100 pt-5">
        <p className="text-[13px] text-gray-500">
          Already set up?{" "}
          <Link href={getOrgDashboardRoute(orgSlug)} className="font-medium text-gray-900 underline-offset-2 hover:underline">
            Go to dashboard
          </Link>
        </p>
      </footer>
    </div>
  );
}
