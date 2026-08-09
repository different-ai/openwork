import type { Metadata } from "next";
import { Globe, Layers, Plug } from "lucide-react";

import { LandingSharePackageCard } from "../../components/landing-share-package-card";
import { LpCloudConsole } from "../../components/lp-cloud-console";
import { LpCta } from "../../components/lp-cta";
import { LpAlphaBadge, LpArrowLink, LpSectionHeader, LpTonalCard } from "../../components/lp-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";

export const metadata: Metadata = {
  title: "OpenWork Cloud — the dashboard for your whole org",
  description:
    "OpenWork Cloud is where you run OpenWork as a team — provision model providers, deploy skills and MCP servers, manage members and policies. OpenWork Web and the Connect gateway are built in.",
  alternates: { canonical: "/cloud" }
};

const dashboardFeatures = [
  {
    title: "Deploy skills & MCPs org-wide",
    body: "Publish once to the gateway and every seat has it — desktop, web, or any MCP client. Updates roll out instantly, no downloads."
  },
  {
    title: "Provision models centrally",
    body: "Connect Bedrock, Azure AI Foundry, or OpenRouter once. Everyone gets the right models and limits — no API keys in spreadsheets."
  },
  {
    title: "Gate access by role",
    body: "Policies decide which teams see which skills, MCPs, and models. Exposure allowlists keep sensitive tools scoped."
  },
  {
    title: "See everything agents do",
    body: "Usage and audit views across every seat and every client — who ran what, where, with which model."
  }
];

export default async function CloudPage() {
  const github = await getGithubData();
  const callHref = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <div className="relative z-10">
        <SiteNav
          stars={github.stars}
          downloadHref={github.downloads.macos}
          callUrl={callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Get started for free"
          active="cloud"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section className="pt-16 md:pt-[88px]">
            <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
              <div className="max-w-[650px]">
                <div className="mb-5 text-[15px] text-[var(--lp-muted)]">OpenWork Cloud</div>
                <h1 className="text-[46px] font-light leading-[51px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
                  <span className="block">The dashboard for</span>
                  <span className="font-pixel block font-normal">your whole org.</span>
                </h1>
              </div>
              <p className="max-w-[440px] pb-1 text-[16px] leading-[25px]">
                OpenWork Cloud is where you run OpenWork as a team — provision model providers, deploy skills and MCP servers, manage members and policies. OpenWork Web and the Connect gateway are built in.
              </p>
            </div>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">Get started free</a>
                <a href={callHref} className="lp-pill-secondary">Talk to sales</a>
              </div>
              <span className="text-[13.5px] text-[var(--lp-body)] sm:ml-2">First 5 seats free</span>
            </div>
          </section>

          <section className="mt-[88px]" aria-label="OpenWork Cloud console preview">
            <LpCloudConsole />
            <p className="mt-3 text-[13.5px] text-[var(--lp-muted)]">
              A live preview — click through Analytics, Models, and Members.
            </p>
          </section>

          <section className="mt-[120px] grid gap-6 lg:grid-cols-3">
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Plug className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">OpenWork Connect</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">The MCP gateway. Set up MCPs once — shared with everyone, policies included.</p>
              <div className="mt-auto pt-6"><LpArrowLink href="/connect">Explore Connect</LpArrowLink></div>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Globe className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 flex items-center gap-2 text-[16.5px] font-semibold">OpenWork Web <LpAlphaBadge /></h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">The whole workspace — and this dashboard — in the browser. Nothing to install.</p>
              <div className="mt-auto pt-6"><LpArrowLink href="https://app.openworklabs.com">Open in browser</LpArrowLink></div>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Layers className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">Everything speaks MCP</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">Whatever you manage here is exposed over MCP — usable from OpenWork or any MCP client.</p>
              <div className="mt-auto pt-6"><LpArrowLink href="/connect">See how MCP works</LpArrowLink></div>
            </LpTonalCard>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="The dashboard" heading="Run agents like a fleet, not a folder of setups." />
            <div className="mt-10 grid gap-6 md:grid-cols-2">
              {dashboardFeatures.map((feature) => (
                <div key={feature.title} className="rounded-[24px] bg-[var(--lp-tonal)] p-7">
                  <h3 className="text-[17px] font-semibold">{feature.title}</h3>
                  <p className="mt-3 max-w-[470px] text-[14.5px] leading-[23px] text-[var(--lp-body)]">{feature.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-[120px] flex flex-col items-center justify-between gap-10 rounded-[24px] bg-[var(--lp-tonal)] p-7 md:p-12 lg:flex-row">
            <div className="max-w-[480px]">
              <div className="text-[15px] text-[var(--lp-muted)]">Share-link showcase</div>
              <h2 className="mt-3 text-[36px] font-light leading-[43px] tracking-[-0.015em] md:text-[44px] md:leading-[50px]">Package the setup. Share one link.</h2>
              <p className="mt-5 text-[15px] leading-[24px] text-[var(--lp-body)]">Bundle the skills and MCPs a team needs, then publish them through Cloud. Every update reaches every seat without another install.</p>
            </div>
            <LandingSharePackageCard className="shrink-0" />
          </section>

          <div className="mt-[120px]">
            <LpCta
              heading="Run your org on OpenWork Cloud."
              sub="Providers, skills, MCPs, and web access — managed in one place, exposed through one gateway. Your first 5 seats are free."
              primary={{ label: "Get started free", href: CLOUD_SIGNUP_URL }}
              secondary={{ label: "Talk to sales", href: callHref }}
              trust="First 5 seats free · MCP Gateway included · Desktop, web, and any MCP client"
            />
          </div>
          <div className="mt-16"><SiteFooter /></div>
        </main>
      </div>
    </div>
  );
}
