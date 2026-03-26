"use client";
import { AnimatePresence, motion, useInView } from "framer-motion";
import { ArrowUp, ChevronDown, Cloud, CreditCard, Download, HardDrive, Key, Monitor, Paperclip, PlugZap, Shield, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { LandingAppDemoPanel } from "./landing-app-demo-panel";
import { LandingBackground } from "./landing-background";
import { LandingCloudWorkersCard } from "./landing-cloud-workers-card";
import {
  defaultLandingDemoFlowId,
  landingDemoFlows,
  landingDemoFlowTimes
} from "./landing-demo-flows";
import { LandingSharePackageCard } from "./landing-share-package-card";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { WaitlistForm } from "./waitlist-form";

type Props = {
  stars: string;
  downloadHref: string;
  callHref: string;
  isMobileVisitor: boolean;
};

const externalLinkProps = (href: string) =>
  /^https?:\/\//.test(href)
    ? { rel: "noreferrer", target: "_blank" as const }
    : {};

const providerOptions = [
  {
    id: "subscription",
    label: "Use your existing subscription",
    icon: CreditCard,
    description:
      "Claude Pro/Max, ChatGPT Pro/Plus. Connect the accounts you already pay for. No extra AI costs.",
    barProvider: "Anthropic · Claude Opus 4.6",
  },
  {
    id: "byok",
    label: "BYOK",
    icon: Key,
    description:
      "Use 50+ LLMs, bring your own keys, connect your gateway. Switch between tasks.",
    barProvider: "OpenRouter · GPT-5.4",
  },
  {
    id: "local",
    label: "Local models",
    icon: HardDrive,
    description:
      "Run Ollama or any local model. Your data never leaves your machine. Full data residency compliance.",
    barProvider: "Ollama · gpt-oss:20b",
  },
];

export function LandingHome(props: Props) {
  const [activeDemoId, setActiveDemoId] = useState(defaultLandingDemoFlowId);
  const [activeUseCase, setActiveUseCase] = useState(0);
  const [activeProvider, setActiveProvider] = useState(0);
  const enterpriseShowcaseRef = useRef<HTMLElement>(null);
  const showEnterpriseShowcase = useInView(enterpriseShowcaseRef, {
    once: true,
    margin: "-15% 0px"
  });

  const activeDemo = useMemo(
    () => landingDemoFlows.find((flow) => flow.id === activeDemoId) ?? landingDemoFlows[0],
    [activeDemoId]
  );

  const downloadLinkProps = externalLinkProps(props.downloadHref);
  const callLinkProps = externalLinkProps(props.callHref);
  const primaryCtaHref = props.isMobileVisitor
    ? "https://app.openworklabs.com"
    : "/download";
  const primaryCtaLabel = props.isMobileVisitor
    ? "Open the app"
    : "Download";
  const primaryCtaLinkProps = props.isMobileVisitor
    ? {}
    : externalLinkProps(primaryCtaHref);

  return (
    <div className="relative min-h-screen text-[#011627]">
      <LandingBackground />

      <SiteNav
        stars={props.stars}
        downloadHref={props.downloadHref}
        callUrl={props.callHref}
        mobilePrimaryHref="https://app.openworklabs.com"
        mobilePrimaryLabel="Open app"
        active="home"
      />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">

        <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-4xl pt-8 md:pt-12">
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-lg border border-gray-100 bg-white px-3 py-1.5 shadow-[0_1px_2px_rgba(17,24,39,0.06)]">
              <span className="text-[14px] font-medium text-gray-700">Backed by</span>
              <div className="flex h-[20px] w-[20px] items-center justify-center rounded-[5px] bg-[#ff6600] text-[12px] font-bold leading-none text-white">
                Y
              </div>
              <span className="text-[14px] font-medium text-gray-700">Combinator</span>
            </div>
            <h1 className="mb-5 text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl lg:text-6xl">
              Open source Claude Cowork<br />for your team
            </h1>
            <p className="mb-6 text-lg leading-relaxed text-gray-600 md:mb-7 md:text-xl">
              OpenWork is the desktop app that lets you use 50+ LLMs, bring your
              own keys, and share your setups seamlessly with your team.
            </p>

            <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <a
                  href={primaryCtaHref}
                  className="doc-button inline-flex items-center gap-2"
                  {...primaryCtaLinkProps}
                >
                  {primaryCtaLabel} <Download size={18} />
                </a>
                <a
                  href={props.callHref}
                  className="secondary-button"
                  {...callLinkProps}
                >
                  Contact sales
                </a>
              </div>

            </div>
          </section>

          {props.isMobileVisitor ? (
            <section
              id="mobile-signup"
              className="landing-shell-soft -mt-6 rounded-xl p-6 md:hidden"
            >
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
                Mobile signup
              </div>
              <h2 className="mb-3 text-2xl font-medium leading-tight text-[#011627]">
                Start on mobile. Continue on desktop.
              </h2>
              <p className="mb-5 text-[15px] leading-7 text-gray-600">
                OpenWork is a desktop app. Sign up here from your phone and keep the
                desktop install flow handy for when you switch to your computer.
              </p>
              <WaitlistForm contactHref={props.callHref} />
              <p className="mt-4 text-[13px] leading-6 text-gray-500">
                Best path on mobile: landing, signup, then download on desktop.
              </p>
            </section>
          ) : null}

          <section className="relative flex flex-col gap-6 overflow-hidden md:gap-8">
            <div className="landing-shell relative flex flex-col overflow-hidden rounded-xl">
              <div className="relative z-20 flex h-10 w-full shrink-0 items-center border-b border-white/50 bg-gradient-to-b from-white/90 to-white/60 px-4">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full border border-[#e0443e]/20 bg-[#ff5f56]/90 shadow-sm"></div>
                  <div className="h-3 w-3 rounded-full border border-[#dea123]/20 bg-[#ffbd2e]/90 shadow-sm"></div>
                  <div className="h-3 w-3 rounded-full border border-[#1aab29]/20 bg-[#27c93f]/90 shadow-sm"></div>
                </div>
                <div className="absolute left-1/2 -translate-x-1/2 text-[12px] font-medium tracking-wide text-gray-500">
                  OpenWork
                </div>
              </div>
 
              <div className="bg-white p-4 md:p-6">
                <LandingAppDemoPanel
                  flows={landingDemoFlows}
                  activeFlowId={activeDemo.id}
                  onSelectFlow={setActiveDemoId}
                  timesById={landingDemoFlowTimes}
                />
              </div>

              <div className="flex w-full flex-col items-start justify-between gap-4 border-t border-gray-100 px-4 py-4 md:flex-row md:items-center md:px-6">
                <div className="landing-chip flex w-full flex-wrap gap-2 overflow-x-auto rounded-lg p-1.5 md:w-[600px]">
                  {landingDemoFlows.map((flow) => {
                    const isActive = flow.id === activeDemo.id;

                    return (
                      <button
                        key={flow.id}
                        type="button"
                        onClick={() => setActiveDemoId(flow.id)}
                        aria-pressed={isActive}
                        className={`relative cursor-pointer whitespace-nowrap rounded-lg px-5 py-2 text-sm font-medium transition-colors ${
                          isActive
                            ? "text-[#011627]"
                            : "text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        {isActive ? (
                          <motion.div
                            layoutId="active-pill"
                            className="absolute inset-0 rounded-lg border border-gray-100 bg-white shadow-sm"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                          />
                        ) : null}
                        <span className="relative z-10">{flow.categoryLabel}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="min-h-[44px] text-left md:text-right">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeDemo.id}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.2 }}
                    >
                      <div className="text-lg font-medium text-[#011627]">
                        {activeDemo.title}
                      </div>
                      <div className="ml-auto mt-1 max-w-md text-sm text-gray-500">
                        {activeDemo.description}
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-6 md:grid-cols-3">
            <div className="landing-shell flex flex-col rounded-xl p-6">
              <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
                <Monitor size={18} />
                Desktop
              </div>
              <h2 className="mb-3 text-xl font-medium tracking-tight">Local AI worker</h2>
              <p className="mb-6 flex-1 text-sm leading-relaxed text-gray-500">
                Start free on desktop with no signup, then automate email, Slack,
                and the work you do every day.
              </p>
              <div>
                <a href="/download" className="secondary-button">Learn more</a>
              </div>
            </div>

            <div className="landing-shell flex flex-col rounded-xl p-6">
              <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
                <Cloud size={18} />
                Cloud
              </div>
              <h2 className="mb-3 text-xl font-medium tracking-tight">Hosted sandboxed workers</h2>
              <p className="mb-6 flex-1 text-sm leading-relaxed text-gray-500">
                Run those same workers in the cloud when you need them always on,
                without hosting them yourself.
              </p>
              <div>
                <a href="/den" className="secondary-button">Learn more</a>
              </div>
            </div>

            <div className="landing-shell flex flex-col rounded-xl p-6">
              <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
                <Shield size={18} />
                Enterprise
              </div>
              <h2 className="mb-3 text-xl font-medium tracking-tight">Safe workflow sharing</h2>
              <p className="mb-6 flex-1 text-sm leading-relaxed text-gray-500">
                Deploy on your infrastructure. Full audit trails, admin controls,
                and data that never leaves your network.
              </p>
              <div>
                <a href="/enterprise" className="secondary-button">Learn more</a>
              </div>
            </div>
          </section>

          <section className="landing-shell rounded-xl p-6 md:p-8">
            <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
              <PlugZap size={18} />
              LLM Provider
            </div>
            <h2 className="mb-8 max-w-2xl text-2xl font-medium leading-[1.15] tracking-tight md:text-3xl">
              Choose your LLM provider. Switch anytime.
            </h2>

            {/* Top: three selection cards in a row */}
            <div className="mb-6 grid gap-3 sm:grid-cols-3">
              {providerOptions.map((opt, i) => {
                const isActive = i === activeProvider;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`cursor-pointer rounded-xl border bg-white px-4 py-4 text-left transition-all ${
                      isActive
                        ? "border-[#011627] shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                    onClick={() => setActiveProvider(i)}
                  >
                    <div className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-[#011627]">
                      <Icon size={16} />
                    </div>
                    <h3 className="mb-1 text-sm font-medium text-[#011627]">
                      {opt.label}
                    </h3>
                    <p className="text-[13px] leading-relaxed text-gray-500">
                      {opt.description}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Bottom: full-width app mockup */}
            <div className="landing-shell-soft flex items-center justify-center rounded-xl p-4 md:p-6">
              <div className="w-full max-w-lg">
                {/* Composer mockup */}
                <div className="rounded-[20px] border border-gray-200 bg-white p-4">
                  {/* Placeholder text */}
                  <div className="mb-8 text-[14px] text-gray-400">
                    Describe your task...
                  </div>
                  {/* Bottom row: attach + run task */}
                  <div className="flex items-center justify-between">
                    <div className="rounded-md p-1.5 text-gray-400">
                      <Paperclip size={16} />
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-[#011627] px-4 py-2 text-[13px] font-medium text-white">
                      <ArrowUp size={15} />
                      <span>Run task</span>
                    </div>
                  </div>
                </div>
                {/* Model selector bar */}
                <div className="mt-2 flex items-center px-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-medium text-[#011627]">
                      {providerOptions[activeProvider].barProvider}
                    </span>
                    <ChevronDown size={14} className="text-gray-400" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            ref={enterpriseShowcaseRef}
            className="landing-shell rounded-xl p-6 md:p-8"
          >
            <div className="mb-4 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
              <Users size={18} />
              For Teams &amp; Enterprises
            </div>
            <h2 className="mb-10 max-w-2xl text-2xl font-medium leading-[1.15] tracking-tight md:text-3xl">
              Build skills, workflows, connections once.<br />Share a link. Your team runs it instantly.
            </h2>

            <div className="flex flex-col gap-10 lg:flex-row lg:gap-16">
              <div className="flex w-full flex-col gap-2 lg:w-1/3">
                <button
                  type="button"
                  className={`cursor-pointer rounded-xl border bg-white px-4 py-3 text-left transition-all ${
                    activeUseCase === 0
                      ? "border-[#011627] shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setActiveUseCase(0)}
                >
                  <h3 className="mb-1 text-sm font-medium text-[#011627]">
                    Share everything in one link.
                  </h3>
                  <p className="text-sm leading-relaxed text-gray-500">
                    Create skills, MCPs, plugins, and configs on your desktop.
                    Generate a single link that packages your entire setup for
                    your team.
                  </p>
                </button>

                <button
                  type="button"
                  className={`cursor-pointer rounded-xl border bg-white px-4 py-3 text-left transition-all ${
                    activeUseCase === 1
                      ? "border-[#011627] shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setActiveUseCase(1)}
                >
                  <h3 className="mb-1 text-sm font-medium text-[#011627]">
                    Import in one click.
                  </h3>
                  <p className="text-sm leading-relaxed text-gray-500">
                    Your teammate opens the link and imports everything. Skills,
                    MCPs, plugins, configs. No terminal, no setup guide, no
                    technical knowledge needed.
                  </p>
                </button>

                <button
                  type="button"
                  className={`cursor-pointer rounded-xl border bg-white px-4 py-3 text-left transition-all ${
                    activeUseCase === 2
                      ? "border-[#011627] shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  onClick={() => setActiveUseCase(2)}
                >
                  <h3 className="mb-1 text-sm font-medium text-[#011627]">
                    Ready to run.
                  </h3>
                  <p className="text-sm leading-relaxed text-gray-500">
                    Everything imported. Skills already executing.
                  </p>
                </button>
              </div>

              <div className="landing-shell-soft relative flex w-full items-center justify-center overflow-hidden rounded-xl p-4 lg:w-2/3 md:p-6">
                {showEnterpriseShowcase ? (
                  <div className="grid w-full [&>*]:col-start-1 [&>*]:row-start-1">
                    <motion.div
                      animate={{ opacity: activeUseCase === 0 ? 1 : 0 }}
                      transition={{ duration: 0.2 }}
                      className={`z-10 flex w-full justify-center ${activeUseCase !== 0 ? "pointer-events-none" : ""}`}
                    >
                      <LandingSharePackageCard />
                    </motion.div>
                    <motion.div
                      animate={{ opacity: activeUseCase === 1 ? 1 : 0 }}
                      transition={{ duration: 0.2 }}
                      className={`z-10 flex w-full justify-center ${activeUseCase !== 1 ? "pointer-events-none" : ""}`}
                    >
                      <LandingCloudWorkersCard />
                    </motion.div>
                    <motion.div
                      animate={{ opacity: activeUseCase === 2 ? 1 : 0 }}
                      transition={{ duration: 0.2 }}
                      className={`z-10 flex w-full justify-center ${activeUseCase !== 2 ? "pointer-events-none" : ""}`}
                    >
                        <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                          {/* App chrome */}
                          <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
                            <div className="flex gap-1.5">
                              <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                              <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
                              <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
                            </div>
                            <div className="text-[12px] font-medium text-gray-500">OpenWork</div>
                          </div>

                          <div className="flex flex-1">
                            {/* Sidebar */}
                            <div className="hidden w-[180px] flex-col border-r border-gray-100 bg-gray-50/50 p-3 sm:flex">
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between rounded-lg bg-white px-2.5 py-2 shadow-sm">
                                  <div className="flex items-center gap-2">
                                    <span className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-400 to-orange-400" />
                                    <span className="text-[11px] font-medium text-[#011627]">Meeting Brief</span>
                                  </div>
                                  <span className="text-[9px] text-green-600">Active</span>
                                </div>
                                <div className="flex items-center justify-between rounded-lg px-2.5 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-400 to-orange-400" />
                                    <span className="text-[11px] font-medium text-gray-600">Contract Reviewer</span>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between rounded-lg px-2.5 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-400 to-orange-400" />
                                    <span className="text-[11px] font-medium text-gray-600">Outreach CRM</span>
                                  </div>
                                </div>
                              </div>

                              <div className="mt-4 flex flex-col gap-1 border-t border-gray-100 pt-3">
                                <div className="truncate rounded-lg bg-white px-2.5 py-1.5 text-[10px] text-gray-500 shadow-sm">
                                  Generate brief for Acme...
                                  <span className="ml-1 text-gray-400">1s ago</span>
                                </div>
                                <div className="truncate px-2.5 py-1.5 text-[10px] text-gray-400">
                                  Review NDA draft...
                                  <span className="ml-1">12m ago</span>
                                </div>
                              </div>
                            </div>

                            {/* Main content - chat */}
                            <div className="flex flex-1 flex-col">
                              <div className="flex flex-1 flex-col gap-4 p-4">
                                {/* User prompt */}
                                <div className="self-end rounded-2xl rounded-br-md bg-gray-100 px-4 py-2.5 text-[12px] leading-relaxed text-[#011627]">
                                  Prepare a meeting brief for tomorrow&apos;s call with Acme Corp. Pull context from HubSpot and Notion.
                                </div>

                                {/* Execution timeline */}
                                <div className="flex flex-col gap-1 pl-1">
                                  <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                                    <span className="text-gray-300">&rsaquo;</span> Execution 1 step — Queried HubSpot MCP for deal history
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                                    <span className="text-gray-300">&rsaquo;</span> Execution 2 steps — Pulled Notion meeting notes
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                                    <span className="text-gray-300">&rsaquo;</span> Execution 1 step — Generated brief and saved to desktop
                                  </div>
                                </div>

                                {/* Response */}
                                <div className="text-[12px] leading-relaxed text-[#011627]">
                                  I&apos;ve prepared your meeting brief for the Acme Corp call. It includes deal history, recent notes, and 3 talking points.
                                </div>
                              </div>

                              {/* Input bar */}
                              <div className="border-t border-gray-100 p-3">
                                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
                                  <span className="text-[12px] text-gray-400">Describe your task</span>
                                  <span className="rounded-full bg-[#011627] px-3 py-1 text-[10px] font-medium text-white">Run Task</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                    </motion.div>
                  </div>
                ) : (
                  <div className="z-10 flex w-full justify-center">
                    <div className="landing-shell h-[320px] w-full max-w-lg rounded-xl border border-dashed border-gray-200" />
                  </div>
                )}
              </div>
            </div>
          </section>

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
