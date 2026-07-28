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
import { LlmProviderLogos } from "./llm-provider-logos";

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
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-12 sm:px-6" data-testid="marketplace-onboarding">
      <header className="mx-auto max-w-xl text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">Get started</p>
        <h1 className="mt-3 text-[30px] font-semibold leading-[1.15] tracking-[-0.04em] text-gray-950 sm:text-[34px]">
          {requiredDone ? `${orgName} is ready.` : `Get the OpenWork app`}
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-[15px] leading-6 text-gray-500">
          {requiredDone
            ? "The desktop app is installed and models are available. Jump into your dashboard whenever you're ready."
            : "OpenWork runs on the desktop app. Install it, sign in, and this workspace syncs automatically."}
        </p>
      </header>

      <section className="mt-8 grid gap-4">
        <DownloadOpenWorkCard installers={installers} releaseTag={releaseTag} />
        <div className="flex justify-center">
          {appInstalled ? (
            <DenBadge tone="success" icon={Check}>
              Installed
            </DenBadge>
          ) : (
            <button
              type="button"
              data-testid="onboarding-app-installed"
              onClick={() => setAppInstalled(true)}
              className="text-[13px] font-medium text-gray-500 transition hover:text-gray-950"
            >
              I&apos;ve already installed it →
            </button>
          )}
        </div>
      </section>

      <section className="mt-12 grid gap-5">
        <DenSectionHeader
          align="center"
          title="Then bring your own keys, or use OpenWork Models"
          description={
            modelsLoading
              ? "Checking whether OpenWork Models are already on…"
              : modelsEnabled
                ? "OpenWork Models are on for this workspace."
                : "Pick one now, change it whenever — both live under Models."
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
            subtitle="No API keys, nothing to configure"
            badge={<DenBadge tone="info">Recommended</DenBadge>}
            description="Hand-picked frontier and open models, billed per member. Turn it on and everyone has models in the app immediately."
            href={getInferenceRoute(orgSlug)}
            ctaLabel={modelsEnabled ? "Manage models" : "Turn on models"}
            ctaVariant="primary"
          />
          <DenChoiceCard
            testId="onboarding-choice-byok"
            icon={<KeyRound className="h-[18px] w-[18px] text-gray-700" aria-hidden />}
            title="Bring your Own Keys"
            subtitle="Your providers, your billing"
            description="Connect Anthropic, OpenAI, Azure, Mistral or your own gateway, and choose exactly which models the team sees."
            href={getCustomLlmProvidersRoute(orgSlug)}
            ctaLabel="Add a provider"
            ctaVariant="secondary"
          >
            <LlmProviderLogos />
          </DenChoiceCard>
        </div>
      </section>

      <footer className="mt-12 border-t border-gray-100 pt-5 text-center">
        <p className="text-[13px] text-gray-500">
          Already set up?{" "}
          <Link href={getOrgDashboardRoute(orgSlug)} className="font-medium text-gray-900 underline-offset-2 hover:underline">
            Go to dashboard →
          </Link>
        </p>
      </footer>
    </div>
  );
}
