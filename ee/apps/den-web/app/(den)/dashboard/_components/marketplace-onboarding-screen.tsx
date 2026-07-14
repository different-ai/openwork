"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  Github,
  Plug,
  Sparkles,
  Store,
  Zap,
} from "lucide-react";
import {
  getCustomLlmProvidersRoute,
  getGithubIntegrationRoute,
  getInferenceRoute,
  getMarketplacesRoute,
  getOrgDashboardRoute,
} from "../../_lib/den-org";
import { requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMarketplaces } from "./marketplace-data";
import { useHasAnyIntegration } from "./integration-data";

const ANTHROPIC_KNOWLEDGE_WORK_REPO = "https://github.com/anthropics/knowledge-work-plugins";
const OPENWORK_MCP_DOCS = "https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp";
const OPENWORK_MCP_ENDPOINT = "https://api.openworklabs.com/mcp/agent";
const DOWNLOAD_URL = "https://github.com/different-ai/openwork/releases";

const APP_INSTALLED_KEY = "openwork:onboarding:app-installed";
const MCP_ADDED_KEY = "openwork:onboarding:mcp-added";
const FORK_DONE_KEY = "openwork:onboarding:fork-done";

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

function railClass(done: boolean, required: boolean): string {
  if (done) return "bg-emerald-500";
  if (required) return "bg-amber-400";
  return "bg-gray-200";
}

function StepTag({ done, required }: { done: boolean; required: boolean }) {
  if (done) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        <Check className="h-3 w-3" /> Done
      </span>
    );
  }
  if (required) {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Required</span>
    );
  }
  return (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">Optional</span>
  );
}

function StepCard({
  done,
  required,
  icon,
  title,
  helper,
  children,
}: {
  done: boolean;
  required: boolean;
  icon: React.ReactNode;
  title: string;
  helper: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-white py-4 pl-5 pr-4 shadow-sm sm:pr-5">
      <div className={`absolute inset-y-0 left-0 w-1 ${railClass(done, required)}`} />

      {done ? (
        <div className="flex items-center gap-3 py-0.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <Check className="h-4 w-4" />
          </div>
          <p className="text-[14px] font-semibold text-[#07192C]">{title}</p>
          <StepTag done={done} required={required} />
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#07192C] text-white">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[14px] font-semibold text-[#07192C]">{title}</p>
              <StepTag done={done} required={required} />
            </div>
            <p className="mt-1 text-[13px] leading-5 text-[#5C6B86]">{helper}</p>
            <div className="mt-3">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubCheckbox({
  checked,
  onClick,
  label,
  action,
}: {
  checked: boolean;
  onClick?: () => void;
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={onClick}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked ? "border-emerald-500 bg-emerald-500 text-white" : "border-gray-300 bg-white hover:border-gray-400"
        }`}
      >
        {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </button>
      <span className={`text-[13px] ${checked ? "text-gray-400 line-through" : "text-[#30405F]"}`}>{label}</span>
      {action}
    </div>
  );
}

export function MarketplaceOnboardingScreen() {
  const { activeOrg, orgSlug } = useOrgDashboard();
  const { data: marketplaces = [] } = useMarketplaces();
  const { hasAny: githubConnected } = useHasAnyIntegration();
  const { data: modelsEnabled = false } = useInferenceEnabled();

  const [appInstalled, setAppInstalled] = useLocalStorageFlag(APP_INSTALLED_KEY);
  const [mcpAdded, setMcpAdded] = useLocalStorageFlag(MCP_ADDED_KEY);
  const [forkDone, setForkDone] = useLocalStorageFlag(FORK_DONE_KEY);
  const [copied, setCopied] = useState(false);

  const orgName = activeOrg?.name ?? "your team";

  const steps = {
    download: { done: appInstalled, required: true },
    models: { done: modelsEnabled, required: true },
    mcp: { done: mcpAdded, required: false },
    marketplace: { done: forkDone || githubConnected, required: false },
  } as const;

  const doneCount = Object.values(steps).filter((s) => s.done).length;
  const requiredDone = steps.download.done && steps.models.done;
  const totalSteps = 4;
  const progressPct = (doneCount / totalSteps) * 100;

  const marketplacePluginTotal = marketplaces.reduce((sum, m) => sum + m.pluginCount, 0);

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
    <div className="mx-auto max-w-2xl px-4 pb-12 pt-6 sm:px-6">
      {/* Header */}
      <header className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#6C7890]">OpenWork Cloud</p>
        <h1 className="mt-3 text-[28px] font-semibold leading-[1.05] tracking-[-0.04em] text-[#07192C] sm:text-[34px]">
          {requiredDone ? `You're all set, ${orgName}.` : `Let's finish setting up ${orgName}.`}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[#5A6886]">
          {requiredDone
            ? "Models are on and the app is ready. Jump in, or finish the optional steps below."
            : "OpenWork runs on the desktop app. Download it, enable models, then add anything else you need."}
        </p>

        {/* Download CTA */}
        {!appInstalled ? (
          <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <a
              href={DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#07192C] px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-[#111c33] sm:w-auto"
            >
              <Download className="h-4 w-4" /> Download desktop app
            </a>
            <button
              type="button"
              onClick={() => setAppInstalled(true)}
              className="text-[13px] font-medium text-[#5A6886] transition hover:text-[#07192C]"
            >
              I&apos;ve installed it →
            </button>
          </div>
        ) : (
          <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-[13px] font-medium text-emerald-700">
            <Check className="h-4 w-4" /> Desktop app installed
          </div>
        )}

        {/* Progress */}
        <div className="mx-auto mt-6 max-w-xs">
          <div className="flex items-center justify-between text-[12px] font-medium text-[#6C7890]">
            <span>{doneCount} of {totalSteps} steps done</span>
            <span>{Math.round(progressPct)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </header>

      {/* Divider */}
      <div className="my-8 h-px bg-gray-100" />

      {/* Checklist */}
      <section>
        <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-[#07192C]">Set up your workspace</h2>
        <p className="mt-0.5 text-[13px] text-[#6C7890]">Required steps first. The rest are optional power-ups.</p>

        <div className="mt-5 space-y-3">
          {/* Step 1: Download app */}
          <StepCard
            done={appInstalled}
            required
            icon={<Download className="h-4 w-4" />}
            title="Get the desktop app"
            helper="Computer Use, Browser, Image Gen, and Google Workspace only run in the app."
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <a
                href={DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#07192C] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#111c33]"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
              <button
                type="button"
                onClick={() => setAppInstalled(true)}
                className="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium text-[#5A6886] transition hover:text-[#07192C]"
              >
                I&apos;ve installed it <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </StepCard>

          {/* Step 2: Enable models */}
          <StepCard
            done={modelsEnabled}
            required
            icon={<Sparkles className="h-4 w-4" />}
            title="Turn on OpenWork Models"
            helper="Best open-source and frontier models, ready to go. No API keys needed. Prefer your own provider? Use your own keys."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href={getInferenceRoute(orgSlug)}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#07192C] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#111c33]"
              >
                <Zap className="h-3.5 w-3.5" /> Enable models
              </Link>
              <Link
                href={getCustomLlmProvidersRoute(orgSlug)}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-gray-200 px-4 py-2 text-[13px] font-semibold text-[#07192C] transition hover:bg-gray-50"
              >
                Use your own keys
              </Link>
            </div>
          </StepCard>

          {/* Step 3: MCP */}
          <StepCard
            done={mcpAdded}
            required={false}
            icon={<Plug className="h-4 w-4" />}
            title="Use OpenWork in OpenCode, Codex, or any MCP app"
            helper="Copy the public OpenWork Connect endpoint. OpenCode is verified; Codex, Cursor Web/Agents, ChatGPT Desktop, Claude Code, VS Code, and other clients have setup guides."
          >
            <div className="space-y-2.5">
              <button
                type="button"
                aria-label={`Copy OpenWork MCP endpoint ${OPENWORK_MCP_ENDPOINT}`}
                onClick={copyMcpEndpoint}
                className="inline-flex max-w-full items-center justify-between gap-2 whitespace-normal rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-left text-[12px] font-mono text-[#07192C] transition hover:bg-gray-100"
              >
                <span className="min-w-0 break-all">{OPENWORK_MCP_ENDPOINT}</span>
                {copied ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />}
              </button>
              <p aria-live="polite" className="min-h-5 text-[12px] font-medium text-emerald-600">
                {copied ? "OpenWork MCP endpoint copied." : ""}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={OPENWORK_MCP_DOCS}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#164B8F] transition hover:text-[#0F376C]"
                >
                  Read docs <ArrowRight className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => setMcpAdded(!mcpAdded)}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#5A6886] transition hover:text-[#07192C]"
                >
                  {mcpAdded ? "✓ Added" : "Mark as added"}
                </button>
              </div>
            </div>
          </StepCard>

          {/* Step 4: Marketplace */}
          <StepCard
            done={forkDone || githubConnected}
            required={false}
            icon={<Store className="h-4 w-4" />}
            title="Stock your team marketplace"
            helper="Start from Anthropic's example plugins, or pull in your own from GitHub."
          >
            <div className="space-y-2.5">
              <SubCheckbox
                checked={forkDone}
                onClick={() => setForkDone(!forkDone)}
                label="Fork the starter plugins repo"
                action={
                  <a
                    href={ANTHROPIC_KNOWLEDGE_WORK_REPO}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] font-medium text-[#164B8F] transition hover:text-[#0F376C]"
                  >
                    <Github className="h-3.5 w-3.5" /> Open <ArrowRight className="h-3 w-3" />
                  </a>
                }
              />
              <SubCheckbox
                checked={githubConnected}
                label="Import from GitHub"
                action={
                  githubConnected ? (
                    <span className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-600">
                      <Check className="h-3.5 w-3.5" /> Connected
                    </span>
                  ) : (
                    <Link
                      href={getGithubIntegrationRoute(orgSlug)}
                      className="inline-flex items-center gap-1 text-[13px] font-medium text-[#164B8F] transition hover:text-[#0F376C]"
                    >
                      Connect <ArrowRight className="h-3 w-3" />
                    </Link>
                  )
                }
              />
              {marketplaces.length > 0 ? (
                <p className="pt-1 text-[12px] text-[#6C7890]">
                  {marketplaces.length} marketplace{marketplaces.length === 1 ? "" : "s"} · {marketplacePluginTotal} extension{marketplacePluginTotal === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          </StepCard>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-8 border-t border-gray-100 pt-5 text-center">
        <p className="text-[13px] text-[#6C7890]">
          Already set up?{" "}
          <Link href={getMarketplacesRoute(orgSlug)} className="font-medium text-[#164B8F] transition hover:text-[#0F376C]">
            View marketplaces
          </Link>{" "}
          ·{" "}
          <Link href={getOrgDashboardRoute(orgSlug)} className="font-medium text-[#164B8F] transition hover:text-[#0F376C]">
            Go to dashboard
          </Link>
        </p>
      </footer>
    </div>
  );
}
