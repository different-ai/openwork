import type { Metadata } from "next";
import { LayoutDashboard, ShieldCheck, Users } from "lucide-react";

import { LpCta } from "../../components/lp-cta";
import { LpSectionHeader, LpTonalCard } from "../../components/lp-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";
const MCP_APPS_URL = "https://github.com/modelcontextprotocol/ext-apps/tree/main";

export const metadata: Metadata = {
  title: "OpenWork Dashboard — instant information for your team",
  description:
    "Custom dashboards built from MCP Apps. Give your whole team the information they need without asking the chat.",
  alternates: { canonical: "/dashboard" }
};

const dashboardFeatures = [
  {
    title: "MCP that outputs UI",
    body: "MCP Apps are an extension of the Model Context Protocol. A tool returns not just data but a rich, interactive interface that the host renders inline."
  },
  {
    title: "Standard, not proprietary",
    body: "Build to the spec once and your app runs in OpenWork and in any other host that implements it. Apps built for other hosts run in OpenWork too."
  },
  {
    title: "Yes, dashboards again",
    body: "We know chat was supposed to replace them. It replaced a lot — but for information you check every day, a dashboard is still faster."
  },
  {
    title: "Just the beginning",
    body: "This is the first version of Dashboard. Next up: creating MCP Apps directly inside OpenWork."
  }
];

const steps = [
  {
    number: "01",
    title: "Connect an MCP server",
    body: "Add any MCP server that ships an app in Settings → Connectors. OpenWork discovers the app automatically."
  },
  {
    number: "02",
    title: "Create a dashboard",
    body: "In the admin panel, create a dashboard and add the apps you want on it."
  },
  {
    number: "03",
    title: "Share it with the org",
    body: "Toggle it on for everyone. Members see it the next time they open OpenWork."
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
                  <span className="block">Instant information</span>
                  <span className="font-pixel block font-normal">for your whole team</span>
                </h1>
              </div>
              <p className="max-w-[440px] pb-1 text-[16px] leading-[25px]">
                Chat is great for getting work done. It&apos;s a slow way to get information. OpenWork Dashboard puts the numbers your team checks every day one click away — no prompt, no waiting for a reply.
              </p>
            </div>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">Open OpenWork Cloud</a>
                <a href={MCP_APPS_URL} target="_blank" rel="noreferrer" className="lp-pill-secondary">Read the MCP Apps spec</a>
              </div>
              <span className="text-[13.5px] text-[var(--lp-body)] sm:ml-2">Available now in OpenWork Cloud. Works with any MCP server that ships an app.</span>
            </div>
          </section>

          <section className="mt-[120px] grid gap-6 lg:grid-cols-3">
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><LayoutDashboard className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">See it without asking</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">Open the dashboard and the information is already there. No prompting, no re-explaining context, no scrolling back through a thread.</p>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><Users className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">Build once, share with everyone</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">An admin creates a dashboard, adds apps, and toggles it on for the organization. It shows up in everyone&apos;s OpenWork automatically.</p>
            </LpTonalCard>
            <LpTonalCard className="flex flex-col p-7">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white"><ShieldCheck className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} /></span>
              <h2 className="mt-8 text-[16.5px] font-semibold">Private by design</h2>
              <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">What happens inside an app stays inside the app. The model never sees it — so approving a purchase or entering credentials is safe.</p>
            </LpTonalCard>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="How it works" heading="Connect once. Share with everyone." />
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
            <LpSectionHeader label="Under the hood: MCP Apps" heading="Interactive interfaces, built on an open standard." />
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
              heading="Give your team instant information"
              sub="Create your first dashboard in OpenWork Cloud, or build an MCP App and bring it anywhere."
              primary={{ label: "Open OpenWork Cloud", href: CLOUD_SIGNUP_URL }}
              secondary={{ label: "MCP Apps on GitHub", href: MCP_APPS_URL }}
              trust="Free to start. Works with the standard MCP Apps spec."
            />
          </div>
          <div className="mt-16"><SiteFooter /></div>
        </main>
      </div>
    </div>
  );
}
