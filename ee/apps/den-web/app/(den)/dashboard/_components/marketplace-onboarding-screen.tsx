"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, KeyRound, Zap } from "lucide-react";
import {
  getCustomLlmProvidersRoute,
  getInferenceRoute,
  getMarketplacesRoute,
  getOrgDashboardRoute,
} from "../../_lib/den-org";
import { requestJson } from "../../_lib/den-flow";
import { buttonVariants, DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { LlmProviderLogos } from "./llm-provider-logos";
import { OrganizationDownloadCard } from "./organization-download-card";

const OPENWORK_MCP_DOCS = "https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp";
const OPENWORK_MCP_ENDPOINT = "https://api.openworklabs.com/mcp/agent";

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

function StepHeading({ step, title, done }: { step: number; title: string; done: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-400">Step {step} of 2</p>
      <p className="text-[15px] font-medium tracking-[-0.02em] text-gray-950">{title}</p>
      {done ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
          <Check className="h-3 w-3" aria-hidden="true" /> Done
        </span>
      ) : null}
    </div>
  );
}

/** One of the two ways to get a model running. Same shell, different emphasis. */
function ModelOption({
  recommended,
  icon,
  title,
  body,
  children,
}: {
  recommended?: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-1 flex-col gap-3 rounded-2xl border p-5 ${
        recommended ? "border-blue-200 bg-blue-50/60" : "border-gray-100 bg-gray-50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <p className="text-[15px] font-medium tracking-[-0.02em] text-gray-950">{title}</p>
        </div>
        {recommended ? (
          <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white">
            Recommended
          </span>
        ) : null}
      </div>
      <p className="flex-1 text-[13px] leading-5 text-gray-500">{body}</p>
      {children}
    </div>
  );
}

export function MarketplaceOnboardingScreen() {
  const { activeOrg, orgSlug } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const { data: modelsEnabled = false } = useInferenceEnabled();
  const [appInstalled, setAppInstalled] = useLocalStorageFlag(APP_INSTALLED_KEY);
  const [copied, setCopied] = useState(false);

  const orgName = activeOrg?.name ?? "your team";
  const allDone = appInstalled && modelsEnabled;
  // OpenWork Models are a hosted OpenWork Cloud offering; self-hosted
  // (single-org) deployments bring their own provider key instead.
  const showOpenWorkModels = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";

  async function copyMcpEndpoint() {
    try {
      await navigator.clipboard.writeText(OPENWORK_MCP_ENDPOINT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <DashboardPageTemplate
      size="compact"
      title={allDone ? `${orgName} is ready.` : `Set up ${orgName}`}
      description={
        allDone
          ? "The app is installed and models are on. Everything below stays here if you need it again."
          : "OpenWork runs on the desktop app. Install it, turn on a model, and you're working."
      }
      colors={["#0f172a", "#047857", "#6ee7b7", "#f8fafc"]}
    >
      <div className="grid gap-8">
        <section data-testid="onboarding-step-download">
          <StepHeading step={1} title="Install the desktop app" done={appInstalled} />
          {activeOrg ? (
            <OrganizationDownloadCard organizationId={activeOrg.id} organizationName={activeOrg.name} />
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-[13px] leading-5 text-gray-500">
              Computer Use, Browser, Image Gen, and Google Workspace only run in the app.
            </p>
            {appInstalled ? null : (
              <DenButton variant="secondary" size="sm" onClick={() => setAppInstalled(true)}>
                I&apos;ve already installed it
              </DenButton>
            )}
          </div>
        </section>

        <section data-testid="onboarding-step-models">
          <StepHeading step={2} title="Turn on a model" done={modelsEnabled} />
          {modelsEnabled ? null : (
            <div className="flex flex-col gap-4 md:flex-row">
              {showOpenWorkModels ? (
                <ModelOption
                  recommended
                  icon={<Zap className="h-4 w-4 text-blue-600" aria-hidden="true" />}
                  title="OpenWork Models"
                  body="Frontier and open models, already wired up. No API keys, no billing to configure."
                >
                  <Link href={getInferenceRoute(orgSlug)} className={buttonVariants({ className: "w-full" })}>
                    Use OpenWork Models
                  </Link>
                </ModelOption>
              ) : null}

              <ModelOption
                icon={<KeyRound className="h-4 w-4 text-gray-500" aria-hidden="true" />}
                title="Bring your own key"
                body="Already paying for OpenAI, OpenRouter, or Anthropic? Paste your key and keep your own billing."
              >
                <LlmProviderLogos />
                <Link
                  href={getCustomLlmProvidersRoute(orgSlug)}
                  className={buttonVariants({
                    variant: showOpenWorkModels ? "secondary" : "primary",
                    className: "w-full",
                  })}
                >
                  Add your own key
                </Link>
              </ModelOption>
            </div>
          )}
        </section>

        <section className="border-t border-gray-100 pt-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-400">Other clients</p>
          <p className="mt-2 max-w-[620px] text-[13px] leading-5 text-gray-500">
            Prefer OpenCode, Codex, or another MCP app? Point it at the OpenWork Connect endpoint. OpenCode is verified;
            Codex, Cursor Web/Agents, ChatGPT Desktop, Claude Code, and VS Code have setup guides.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              aria-label={`Copy OpenWork MCP endpoint ${OPENWORK_MCP_ENDPOINT}`}
              onClick={copyMcpEndpoint}
              className="inline-flex max-w-full items-center gap-2 whitespace-normal rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-left font-mono text-[12px] text-gray-700 transition-colors hover:bg-gray-100"
            >
              <span className="min-w-0 break-all">{OPENWORK_MCP_ENDPOINT}</span>
              {copied ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
              )}
            </button>
            <a
              href={OPENWORK_MCP_DOCS}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-700 hover:text-gray-950"
            >
              Read docs <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
          <p aria-live="polite" className="mt-2 min-h-5 text-[12px] font-medium text-emerald-600">
            {copied ? "OpenWork MCP endpoint copied." : ""}
          </p>
        </section>

        <p className="text-[13px] text-gray-500">
          Already set up?{" "}
          <Link href={getMarketplacesRoute(orgSlug)} className="font-medium text-gray-700 hover:text-gray-950">
            View marketplaces
          </Link>{" "}
          ·{" "}
          <Link href={getOrgDashboardRoute(orgSlug)} className="font-medium text-gray-700 hover:text-gray-950">
            Go to dashboard
          </Link>
        </p>
      </div>
    </DashboardPageTemplate>
  );
}
