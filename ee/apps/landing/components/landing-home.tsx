"use client";

import { motion } from "framer-motion";
import { ArrowRight, Globe, Monitor, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { LandingAppDemoPanel } from "./landing-app-demo-panel";
import {
  defaultLandingDemoFlowId,
  landingDemoFlows
} from "./landing-demo-flows";
import { LandingFaq } from "./landing-faq";
import { LandingHeroPrompt } from "./landing-hero-prompt";
import { LpCta } from "./lp-cta";
import { LpGatewayEndpoint } from "./lp-gateway-endpoint";
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
import { DownloadLink } from "./download-link";

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
  const primaryHref = props.isMobileVisitor ? CLOUD_SIGNUP_URL : "/download";
  const callExternal = /^https?:\/\//.test(props.callHref);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <LpHeroBackground />

      <div className="relative z-10">
        <SiteNav
          stars={props.stars}
          callUrl={props.callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Get started for free"
          active="home"
        />

        <div
          aria-hidden="true"
          className="font-pixel mx-auto flex w-full max-w-[1920px] justify-between pb-10 px-[clamp(1.5rem,calc((100%-1128px)/2),4.75rem)] pt-6 text-[clamp(3rem,16vw,12rem)] leading-none tracking-[-0.06em] sm:pb-12 sm:pt-8 lg:pb-16"
        >
          {Array.from("OpenWork").map((letter, index) => (
            <span key={index}>{letter}</span>
          ))}
        </div>

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section
            aria-labelledby="sovereign-hero-heading"
            className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-12"
          >
            <div className="relative min-w-0 lg:pt-2">
              <div className="relative">
              <p className="mono mb-5 text-[11px] leading-relaxed tracking-[0.1em] text-[var(--lp-body)] sm:text-xs">
                SOVEREIGN AI FOR KNOWLEDGE WORKERS
              </p>
              <h1
                id="sovereign-hero-heading"
                className="text-[clamp(2.5rem,4.4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]"
              >
                Your AI workspace.
                <br />
                Without
                <br />
                <span className="whitespace-nowrap">vendor lock-in.</span>
              </h1>
              <p className="mt-6 max-w-xl text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
                An open-source alternative to Claude Cowork, built for knowledge
                workers who want the freedom to choose their AI.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
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
                  <DownloadLink className="doc-button inline-flex !h-[52px] items-center gap-2 !px-6 !text-[17px]">
                    Download for free <ArrowRight size={20} />
                  </DownloadLink>
                )}
                <a href="/enterprise" className="secondary-button !h-[52px] !px-6 !text-[17px]">
                  Explore enterprise
                </a>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs text-[var(--lp-muted)]">
                <span>Free desktop app</span>
                <span aria-hidden="true">·</span>
                <a href="/download" className="underline-offset-4 hover:underline">macOS</a>
                <span aria-hidden="true">·</span>
                <a href={props.windowsDownloadHref} className="underline-offset-4 hover:underline">Windows</a>
                <span aria-hidden="true">·</span>
                <a href={props.linuxDownloadHref} className="underline-offset-4 hover:underline">Linux</a>
              </div>

              <div className="mt-7 flex items-center gap-2 text-xs text-[var(--lp-muted)]">
                <span>Backed by</span>
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] text-white">Y</span>
                <span className="font-medium">Combinator</span>
              </div>
              </div>
            </div>
            {props.isMobileVisitor ? null : (
              <div className="flex min-w-0 self-stretch lg:items-end lg:justify-end">
                <LandingHeroPrompt className="w-full lg:max-w-[440px]" />
              </div>
            )}
          </section>

          <div className="mt-12 grid gap-4 border-y border-[var(--lp-border)] py-6 text-[13px] text-[var(--lp-body)] sm:grid-cols-3 sm:gap-0 lg:mt-16">
            <a href="#models" className="flex items-center justify-between gap-3 transition-colors hover:text-[var(--lp-ink)] sm:pr-6">
              Choose your models <ArrowRight size={15} aria-hidden="true" />
            </a>
            <a href="/enterprise" className="flex items-center justify-between gap-3 transition-colors hover:text-[var(--lp-ink)] sm:border-x sm:border-[var(--lp-border)] sm:px-6">
              Control your deployment <ArrowRight size={15} aria-hidden="true" />
            </a>
            <a href="#comparison" className="flex items-center justify-between gap-3 transition-colors hover:text-[var(--lp-ink)] sm:pl-6">
              Own your setup <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>

          <section className="mt-20 scroll-mt-24 lg:mt-[120px]" id="models">
            <div className="mb-8">
              <h2 className="max-w-[680px] text-[16px] font-normal text-[var(--lp-ink)]">
                Bring any model, or provision centrally for your whole org
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
              If your team runs on Claude Cowork today, everything keeps working,
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

          <section className="mt-[120px]">
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
              once and every teammate and agent gets it instantly, in OpenWork and in
              any MCP client.
            </p>
            <a href="/connect" className="lp-pill-secondary lp-pill-sm mt-6 md:!hidden">
              Explore OpenWork Connect
            </a>
            <div className="mt-10">
              <LpGatewayEndpoint url={GATEWAY_URL} />
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="Get started"
              heading="Use it today, your way."
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
                    OpenWork Web. Nothing to install. Sign in and run your first
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
                    Self-sovereign AI: your models, your infrastructure. Managed or
                    self-hosted.
                  </p>
                  <div className="mt-4">
                    <LpArrowLink href="/enterprise">See Enterprise</LpArrowLink>
                  </div>
                </div>
              </LpTonalCard>
            </div>
          </section>

          <section
            id="product"
            className="mt-[120px] scroll-mt-24"
            aria-label="OpenWork product demo"
          >
            <div className="landing-shell overflow-hidden rounded-2xl">
              <div className="relative flex h-10 items-center border-b border-white/50 bg-gradient-to-b from-white/90 to-white/60 px-4">
                <div className="flex gap-1.5" aria-hidden="true">
                  <div className="h-2.5 w-2.5 rounded-full border border-[#e0443e]/20 bg-[#ff5f56]/90" />
                  <div className="h-2.5 w-2.5 rounded-full border border-[#dea123]/20 bg-[#ffbd2e]/90" />
                  <div className="h-2.5 w-2.5 rounded-full border border-[#1aab29]/20 bg-[#27c93f]/90" />
                </div>
                <span className="absolute left-1/2 -translate-x-1/2 text-xs font-medium text-[var(--lp-muted)]">OpenWork</span>
              </div>
              <div className="p-3">
                <LandingAppDemoPanel
                  flows={landingDemoFlows}
                  activeFlowId={activeDemo.id}
                  onSelectFlow={setActiveDemoId}
                />
              </div>
              <div className="flex flex-wrap gap-1 border-t border-[var(--lp-border)] px-3 py-3" aria-label="Example tasks">
                {landingDemoFlows.map((flow) => {
                  const isActive = flow.id === activeDemo.id;
                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setActiveDemoId(flow.id)}
                      aria-pressed={isActive}
                      className={`relative cursor-pointer rounded-full px-3 py-2 text-xs transition-colors ${isActive ? "text-[var(--lp-ink)]" : "text-[var(--lp-muted)] hover:text-[var(--lp-ink)]"}`}
                    >
                      {isActive ? (
                        <motion.div
                          layoutId="active-pill"
                          className="absolute inset-0 rounded-full border border-[var(--lp-border)] bg-white shadow-sm"
                          transition={{ type: "spring", stiffness: 400, damping: 30 }}
                        />
                      ) : null}
                      <span className="relative z-10">{flow.categoryLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-[var(--lp-muted)]" aria-live="polite">
              {activeDemo.description}
            </p>
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
