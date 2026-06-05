"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Download, Github, Monitor, Puzzle, Sparkles, Store, Zap } from "lucide-react";
import {
  getGithubIntegrationRoute,
  getIntegrationsRoute,
  getMarketplacesRoute,
  getOrgDashboardRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMarketplaces } from "./marketplace-data";

const ANTHROPIC_KNOWLEDGE_WORK_REPO = "https://github.com/anthropics/knowledge-work-plugins";
const OPENWORK_MCP_DOCS = "https://github.com/different-ai/openwork/blob/dev/docs/mcp-ui-control-profile.md";

type OnboardingStep = 0 | 1 | 2;

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? "w-6 bg-white" : "w-1.5 bg-white/30"
          }`}
        />
      ))}
    </div>
  );
}

function StepDotsLight({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? "w-6 bg-[#07192C]" : "w-1.5 bg-gray-300"
          }`}
        />
      ))}
    </div>
  );
}

export function MarketplaceOnboardingScreen() {
  const { activeOrg, orgSlug } = useOrgDashboard();
  const { data: marketplaces = [], isLoading } = useMarketplaces();
  const [step, setStep] = useState<OnboardingStep>(0);

  const orgName = activeOrg?.name ?? "Your team";

  return (
    <div className="mx-auto max-w-[1120px] px-3 pb-8 pt-3 sm:px-6 sm:pb-10 sm:pt-4 md:px-8">

      {/* ── Mobile: stepped onboarding ────────────────────────────── */}
      <div className="sm:hidden">
        {step === 0 ? (
          <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
            <section className="flex flex-1 flex-col overflow-hidden rounded-[24px] bg-[#07192C] text-white shadow-sm">
              <div className="flex flex-1 flex-col justify-between p-5">
                <div>
                  <StepDots current={0} total={3} />
                  <h1 className="mt-5 text-[28px] font-semibold leading-[0.98] tracking-[-0.05em]">
                    You&apos;re all set.
                  </h1>
                  <p className="mt-2 text-[14px] leading-6 text-white/60">
                    {orgName} is ready. We set up two starter marketplaces for your team.
                  </p>
                </div>

                <div className="mt-5 rounded-[18px] border border-white/10 bg-white/[0.06] p-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-300/90 text-[#07192C]">
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <p className="text-[13px] font-semibold">OpenWork Models</p>
                  </div>
                  <p className="mt-2 text-[13px] leading-5 text-white/55">
                    Below-market-rate AI. No API keys needed to start, or bring your own.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Link href="/dashboard/inference" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2 text-[12px] font-semibold text-[#07192C]">
                      <Zap className="h-3.5 w-3.5" /> Enable
                    </Link>
                    <Link href="/dashboard/custom-llm-providers" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-white/20 px-3 py-2 text-[12px] font-semibold text-white">
                      Own keys
                    </Link>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/15 px-4 py-3 text-[14px] font-semibold text-white transition hover:bg-white/10"
                >
                  Next <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </section>
          </div>
        ) : step === 1 ? (
          <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
            <section className="flex flex-1 flex-col overflow-hidden rounded-[24px] border border-[#d7e2f5] bg-gradient-to-br from-[#F4F8FF] to-[#EEF3FF] shadow-sm">
              <div className="flex flex-1 flex-col justify-between p-5">
                <div>
                  <StepDotsLight current={1} total={3} />
                  <h1 className="mt-5 text-[28px] font-semibold leading-[0.98] tracking-[-0.05em] text-[#07192C]">
                    Download the app.
                  </h1>
                  <p className="mt-2 text-[14px] leading-6 text-[#526582]">
                    Sign in with this account to unlock built-in extensions.
                  </p>
                </div>

                <div className="mt-5 space-y-3">
                  {[
                    { icon: Monitor, name: "Computer Use", desc: "Control Mac apps with AI" },
                    { icon: Monitor, name: "Browser", desc: "Automate the built-in browser" },
                    { icon: Monitor, name: "Image Gen", desc: "Generate images with GPT" },
                    { icon: Monitor, name: "Google Workspace", desc: "Calendar, Drive, Gmail" },
                  ].map((ext) => (
                    <div key={ext.name} className="flex items-center gap-3 rounded-2xl bg-white/80 px-4 py-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#07192C] text-white">
                        <ext.icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold text-[#07192C]">{ext.name}</p>
                        <p className="text-[12px] text-[#526582]">{ext.desc}</p>
                      </div>
                    </div>
                  ))}
                  <p className="px-1 text-[12px] text-[#526582]">
                    Plus your team&apos;s marketplace extensions.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#07192C] px-4 py-3 text-[14px] font-semibold text-white shadow-[0_14px_32px_-20px_rgba(1,22,39,0.45)]"
                >
                  Next <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </section>
          </div>
        ) : (
          <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
            <section className="flex flex-1 flex-col overflow-hidden rounded-[24px] border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-1 flex-col justify-between p-5">
                <div>
                  <StepDotsLight current={2} total={3} />
                  <h1 className="mt-5 text-[28px] font-semibold leading-[0.98] tracking-[-0.05em] text-[#07192C]">
                    Create your own.
                  </h1>
                  <p className="mt-2 text-[14px] leading-6 text-[#526582]">
                    Import plugins from a GitHub repo and share them with your team through a marketplace.
                  </p>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                    <div className="flex items-center gap-2.5">
                      <Github className="h-5 w-5 text-[#07192C]" />
                      <p className="text-[14px] font-semibold text-[#07192C]">Try the starter repo</p>
                    </div>
                    <p className="mt-2 text-[13px] leading-5 text-[#526582]">
                      Fork <span className="font-medium text-[#07192C]">anthropics/knowledge-work-plugins</span>, connect your GitHub, and import the example plugins.
                    </p>
                    <a
                      href={ANTHROPIC_KNOWLEDGE_WORK_REPO}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#164B8F]"
                    >
                      Open on GitHub <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                    <div className="flex items-center gap-2.5">
                      <Puzzle className="h-5 w-5 text-[#07192C]" />
                      <p className="text-[14px] font-semibold text-[#07192C]">Or use the MCP</p>
                    </div>
                    <p className="mt-2 text-[13px] leading-5 text-[#526582]">
                      Ask any AI app to package and distribute plugins through OpenWork.
                    </p>
                    <pre className="mt-2 rounded-lg bg-[#07192C] px-3 py-2 text-[11px] text-cyan-100"><code>npx openwork-ui-mcp</code></pre>
                  </div>
                </div>

                <div className="mt-4 grid gap-2">
                  <Link
                    href={getGithubIntegrationRoute(orgSlug)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#07192C] px-4 py-3 text-[14px] font-semibold text-white shadow-[0_14px_32px_-20px_rgba(1,22,39,0.45)]"
                  >
                    Connect GitHub <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href={getOrgDashboardRoute(orgSlug)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-gray-200 px-4 py-3 text-[14px] font-semibold text-gray-700"
                  >
                    Go to dashboard
                  </Link>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>

      {/* ── Desktop/tablet: full onboarding layout ────────────────── */}
      <div className="hidden sm:block">
        {/* Hero */}
        <section className="overflow-hidden rounded-[28px] border border-[#dfe5f0] bg-[#07192C] text-white shadow-sm">
          <div className="grid gap-6 p-6 md:grid-cols-[1.3fr_0.7fr] md:p-10">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.26em] text-cyan-200">OpenWork Cloud</p>
              <h1 className="mt-4 max-w-2xl text-[36px] font-semibold leading-[1.02] tracking-[-0.045em] md:text-[46px]">
                You&apos;re all set.
              </h1>
              <p className="mt-3 max-w-xl text-[15px] leading-7 text-white/65">
                We set up two starter marketplaces for {orgName}.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href={getMarketplacesRoute(orgSlug)} className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-white/90">
                  View marketplaces <ArrowRight className="h-4 w-4" />
                </Link>
                <Link href={getOrgDashboardRoute(orgSlug)} className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-white/10">
                  Go to dashboard
                </Link>
              </div>
            </div>

            <div className="rounded-[22px] border border-white/10 bg-white/[0.06] p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-300 text-[#07192C]">
                  <Monitor className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[14px] font-semibold">Get the desktop app</p>
                  <p className="mt-0.5 text-[12px] leading-5 text-white/55">Sign in to unlock Computer Use, Browser, Image Gen, Google Workspace, and your team&apos;s extensions.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* OpenWork Models */}
        <section className="mt-6 overflow-hidden rounded-[28px] border border-[#d7e2f5] bg-gradient-to-br from-[#F4F8FF] to-[#EEF3FF] p-6 shadow-sm md:p-8">
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center md:gap-8">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#07192C] text-amber-300">
                  <Sparkles className="h-4 w-4" />
                </div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#41618F]">OpenWork Models</p>
              </div>
              <h2 className="mt-3 text-[24px] font-semibold tracking-[-0.03em] text-[#07192C]">
                Below-market-rate AI models, ready to go.
              </h2>
              <p className="mt-2 text-[14px] leading-6 text-[#526582]">
                The best open-source and frontier models to get work done. No API keys needed to start.
                Prefer your own provider? Bring your own keys instead.
              </p>
            </div>
            <div className="flex flex-row gap-2 md:flex-col">
              <Link href="/dashboard/inference" className="inline-flex items-center justify-center gap-2 rounded-full bg-[#07192C] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_14px_32px_-20px_rgba(1,22,39,0.45)] transition hover:bg-black">
                <Zap className="h-4 w-4" /> Enable OpenWork Models
              </Link>
              <Link href="/dashboard/custom-llm-providers" className="inline-flex items-center justify-center gap-2 rounded-full border border-[#d8e0ec] px-5 py-2.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-white">
                Use your own keys
              </Link>
            </div>
          </div>
        </section>

        {/* Starter marketplace cards */}
        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {(isLoading ? [] : marketplaces).map((marketplace) => {
            const isOpenWork = marketplace.name === "OpenWork Marketplace";
            const description = isOpenWork
              ? "Built-in tools like Computer Use, Browser, Image Gen, and Google Workspace."
              : marketplace.pluginCount > 0
                ? marketplace.description
                : "Connect a GitHub repo to import plugins here.";
            return (
              <Link
                key={marketplace.id}
                href={`${getMarketplacesRoute(orgSlug)}/${encodeURIComponent(marketplace.id)}`}
                className="rounded-[22px] border border-[#e2e7f0] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cfd8e8] hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#EDF4FF] text-[#164B8F]">
                    <Store className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="truncate text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">{isOpenWork ? "OpenWork Marketplace" : "Community Plugins"}</h2>
                      <span className="shrink-0 text-[12px] font-medium text-[#667695]">{marketplace.pluginCount} ext{marketplace.pluginCount === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                </div>
                {description ? <p className="mt-2.5 text-[13px] leading-6 text-[#5C6B86]">{description}</p> : null}
              </Link>
            );
          })}
          {isLoading ? (
            <div className="rounded-[22px] border border-[#e2e7f0] bg-white p-5 text-[13px] text-[#667695] shadow-sm">Loading...</div>
          ) : null}
        </section>

        {/* Next steps */}
        <section className="mt-6 grid gap-4 lg:grid-cols-3">
          <ActionCard
            icon={<Download className="h-5 w-5" />}
            title="Get the app"
            body="Free download. Sign in to unlock your team marketplaces."
            href={getOrgDashboardRoute(orgSlug)}
            label="Download"
          />
          <ActionCard
            icon={<Github className="h-5 w-5" />}
            title="Import from GitHub"
            body="Fork the starter repo and import plugins to your marketplace."
            href={getGithubIntegrationRoute(orgSlug)}
            label="Connect GitHub"
          />
          <ActionCard
            icon={<Puzzle className="h-5 w-5" />}
            title="Add integrations"
            body="Package skills, agents, or MCPs as plugins."
            href={getIntegrationsRoute(orgSlug)}
            label="Browse integrations"
          />
        </section>

        {/* Starter repo + MCP */}
        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-[22px] border border-[#e2e7f0] bg-white p-6 shadow-sm">
            <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#6C7890]">Starter repo</p>
            <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.03em] text-[#07192C]">Try Knowledge Work Plugins</h2>
            <p className="mt-2 text-[13px] leading-6 text-[#5C6B86]">
              A GitHub repo with example plugins. Fork it and connect to see how import works.
            </p>
            <a href={ANTHROPIC_KNOWLEDGE_WORK_REPO} target="_blank" rel="noreferrer" className="mt-3 inline-flex max-w-full items-center gap-2 text-[13px] font-semibold text-[#164B8F] transition hover:text-[#0F376C]">
              Open on GitHub <ArrowRight className="h-4 w-4" />
            </a>
          </div>
          <div className="rounded-[22px] border border-[#d7e2f5] bg-[#F4F8FF] p-6 shadow-sm">
            <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#41618F]">Use with any AI app</p>
            <h2 className="mt-2 text-[18px] font-semibold tracking-[-0.03em] text-[#07192C]">OpenWork MCP</h2>
            <p className="mt-2 text-[13px] leading-6 text-[#526582]">
              Add the MCP server to Claude, Cursor, or any app that supports MCP.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-[#07192C] px-4 py-3 text-[12px] leading-6 text-cyan-100"><code>npx openwork-ui-mcp</code></pre>
            <a href={OPENWORK_MCP_DOCS} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-[13px] font-semibold text-[#164B8F] transition hover:text-[#0F376C]">
              Read docs <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

function ActionCard({ icon, title, body, href, label }: {
  icon: React.ReactNode;
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  return (
    <Link href={href} className="flex items-start gap-4 rounded-[22px] border border-[#e2e7f0] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cfd8e8] hover:shadow-md">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#07192C] text-white">{icon}</div>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-[#07192C]">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-[#5C6B86]">{body}</p>
        <span className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-[#164B8F]">
          {label} <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}
