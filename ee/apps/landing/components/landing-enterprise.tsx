"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  Check,
  Cloud,
  Database,
  Globe,
  Monitor,
  Paintbrush,
  Server,
  ShieldCheck
} from "lucide-react";

import { BookCallForm } from "./book-call-form";
import { LpAnalyticsPanel } from "./lp-analytics-panel";
import { LpCta } from "./lp-cta";
import { LpSectionHeader } from "./lp-primitives";
import { LpSsoCard } from "./lp-sso-card";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

const sovereignPillars = [
  {
    title: "Your models",
    body: "Bring your own inference: AWS Bedrock, Azure AI Foundry, OpenRouter, or models running in your own VPC. Provision centrally, swap anytime.",
    icon: Database
  },
  {
    title: "Your data",
    body: "Local-first by design. Files stay on employee machines or inside your perimeter — prompts go straight to the provider you chose, nowhere else.",
    icon: ShieldCheck
  },
  {
    title: "Your infrastructure",
    body: "Run a managed private instance we operate for you, or self-host the whole stack. It’s open source — audit it, fork it, and leave anytime.",
    icon: Server
  },
  {
    title: "Your brand",
    body: "White-label the whole experience: your name, your logo, your domain. Roll it out to your workforce — or to your own customers.",
    icon: Paintbrush
  }
];

const identityFeatures = [
  "SAML and OIDC single sign-on",
  "SCIM seat provisioning and deprovisioning",
  "DNS domain verification before production",
  "One shared sign-in URL for the whole org"
];

const deployments = [
  {
    tag: "FREE FOREVER",
    tagClass: "text-[#059669]",
    title: "Desktop",
    body: "The local-first app for macOS, Windows, and Linux. Files stay on employee machines.",
    icon: Monitor
  },
  {
    tag: "ALPHA",
    tagClass: "text-[var(--lp-blue)]",
    title: "OpenWork Web",
    body: "The same workspace in the browser, with your org’s models, skills, and policies.",
    icon: Globe
  },
  {
    tag: "FOR TEAMS",
    tagClass: "text-[var(--lp-blue)]",
    title: "Managed private instance",
    body: "A dedicated instance we run for your org. SSO, policies, and audit built in.",
    icon: Cloud,
    tonal: true
  },
  {
    tag: "OPEN SOURCE",
    tagClass: "text-[var(--lp-muted)]",
    title: "Self-hosted",
    body: "Run the full OpenWork stack in your VPC, under your operational controls.",
    icon: Server
  }
];

const compliance = [
  {
    title: "SOC 2 Type II",
    body: "Audit in progress with an independent firm — report available under NDA on completion."
  },
  {
    title: "SAML SSO + SCIM",
    body: "Sign-in through your IdP. Seats provision and deprovision automatically."
  },
  {
    title: "Full audit trail",
    body: "Every agent action logged and attributable, exportable to your SIEM."
  },
  {
    title: "Open source",
    body: "Audit the code you run. No black boxes between agents and your data."
  }
];

export function LandingEnterprise(props: Props) {
  const reduceMotion = useReducedMotion();
  const calHref = props.calUrl || "#book";
  const calExternal = Boolean(props.calUrl);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <div className="relative z-10">
        <SiteNav
          stars={props.stars}
          callUrl={props.calUrl}
          downloadHref={props.downloadHref}
          active="enterprise"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section className="pt-16 md:pt-[88px]">
            <div className="text-[15px] text-[var(--lp-muted)]">OpenWork Enterprise</div>
            <h1 className="mt-5 max-w-[760px] text-[46px] font-light leading-[51px] tracking-[-0.02em] md:text-[56px] md:leading-[61px]">
              <motion.span
                className="block"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.4 }}
              >
                Self-sovereign AI
              </motion.span>
              <motion.span
                className="block"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.4, delay: reduceMotion ? 0 : 0.08 }}
              >
                for your <span className="font-pixel font-normal">company.</span>
              </motion.span>
            </h1>
            <p className="mt-7 max-w-[760px] text-[18px] leading-[28px] text-[var(--lp-body)] md:text-[20px] md:leading-[30px]">
              Your models, your infrastructure, your rules. OpenWork is open source end to end — adopt it for your whole company without handing your AI stack to a vendor.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href={calHref}
                target={calExternal ? "_blank" : undefined}
                rel={calExternal ? "noreferrer" : undefined}
                className="lp-pill-primary"
              >
                Talk to sales →
              </a>
              <a href="/docs" className="lp-pill-secondary">Read the docs</a>
            </div>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <span className="lp-pill-secondary lp-pill-sm !h-9 gap-2 !text-[13px]"><span className="h-2 w-2 rounded-full bg-[#F59E0B]" />SOC 2 Type II — in progress</span>
              <span className="lp-pill-secondary lp-pill-sm !h-9 !text-[13px]">SAML SSO + SCIM</span>
              <span className="lp-pill-secondary lp-pill-sm !h-9 !text-[13px]">Audit logs</span>
              <span className="lp-pill-secondary lp-pill-sm !h-9 !text-[13px]">Self-host or managed</span>
              <span className="lp-pill-secondary lp-pill-sm !h-9 !text-[13px]">White labeling</span>
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="What sovereign means here" heading="Nothing about your AI belongs to us." />
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {sovereignPillars.map((pillar) => {
                const Icon = pillar.icon;
                return (
                  <div key={pillar.title}>
                    <Icon className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} />
                    <h3 className="mt-6 text-[17px] font-semibold">{pillar.title}</h3>
                    <p className="mt-3 text-[14px] leading-[22px] text-[var(--lp-body)]">{pillar.body}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader
              label="Oversight"
              heading="See everything your agents do."
              right={<p className="max-w-[380px] text-[14.5px] leading-[22px] text-[var(--lp-body)] md:text-right">Usage, spend, and a full audit trail — per member, per skill, per model.</p>}
            />
            <div className="mt-10"><LpAnalyticsPanel /></div>
          </section>

          <section className="mt-[120px] grid gap-12 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-center">
            <div>
              <LpSectionHeader label="Identity" heading="Bring your identity provider." />
              <div className="mt-8 flex flex-col gap-3">
                {identityFeatures.map((feature) => (
                  <div key={feature} className="flex items-center gap-2.5 text-[14.5px] text-[var(--lp-ink)]">
                    <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-[var(--lp-ink)] text-white"><Check className="h-2.5 w-2.5" strokeWidth={2.5} /></span>
                    {feature}
                  </div>
                ))}
              </div>
              <a href="/docs" className="lp-pill-secondary lp-pill-sm mt-7">Read the SSO docs</a>
            </div>
            <LpSsoCard />
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="Deployment" heading="From laptop to private cloud." />
            <p className="mt-6 max-w-[680px] text-[16px] leading-[25px] text-[var(--lp-body)]">
              Start local, then move to a dedicated environment without changing how your team works.
            </p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {deployments.map((deployment) => {
                const Icon = deployment.icon;
                const content = (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className={`text-[11px] font-bold tracking-[0.08em] ${deployment.tagClass}`}>{deployment.tag}</div>
                      <Icon className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.75} />
                    </div>
                    <h3 className="mt-6 text-[17px] font-semibold">{deployment.title}</h3>
                    <p className="mt-2 text-[13.5px] leading-[21px] text-[var(--lp-body)]">{deployment.body}</p>
                  </>
                );
                return (
                  <div
                    key={deployment.title}
                    className={`rounded-[24px] bg-[var(--lp-tonal)] p-7 ${deployment.tonal ? "shadow-[0_10px_30px_rgba(1,22,39,0.08)]" : ""}`}
                  >
                    {content}
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex flex-col gap-4 rounded-[12px] bg-[#0B1E30] px-[22px] py-[18px] sm:flex-row sm:items-center sm:justify-between">
              <code className="mono overflow-x-auto text-[13.5px] text-[#E2E8F0]">$ git clone different-ai/openwork &amp;&amp; docker compose up</code>
              <a href="/docs" className="shrink-0 text-[13px] font-medium text-[#7DD3FC]">Self-hosting guide →</a>
            </div>
            <p className="mt-3 text-[13.5px] text-[var(--lp-muted)]">The full stack is open source — run it in your VPC with your keys, your models, and your policies.</p>
          </section>

          <section className="mt-[120px] flex flex-col justify-between gap-8 rounded-[24px] bg-[var(--lp-tonal)] px-7 py-10 md:flex-row md:items-center md:px-12">
            <div className="max-w-[760px]">
              <div className="text-[13px] font-medium text-[var(--lp-blue)]">Central management</div>
              <h2 className="mt-3 text-[26px] font-semibold leading-[34px] tracking-[-0.015em]">Deploy skills, MCPs, and models to every seat from one place.</h2>
              <p className="mt-3 text-[15px] leading-6 text-[var(--lp-body)]">Central management lives in OpenWork Cloud — and runs on your private instance too.</p>
            </div>
            <a href="/cloud" className="lp-pill-primary shrink-0">Explore OpenWork Cloud →</a>
          </section>

          <section className="mt-[120px]">
            <LpSectionHeader label="Compliance" heading="Compliance, in the open." />
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {compliance.map((item) => (
                <div key={item.title} className="rounded-[14px] bg-white p-5 shadow-[0_2px_8px_rgba(1,22,39,0.04)]">
                  <h3 className="text-[16px] font-semibold">{item.title}</h3>
                  <p className="mt-3 text-[13.5px] leading-[21px] text-[var(--lp-body)]">{item.body}</p>
                </div>
              ))}
            </div>
            <a href="/trust" className="mt-6 inline-flex text-[14px] font-medium text-[var(--lp-ink)] underline underline-offset-4">SOC 2 status, DPA, and subprocessors live in the Trust Center →</a>
          </section>

          <div className="mt-[120px]"><BookCallForm /></div>

          <div className="mt-[120px]">
            <LpCta
              heading="Own your AI stack."
              sub="Talk to us about a managed private instance — or self-host the whole thing. Migration from Claude Cowork included."
              primary={{ label: "Book a call →", href: calHref }}
              secondary={{ label: "Read the security docs", href: "/trust" }}
              trust="Open source · SSO · Audit logs · Your models"
            />
          </div>

          <div className="mt-16"><SiteFooter /></div>
        </main>
      </div>
    </div>
  );
}
