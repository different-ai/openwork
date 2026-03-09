"use client";

import Link from "next/link";
import { AnimatePresence, motion, useInView } from "framer-motion";
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
import { ResponsiveGrain } from "./responsive-grain";
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

export function LandingHome(props: Props) {
  const [activeDemoId, setActiveDemoId] = useState(defaultLandingDemoFlowId);
  const [activeUseCase, setActiveUseCase] = useState(0);
  const enterpriseShowcaseRef = useRef<HTMLElement>(null);
  const showEnterpriseShowcase = useInView(enterpriseShowcaseRef, {
    once: true,
    margin: "-15% 0px"
  });
  const showEnterpriseGrain = useInView(enterpriseShowcaseRef, {
    margin: "-15% 0px"
  });

  const activeDemo = useMemo(
    () => landingDemoFlows.find((flow) => flow.id === activeDemoId) ?? landingDemoFlows[0],
    [activeDemoId]
  );

  const downloadLinkProps = externalLinkProps(props.downloadHref);
  const callLinkProps = externalLinkProps(props.callHref);
  const primaryCtaHref = props.isMobileVisitor ? "#mobile-signup" : props.downloadHref;
  const primaryCtaLabel = props.isMobileVisitor
    ? "Sign up for desktop access"
    : "Download for free";
  const primaryCtaLinkProps = props.isMobileVisitor ? {} : downloadLinkProps;

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            downloadHref={props.downloadHref}
            callUrl={props.callHref}
            mobilePrimaryHref="#mobile-signup"
            mobilePrimaryLabel="Sign up"
            active="home"
          />
        </div>

        <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-3xl">
            <h1 className="mb-5 text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl lg:text-6xl">
              The open source
              <br />
              Claude Cowork
              <br />
              <span className="font-pixel inline-block align-middle text-[1.05em] font-normal">
                alternative.
              </span>
            </h1>
            <p className="mb-6 max-w-4xl text-lg leading-relaxed text-gray-700 md:mb-7 md:text-xl">
              OpenWork is the desktop app that lets you use 50+ LLMs, bring your
              own keys, and share your setups seamlessly with your team.
            </p>

            <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <a
                  href={primaryCtaHref}
                  className="doc-button"
                  {...primaryCtaLinkProps}
                >
                  {primaryCtaLabel}
                </a>
                <a
                  href={props.callHref}
                  className="secondary-button"
                  {...callLinkProps}
                >
                  Contact sales
                </a>
              </div>

              <div className="flex items-center gap-2 opacity-80 sm:ml-4">
                <span className="text-[13px] font-medium text-gray-500">
                  Backed by
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] font-bold leading-none text-white">
                    Y
                  </div>
                  <span className="text-[13px] font-semibold tracking-tight text-gray-600">
                    Combinator
                  </span>
                </div>
              </div>
            </div>
          </section>

          {props.isMobileVisitor ? (
            <section
              id="mobile-signup"
              className="landing-shell-soft -mt-6 rounded-[2rem] p-6 md:hidden"
            >
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400">
                Mobile signup
              </div>
              <h2 className="mb-3 text-2xl font-medium leading-tight text-[#011627]">
                Start on mobile. Continue on desktop.
              </h2>
              <p className="mb-5 text-[15px] leading-7 text-gray-600">
                OpenWork is a desktop app. Sign up here from your phone and keep the
                desktop install flow handy for when you switch to your computer.
              </p>
              <WaitlistForm />
              <p className="mt-4 text-[13px] leading-6 text-gray-500">
                Best path on mobile: landing, signup, then download on desktop.
              </p>
            </section>
          ) : null}

          <section className="relative flex flex-col gap-6 overflow-hidden md:gap-8">
            <div className="landing-shell relative flex flex-col overflow-hidden rounded-2xl">
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
            </div>

            <div className="relative z-10 mb-4 flex w-full flex-col items-start justify-between gap-4 px-2 md:flex-row md:items-center">
              <div className="landing-chip flex w-full flex-wrap gap-2 overflow-x-auto rounded-full p-1.5 md:w-[600px]">
                {landingDemoFlows.map((flow) => {
                  const isActive = flow.id === activeDemo.id;

                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setActiveDemoId(flow.id)}
                      aria-pressed={isActive}
                      className={`relative cursor-pointer whitespace-nowrap rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "text-[#011627]"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      {isActive ? (
                        <motion.div
                          layoutId="active-pill"
                          className="absolute inset-0 rounded-full border border-gray-100 bg-white shadow-sm"
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
          </section>

          <section className="mt-4 md:mt-6">
            <div className="mb-10 grid gap-10 md:mb-12 md:grid-cols-2 md:gap-12">
              <div>
                <h2 className="mb-3 text-2xl font-medium">OpenWork Desktop</h2>
                <p className="mb-6 text-lg leading-relaxed text-gray-600">
                  {props.isMobileVisitor
                    ? "Sign up from your phone now, then download OpenWork on desktop when you are back at your computer."
                    : "Start free on desktop with no signup, then automate email, Slack, and the work you do every day."}
                </p>
                <a href={primaryCtaHref} className="doc-button" {...primaryCtaLinkProps}>
                  {primaryCtaLabel}
                </a>
              </div>

              <div>
                <h2 className="mb-3 text-2xl font-medium">OpenWork Den</h2>
                <p className="mb-6 text-lg leading-relaxed text-gray-600">
                  Run those same workers in the cloud when you need them always
                  on, without hosting them yourself.
                </p>
                <Link
                  href="/den"
                  className="secondary-button text-sm"
                >
                  Learn More
                </Link>
              </div>
            </div>
          </section>

          <section className="mt-4 max-w-3xl md:mt-6">
            <div className="mb-4 font-medium text-gray-500">OpenWork Den</div>
            <h2 className="mb-6 text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl lg:text-6xl">
              Hosted sandboxed workers
              <br />
              for your team
            </h2>
            <p className="mb-8 text-lg leading-relaxed text-gray-700 md:text-xl">
              Den gives your team hosted sandboxed workers that you can access
              from our desktop app, Slack, or Telegram. All your skills,
              agents, and MCP integrations are directly available.
            </p>
            <Link href="/den" className="doc-button">
              Get started
            </Link>
          </section>

          <section
            ref={enterpriseShowcaseRef}
            className="landing-shell mt-4 rounded-[2.5rem] p-8 md:mt-6 md:p-12"
          >
            <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
              For Enterprises, Startups &amp; Teams
            </div>
            <h2 className="mb-16 max-w-2xl text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl lg:text-5xl">
              Package once, run everywhere. Safe workflow sharing.
            </h2>

            <div className="flex flex-col gap-12 lg:flex-row lg:gap-20">
              <div className="flex w-full flex-col gap-10 lg:w-1/3">
                <button
                  type="button"
                  className={`${
                    activeUseCase === 0 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(0)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 0 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Build Once, Share Widely
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 0 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Create a skill or automation on your local desktop, then
                    instantly generate a secure sharing link for your entire
                    team. No complex setups required.
                  </p>
                </button>

                <button
                  type="button"
                  className={`${
                    activeUseCase === 1 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(1)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 1 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Cloud Hosted Sandboxes
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 1 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Give your team access to hosted, sandboxed workers via
                    OpenWork Den. Run the exact same workflows safely in the
                    cloud without managing infrastructure.
                  </p>
                </button>

                <button
                  type="button"
                  className={`${
                    activeUseCase === 2 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(2)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 2 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Anywhere Access
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 2 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Run and monitor your shared workers from the OpenWork
                    desktop app, or interact with them directly inside your
                    team&apos;s Slack or Telegram channels.
                  </p>
                </button>
              </div>

              <div className="landing-canvas relative flex min-h-[400px] w-full items-center justify-center overflow-hidden rounded-3xl p-6 lg:w-2/3 md:p-10">
                {showEnterpriseGrain ? (
                  <>
                    <ResponsiveGrain
                      colors={["#f97316", "#a855f7", "#3b82f6", "#fcd34d"]}
                      colorBack="#f97316"
                      softness={0.6}
                      intensity={0.8}
                      noise={0.3}
                      shape="corners"
                      speed={0}
                    />
                    <div className="absolute left-8 top-8 h-28 w-28 rounded-[2rem] border border-white/60 bg-white/30" />
                    <div className="absolute bottom-8 right-8 h-40 w-40 rounded-full border border-white/60 bg-white/24" />
                  </>
                ) : null}

                {showEnterpriseShowcase ? (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeUseCase}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="z-10 flex w-full justify-center"
                    >
                      {activeUseCase === 0 ? <LandingSharePackageCard /> : null}

                      {activeUseCase === 1 ? <LandingCloudWorkersCard /> : null}

                    {activeUseCase === 2 ? (
                      <div className="landing-shell-soft flex h-[380px] w-full max-w-lg flex-col overflow-hidden rounded-2xl p-0">
                        <div className="flex items-center gap-3 bg-[#4A154B] px-4 py-3">
                          <div className="hidden h-3 w-3 rounded-full bg-red-500/80 sm:block"></div>
                          <div className="hidden h-3 w-3 rounded-full bg-yellow-500/80 sm:block"></div>
                          <div className="hidden h-3 w-3 rounded-full bg-green-500/80 sm:block"></div>
                          <div className="flex-1 text-center text-sm font-medium text-white/90">
                            # general
                          </div>
                        </div>

                        <div className="flex flex-1 flex-col gap-5 overflow-y-auto bg-white p-4">
                          <div className="flex gap-3">
                            <div className="h-8 w-8 flex-shrink-0 rounded bg-[#2463eb]"></div>
                            <div className="flex flex-col">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[15px] font-bold text-[#1d1c1d]">
                                  You
                                </span>
                                <span className="text-xs text-gray-500">11:42 AM</span>
                              </div>
                              <div className="mt-1 text-[15px] leading-relaxed text-[#1d1c1d]">
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @SalesBot
                                </span>{" "}
                                get my notion info and share it to{" "}
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @john
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-[#1a44f2] text-xs font-bold text-white">
                              SB
                            </div>
                            <div className="flex w-full flex-col">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[15px] font-bold text-[#1d1c1d]">
                                  SalesBot
                                </span>
                                <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-bold uppercase text-gray-500">
                                  APP
                                </span>
                                <span className="text-xs text-gray-500">11:43 AM</span>
                              </div>
                              <div className="mt-1 text-[15px] leading-relaxed text-[#1d1c1d]">
                                I&apos;ve found your latest Notion notes regarding
                                the Acme Corp deal. I just sent a direct message
                                to{" "}
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @john
                                </span>{" "}
                                with a summarized bulleted list.
                              </div>
                              <div className="mt-3 border-l-4 border-[#1a44f2] py-1 pl-3">
                                <div className="text-[14px] font-medium">
                                  Action Complete
                                </div>
                                <div className="mt-1 text-[14px] text-gray-600">
                                  Queried Notion MCP and successfully executed 1
                                  automation workflow.
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="border-t border-gray-200 bg-white p-4">
                          <div className="rounded-lg border border-gray-400 p-3 text-sm text-gray-400">
                            Message #general
                          </div>
                        </div>
                      </div>
                    ) : null}
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <div className="z-10 flex w-full justify-center">
                    <div className="landing-shell-soft h-[380px] w-full max-w-lg rounded-[2rem] border border-dashed border-slate-300/80 bg-white/70" />
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
