import type { Metadata } from "next";
import { Blocks, MousePointerClick, Users } from "lucide-react";

import { LpCta } from "../../components/lp-cta";
import { LpDashboardPreview } from "../../components/lp-dashboard-preview";
import { LpSectionHeader, LpTonalCard } from "../../components/lp-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";
const MCP_APPS_URL = "https://github.com/modelcontextprotocol/ext-apps/tree/main";

export const metadata: Metadata = {
  title: "OpenWork Dashboard — build dashboards out of MCP Apps",
  description:
    "Every MCP App is a widget. Compose a dashboard from the apps your team relies on and share it with the whole organization.",
  alternates: { canonical: "/dashboard" }
};

const dashboardFeatures = [
  {
    title: "MCP that returns UI",
    body: "MCP Apps extend the Model Context Protocol: a tool returns an interactive interface, and the host renders it. That interface is your widget."
  },
  {
    title: "Open standard",
    body: "Build to the spec once and it runs in OpenWork and in every other host that implements MCP Apps. Apps built elsewhere work here too."
  },
  {
    title: "Private interactions",
    body: "What happens inside a widget doesn't pass through the model. Enter credentials, approve a purchase, view sensitive data — safely."
  },
  {
    title: "Build your own",
    body: "Follow the MCP Apps spec or point your agent at the reference repo. Next up: creating MCP Apps directly inside OpenWork."
  }
];

const steps = [
  {
    number: "01",
    title: "Connect an MCP server",
    body: "Add any MCP server that ships an app under Connectors. OpenWork detects the app automatically."
  },
  {
    number: "02",
    title: "Compose a dashboard",
    body: "Create a dashboard, add the widgets you want, arrange them."
  },
  {
    number: "03",
    title: "Share it",
    body: "Toggle it on for the organization or specific teams. Members see it the next time they open OpenWork."
  }
];

export default async function DashboardPage() {
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
          mobilePrimaryLabel="Open OpenWork Cloud"
          active="dashboard"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section className="pt-16 md:pt-[88px]">
            <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
              <div className="max-w-[650px]">
                <div className="mb-5 text-[15px] text-[var(--lp-muted)]">OpenWork Dashboard · Powered by MCP Apps</div>
                <h1 className="text-[46px] font-light leading-[51px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
                  <span className="block">Build dashboards</span>
                  <span className="font-pixel block font-normal">out of MCP Apps</span>
                </h1>
              </div>
              <p className="max-w-[440px] pb-1 text-[16px] leading-[25px]">
                Every MCP App is a widget. Pick the ones your team relies on — budgets, pipeline, incidents, anything with an MCP server — arrange them on a dashboard, and share it with the whole organization.
              </p>
            </div>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">Open OpenWork Cloud</a>
                <a href={MCP_APPS_URL} target="_blank" rel="noreferrer" className="lp-pill-secondary">Read the MCP Apps spec</a>
              </div>
              <span className="text-[13.5px] text-[var(--lp-body)] sm:ml-2">Any MCP App works as a widget. Nothing to rebuild for OpenWork.</span>
            </div>
          </section>

          <section className="mt-[88px]" aria-label="OpenWork Dashboard preview">
            <LpDashboardPreview />
            <p className="mt-3 text-[13.5px] text-[var(--lp-muted)]">
              Toggle apps on the left to add or remove widgets — that&apos;s the whole flow.
            </p>
          </section>

          <section className="mt-[120px] grid gap-6 lg:grid-cols-3">
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Blocks className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">Widgets from any MCP server</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">If an MCP server ships an app, it&apos;s a widget. Connect it once and it&apos;s ready to drop onto a dashboard.</p>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><MousePointerClick className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">Live and interactive</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">Widgets are real UI, not screenshots. Filter, drill in, approve, adjust — right on the dashboard.</p>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Users className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">One dashboard, the whole org</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">Compose it once in the admin panel and toggle it on for everyone. It appears in each member&apos;s OpenWork.</p>
            </LpTonalCard>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="How it works" heading="Connect. Compose. Share." />
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
            <LpSectionHeader label="Under the hood: MCP Apps" heading="Widgets are just MCP Apps." />
            <div className="mt-10 grid gap-6 md:grid-cols-2">
              {dashboardFeatures.map((feature) => (
                <div key={feature.title} className="rounded-[24px] bg-[var(--lp-tonal)] p-7">
                  <h3 className="text-[17px] font-semibold">{feature.title}</h3>
                  <p className="mt-3 max-w-[470px] text-[14.5px] leading-[23px] text-[var(--lp-body)]">{feature.body}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="mt-[120px]">
            <LpCta
              heading="Put your team's widgets on one screen"
              sub="Compose your first dashboard in OpenWork Cloud, or build an MCP App and use it anywhere."
              primary={{ label: "Open OpenWork Cloud", href: CLOUD_SIGNUP_URL }}
              secondary={{ label: "MCP Apps on GitHub", href: MCP_APPS_URL }}
              trust="Free to start. Standard MCP Apps, no lock-in."
            />
          </div>
          <div className="mt-16"><SiteFooter /></div>
        </main>
      </div>
    </div>
  );
}
