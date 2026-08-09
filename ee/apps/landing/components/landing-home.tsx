"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Globe, Monitor, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { LandingAppDemoPanel } from "./landing-app-demo-panel";
import {
  defaultLandingDemoFlowId,
  landingDemoFlows,
  landingDemoFlowTimes
} from "./landing-demo-flows";
import { LandingFaq } from "./landing-faq";
import { LandingHeroPrompt } from "./landing-hero-prompt";
import { LpCopyBar } from "./lp-copy-bar";
import { LpCta } from "./lp-cta";
import { LpGatewayDiagram } from "./lp-gateway-diagram";
import { LpHeroBackground } from "./lp-hero-background";
import { LpParityTable } from "./lp-parity-table";
import {
  LpAlphaBadge,
  LpArrowLink,
  LpSectionHeader,
  LpTonalCard
} from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  windowsDownloadHref: string;
  linuxDownloadHref: string;
  callHref: string;
  isMobileVisitor: boolean;
};

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";
const GATEWAY_URL = "https://api.openworklabs.com/mcp/agent";

type ProviderLogoName =
  | "openai"
  | "anthropic"
  | "gemini"
  | "aws"
  | "openrouter"
  | "mistral";

const providers: { label: string; logo?: ProviderLogoName }[] = [
  { label: "OpenAI", logo: "openai" },
  { label: "Anthropic", logo: "anthropic" },
  { label: "Gemini", logo: "gemini" },
  { label: "Bedrock", logo: "aws" },
  { label: "Azure AI Foundry" },
  { label: "OpenRouter", logo: "openrouter" },
  { label: "Mistral", logo: "mistral" }
];

export function LandingHome(props: Props) {
  const [activeDemoId, setActiveDemoId] = useState(defaultLandingDemoFlowId);
  const activeDemo = useMemo(
    () => landingDemoFlows.find((flow) => flow.id === activeDemoId) ?? landingDemoFlows[0],
    [activeDemoId]
  );
  const primaryHref = props.isMobileVisitor ? CLOUD_SIGNUP_URL : props.downloadHref;
  const callExternal = /^https?:\/\//.test(props.callHref);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <LpHeroBackground />

      <div className="relative z-10">
        <SiteNav
          stars={props.stars}
          downloadHref={props.downloadHref}
          callUrl={props.callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Get started for free"
          active="home"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section className="max-w-4xl pt-8 md:pt-12">
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
                {props.isMobileVisitor ? (
                  <a
                    href={CLOUD_SIGNUP_URL}
                    className="doc-button inline-flex items-center gap-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get Started for Free <ArrowRight size={18} />
                  </a>
                ) : (
                  <Link
                    href="/download"
                    className="doc-button inline-flex items-center gap-2"
                  >
                    Download for free <ArrowRight size={18} />
                  </Link>
                )}
                <a
                  href={props.callHref}
                  className="secondary-button"
                  target={callExternal ? "_blank" : undefined}
                  rel={callExternal ? "noreferrer" : undefined}
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

            <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[13px] text-gray-500">
              <span>Also available:</span>
              <a
                href={props.windowsDownloadHref}
                className="text-[var(--lp-ink)] underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
              >
                Windows
              </a>
              <span>·</span>
              <a
                href={props.linuxDownloadHref}
                className="text-[var(--lp-ink)] underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
              >
                Linux
              </a>
            </div>

            {props.isMobileVisitor ? null : (
              <LandingHeroPrompt className="mt-10 hidden md:block" />
            )}
          </section>

          <section
            className="relative mt-16 flex flex-col gap-6 overflow-hidden md:mt-20 md:gap-8"
            aria-label="OpenWork product demo"
          >
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
            </div>
          </section>

          <section className="mt-[120px]">
            <div className="mb-8">
              <h2 className="max-w-[680px] text-[16px] font-normal text-[var(--lp-ink)]">
                Bring any model — or provision centrally for your whole org
              </h2>
            </div>
            <div className="rounded-[24px] bg-[var(--lp-tonal)] px-6 py-7 md:px-10">
              <div className="grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-3 md:flex md:items-center md:justify-between md:gap-6">
                {providers.map((provider) => (
                  <div
                    key={provider.label}
                    className="group flex items-center gap-2.5 text-[14px] font-medium text-[var(--lp-muted)] opacity-70 transition-opacity duration-150 hover:opacity-100 md:shrink-0 md:text-[15px]"
                  >
                    {provider.logo ? (
                      <BrandLogo
                        name={provider.logo}
                        className="lp-logo h-[21px] w-[21px] shrink-0"
                      />
                    ) : null}
                    <span>{provider.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-5">
              <LpArrowLink href="/docs">See all 50+ providers</LpArrowLink>
            </div>
          </section>

          <section className="mt-[120px]" id="comparison">
            <LpSectionHeader
              label="OpenWork vs Claude Cowork"
              heading="Feature parity. Zero lock-in."
              right={
                <a href="/docs/start-here/migrate-from-claude-cowork" className="lp-pill-secondary lp-pill-sm !hidden md:!inline-flex">
                  See the migration guide
                </a>
              }
            />
            <p className="mt-6 max-w-[640px] text-[16px] leading-[25px] text-[var(--lp-body)]">
              If your team runs on Claude Cowork today, everything keeps working —
              and you stop being tied to one vendor, one model, and one deployment.
            </p>
            <a
              href="/docs/start-here/migrate-from-claude-cowork"
              className="lp-pill-secondary lp-pill-sm mt-6 md:!hidden"
            >
              See the migration guide
            </a>
            <div className="mt-10">
              <LpParityTable />
            </div>
          </section>

          <section className="mt-[120px]" id="product">
            <div className="grid gap-6 md:grid-cols-3">
              <LpTonalCard className="group flex min-h-[260px] flex-col justify-between p-6">
                <div className="lp-icon-chip flex h-11 w-11 items-center justify-center rounded-full bg-white transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:rotate-[8deg]">
                  <BrandLogo name="github" className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[14px] text-[var(--lp-muted)]">Import existing repos</div>
                  <p className="mt-2 text-[15.5px] leading-[23px] text-[var(--lp-ink)]">
                    Point OpenWork at any repository and start working with full
                    context.
                  </p>
                </div>
              </LpTonalCard>

              <LpTonalCard className="group flex min-h-[260px] flex-col justify-between p-6">
                <div className="lp-icon-chip flex h-11 w-11 items-center justify-center rounded-full bg-white transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:rotate-[8deg]">
                  <BrandLogo name="anthropic" className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[14px] text-[var(--lp-muted)]">Anthropic plugins</div>
                  <p className="mt-2 text-[15.5px] leading-[23px] text-[var(--lp-ink)]">
                    Anthropic-compatible plugins and skills run as-is. No porting,
                    no wrappers.
                  </p>
                </div>
              </LpTonalCard>

              <LpTonalCard className="group flex min-h-[260px] flex-col justify-between p-6">
                <div className="lp-icon-chip flex h-11 w-11 items-center justify-center rounded-full bg-white transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:rotate-[8deg]">
                  <Globe className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <div>
                  <div className="flex items-center gap-2 text-[14px] text-[var(--lp-muted)]">
                    OpenWork Web <LpAlphaBadge />
                  </div>
                  <p className="mt-2 text-[15.5px] leading-[23px] text-[var(--lp-ink)]">
                    The same workspace in your browser. Nothing to install.
                  </p>
                </div>
              </LpTonalCard>
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="OpenWork Connect"
              heading="Set up your MCPs once. Your whole team has them."
              headingLines={["Set up your MCPs once.", "Your whole team has them."]}
              right={
                <a href="/connect" className="lp-pill-secondary lp-pill-sm !hidden md:!inline-flex">
                  Explore OpenWork Connect
                </a>
              }
            />
            <p className="mt-6 max-w-[640px] text-[16px] leading-[25px] text-[var(--lp-body)]">
              OpenWork Connect is our MCP gateway. Add a server or skill to your org
              once — every teammate and agent gets it instantly, in OpenWork and in
              any MCP-compatible client. Claude Cowork has no equivalent.
            </p>
            <a href="/connect" className="lp-pill-secondary lp-pill-sm mt-6 md:!hidden">
              Explore OpenWork Connect
            </a>
            <div className="mt-10">
              <LpGatewayDiagram />
            </div>
            <div className="mt-6">
              <LpCopyBar value={GATEWAY_URL} />
            </div>
            <p className="mt-3 text-[13.5px] text-[var(--lp-muted)]">
              One URL for your whole org — skills, MCPs, roles, and policies
              included. Works with your OpenWork account.
            </p>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="Get started"
              heading="Use it today — your way."
              right={
                <p className="max-w-[340px] text-left text-[14.5px] leading-[22px] text-[var(--lp-body)] md:text-right">
                  Three doors into the same workspace. Same skills, same gateway,
                  same account.
                </p>
              }
              />
            <div className="mt-10">
              <div className="grid items-start gap-6 md:grid-cols-3">
                <div className="group rounded-[24px] bg-[var(--lp-tonal)] p-7">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white">
                    <Monitor
                      className="lp-draw-icon h-5 w-5 text-[var(--lp-ink)]"
                      strokeWidth={1.75}
                    />
                  </span>
                  <h3 className="mt-4 text-[17px] font-medium">On your desktop</h3>
                  <p className="mt-2 max-w-[280px] text-[14px] leading-[22px] text-[var(--lp-body)] md:min-h-[66px]">
                    For macOS, Windows, and Linux. Local-first, no account needed.
                  </p>
                  <a
                    href={props.downloadHref}
                    className="lp-pill-primary lp-pill-sm mt-5"
                  >
                    Download for macOS
                  </a>
                </div>

                <div className="group rounded-[24px] bg-[var(--lp-tonal)] p-7">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white">
                    <Globe
                      className="lp-draw-icon h-5 w-5 text-[var(--lp-ink)]"
                      strokeWidth={1.75}
                    />
                  </span>
                  <h3 className="mt-4 flex items-center gap-2 text-[17px] font-medium">
                    In your browser <LpAlphaBadge />
                  </h3>
                  <p className="mt-2 max-w-[280px] text-[14px] leading-[22px] text-[var(--lp-body)] md:min-h-[66px]">
                    OpenWork Web. Nothing to install — sign in and run your first
                    task.
                  </p>
                  <a
                    href="https://app.openworklabs.com"
                    className="lp-pill-secondary lp-pill-sm mt-5"
                  >
                    Open in browser
                  </a>
                </div>

                <div className="group rounded-[24px] bg-[var(--lp-tonal)] p-7">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white">
                    <SquareTerminal
                      className="lp-draw-icon h-5 w-5 text-[var(--lp-ink)]"
                      strokeWidth={1.75}
                    />
                  </span>
                  <h3 className="mt-4 text-[17px] font-medium">From your agent</h3>
                  <p className="mt-2 max-w-[280px] text-[14px] leading-[22px] text-[var(--lp-body)] md:min-h-[66px]">
                    In Claude Code, Cursor, or Codex? One pasted prompt installs
                    and sets up OpenWork for you.
                  </p>
                  <LandingHeroPrompt compact className="mt-5" />
                </div>
              </div>
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="Where to next"
              heading="Take it to your team."
              size="small"
            />
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              <LpTonalCard className="flex min-h-[190px] flex-col justify-between p-6">
                <div className="text-[14px] text-[var(--lp-muted)]">For you</div>
                <div>
                  <h3 className="text-[19px] font-medium">Run it on your machine</h3>
                  <p className="mt-2 text-[14.5px] leading-[22px] text-[var(--lp-body)]">
                    The free desktop app. Your files, your keys, fully local-first.
                  </p>
                  <div className="mt-4">
                    <LpArrowLink href={primaryHref}>Download free</LpArrowLink>
                  </div>
                </div>
              </LpTonalCard>

              <LpTonalCard className="flex min-h-[190px] flex-col justify-between p-6">
                <div className="text-[14px] text-[var(--lp-muted)]">For teams</div>
                <div>
                  <h3 className="text-[19px] font-medium">Manage it centrally</h3>
                  <p className="mt-2 text-[14.5px] leading-[22px] text-[var(--lp-body)]">
                    Deploy skills, MCPs, and models to every seat with OpenWork
                    Cloud.
                  </p>
                  <div className="mt-4">
                    <LpArrowLink href="/cloud">Explore Cloud</LpArrowLink>
                  </div>
                </div>
              </LpTonalCard>

              <LpTonalCard className="flex min-h-[190px] flex-col justify-between p-6">
                <div className="text-[14px] text-[var(--lp-muted)]">For enterprises</div>
                <div>
                  <h3 className="text-[19px] font-medium">Own your AI stack</h3>
                  <p className="mt-2 text-[14.5px] leading-[22px] text-[var(--lp-body)]">
                    Self-sovereign AI — your models, your infrastructure. Managed or
                    self-hosted.
                  </p>
                  <div className="mt-4">
                    <LpArrowLink href="/enterprise">See Enterprise</LpArrowLink>
                  </div>
                </div>
              </LpTonalCard>
            </div>
          </section>

          <div className="mt-[120px] [&_h2]:!text-[36px] [&_h2]:!leading-[42px]">
            <LandingFaq />
          </div>

          <div className="mt-[120px]">
            <LpCta
              heading="Give your whole team an agent."
              sub="Free on desktop. Central management in Cloud. Private instances for enterprise."
              primary={{ label: "Download for free →", href: primaryHref }}
              secondary={{ label: "Talk to sales", href: props.callHref }}
              trust="Free & open source · No account required to start"
            />
          </div>

          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}
