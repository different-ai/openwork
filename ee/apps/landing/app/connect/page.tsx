import type { Metadata } from "next";

import { LpCopyBar } from "../../components/lp-copy-bar";
import { LpCta } from "../../components/lp-cta";
import { LpGatewayDiagram } from "../../components/lp-gateway-diagram";
import { LpSectionHeader } from "../../components/lp-primitives";
import { LpTerminalStory } from "../../components/lp-terminal-story";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";
const GATEWAY_URL = "https://api.openworklabs.com/mcp/agent";

export const metadata: Metadata = {
  title: "OpenWork Connect — the MCP gateway for your team",
  description:
    "The MCP gateway for your whole org. Add a server or skill once — every teammate and agent gets it instantly, with auth, roles, and policies applied on the way through.",
  alternates: { canonical: "/connect" }
};

const steps = [
  {
    number: "01",
    title: "Add MCPs and skills",
    body: "In the app or the console — servers, skills, and configs, with org-level auth."
  },
  {
    number: "02",
    title: "Share one URL",
    body: "Teammates sign in with their OpenWork account — from OpenWork or any MCP client."
  },
  {
    number: "03",
    title: "Policies ride along",
    body: "Roles, allowlists, and audit apply to every call — no per-machine setup, ever."
  }
];

export default async function ConnectPage() {
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
          active="connect"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section className="pt-16 md:pt-[88px]">
            <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
              <div className="max-w-[660px]">
                <div className="mb-5 text-[15px] text-[var(--lp-muted)]">OpenWork Connect</div>
                <h1 className="text-[46px] font-light leading-[51px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
                  <span className="block">Set up your MCPs once.</span>
                  <span className="font-pixel block font-normal">Shared with everyone.</span>
                </h1>
              </div>
              <div className="max-w-[440px] pb-1">
                <p className="text-[16px] leading-[25px]">
                  The MCP gateway for your whole org. Add a server or skill once — every teammate and agent gets it instantly, with auth, roles, and policies applied on the way through.
                </p>
                <p className="mt-4 text-[14px] leading-[22px] text-[var(--lp-body)]">One URL. Works in OpenWork and any MCP-compatible client.</p>
              </div>
            </div>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">Get started free</a>
                <a href="/docs" className="lp-pill-secondary">Read the docs</a>
              </div>
              <span className="text-[13.5px] text-[var(--lp-body)] sm:ml-2">No install for your team · First 5 seats free</span>
            </div>
          </section>

          <section className="mt-[88px]" aria-label="OpenWork Connect gateway flow">
            <LpGatewayDiagram />
            <div className="mt-6"><LpCopyBar value={GATEWAY_URL} /></div>
            <p className="mt-3 text-[13.5px] text-[var(--lp-muted)]">One URL for your whole org — skills, MCPs, roles, and policies included. Works with your OpenWork account.</p>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="How it works" heading="One setup. Every teammate." />
            <div className="mt-10 grid items-start gap-10 md:grid-cols-3">
              {steps.map((step) => (
                <div key={step.number}>
                  <div className="font-pixel text-[40px] leading-none text-[var(--lp-faint)]">
                    {step.number}
                  </div>
                  <h2 className="mt-3 text-[17px] font-medium">{step.title}</h2>
                  <p className="mt-2 max-w-[300px] text-[14px] leading-[22px] text-[var(--lp-body)]">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="In practice" heading="Publish once — watch it land everywhere." />
            <div className="mt-10"><LpTerminalStory /></div>
          </section>

          <div className="mt-[120px]">
            <LpCta
              heading="Put every MCP behind one gateway."
              sub="Set up once, share with everyone — auth, roles, and audit included."
              primary={{ label: "Get started free", href: CLOUD_SIGNUP_URL }}
              secondary={{ label: "Read the docs", href: "/docs" }}
              trust="First 5 seats free · Works with any MCP client"
            />
          </div>
          <div className="mt-16"><SiteFooter /></div>
        </main>
      </div>
    </div>
  );
}
