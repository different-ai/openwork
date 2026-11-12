import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Globe, Monitor, Plug } from "lucide-react";

import { LandingFaq } from "../../components/landing-faq";
import { BrandLogo } from "../../components/lp-brand-logos";
import { LpDemoCloud } from "../../components/lp-demo-panels";
import {
  CLOUD_SIGNUP_URL,
  LpFact,
  LpPreviewFrame,
  LpProductCta,
  LpProductHeading,
  LpProductHero,
  LpProductShell,
  LpStep,
  LpStepCard,
  LpTiers,
  salesCallHref
} from "../../components/lp-product-page";
import { LinearMark, SkillMark } from "../../components/lp-service-marks";
import { LpTrustRow } from "../../components/lp-trust-row";
import { StructuredData } from "../../components/structured-data";
import { cloudFaq, faqSchema } from "../../lib/faq";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

export const metadata: Metadata = withSocialMetadata({
  title: "OpenWork Cloud — run OpenWork for your team from one dashboard",
  description:
    "OpenWork Cloud is where a team shares skills, connections and models, manages members and sets policies. OpenWork Web opens the full app in a browser tab. Free for up to 5 users.",
  alternates: { canonical: "/cloud" }
});

export default async function CloudPage() {
  const github = await getGithubData();
  const callHref = salesCallHref();

  return (
    <LpProductShell stars={github.stars} callHref={callHref} active="cloud" current="cloud-app" mobilePrimary={{ href: CLOUD_SIGNUP_URL, label: "Get started for free" }}>
      <StructuredData data={faqSchema(cloudFaq)} />

      <LpProductHero
        id="cloud-heading"
        label="Cloud App"
        badge="Free for up to 5 users"
        lines={["Run OpenWork for your team.", "From one dashboard."]}
        sub="OpenWork Cloud is where a team shares skills, connections and models, manages members and sets policies. OpenWork Web opens the full app in a browser tab."
        actions={
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">
                Get started free
              </a>
              <a href={callHref} className="lp-pill-secondary">
                Talk to sales
              </a>
            </div>
            <span className="text-[13px] text-[var(--lp-muted)]">For the desktop app, the browser and any MCP client.</span>
          </div>
        }
      >
        <LpPreviewFrame label="OpenWork Cloud preview" tall>
          <LpDemoCloud />
        </LpPreviewFrame>
        <p className="mt-3 text-[13px] text-[var(--lp-muted)]">
          A working preview. Switch between OpenWork Web and the admin dashboard.
        </p>
      </LpProductHero>

      <section aria-label="How to set up a team" className="mt-16 grid gap-6 md:mt-[72px] md:grid-cols-3">
        <LpStep number="01" title="Create your organization">
          <LpStepCard>
            <span className="text-sm font-medium text-[#111827]">Name your organization</span>
            <span className="flex h-[34px] items-center justify-between rounded-lg px-3 text-[13px] text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">
              Acme Studio <span className="text-[#6B7280]">Free plan</span>
            </span>
            <span className="self-start rounded-lg bg-[var(--lp-ink)] px-3 py-1.5 text-xs text-white">Create organization</span>
          </LpStepCard>
        </LpStep>
        <LpStep number="02" title="Invite your team">
          <LpStepCard>
            <StepRow label="priya@acme.studio" value="Admin" />
            <StepRow label="jordan@acme.studio" value="Member" />
            <span className="text-xs text-[#6B7280]">3 of 5 users on the Free plan</span>
          </LpStepCard>
        </LpStep>
        <LpStep number="03" title="Share what they need">
          <LpStepCard>
            <ShareRow mark={<SkillMark className="h-4 w-4" />} name="Weekly update" who="Everyone" />
            <ShareRow mark={<LinearMark className="h-4 w-4" />} name="Linear" who="Everyone" />
            <ShareRow mark={<BrandLogo name="anthropic" className="h-4 w-4 text-[#191919]" />} name="Claude Sonnet" who="Engineering" />
          </LpStepCard>
        </LpStep>
      </section>

      <section aria-labelledby="everywhere-heading" className="mt-24 md:mt-32">
        <LpProductHeading
          id="everywhere-heading"
          label="One setup"
          lines={["Share it once.", "It shows up everywhere your team works."]}
        />
        <div className="mt-10 flex flex-col items-stretch gap-6 rounded-[20px] bg-[var(--lp-tonal)] p-5 md:p-8 lg:flex-row lg:items-center lg:gap-0">
          <div className="flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)] lg:w-[400px] lg:shrink-0">
            <div className="flex items-center justify-between border-b border-[#F0F1F3] px-4 py-3.5">
              <span className="text-sm font-medium text-[#111827]">Shared with Acme Studio</span>
              <span className="text-[11px] text-[#6B7280]">Cloud dashboard</span>
            </div>
            <ul className="flex flex-col px-4">
              <SharedRow mark={<SkillMark className="h-[18px] w-[18px]" />} name="Weekly update" kind="Skill" who="Everyone" />
              <SharedRow mark={<LinearMark className="h-[18px] w-[18px]" />} name="Linear" kind="Connection" who="Everyone" />
              <SharedRow mark={<BrandLogo name="anthropic" className="h-[18px] w-[18px] text-[#191919]" />} name="Claude Sonnet" kind="Model" who="Engineering" last />
            </ul>
          </div>
          <div className="flex items-center justify-center lg:flex-1" aria-hidden="true">
            <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
            <span className="mono rounded-full bg-white px-3 py-1.5 text-[11px] text-[var(--lp-ink)] shadow-[0_0_0_1px_rgba(1,22,39,0.1)]">
              on sign-in
            </span>
            <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
          </div>
          <ul className="flex flex-col gap-2.5 lg:w-[380px] lg:shrink-0" aria-label="Where shared items show up">
            <SurfaceRow icon={<Monitor size={16} strokeWidth={1.5} aria-hidden="true" />} name="Desktop app" detail="Mac, Windows and Linux" items="Weekly update · Linear · Claude Sonnet" />
            <SurfaceRow icon={<Globe size={16} strokeWidth={1.5} aria-hidden="true" />} name="OpenWork Web" detail="In a browser tab" items="Weekly update · Linear · Claude Sonnet" />
            <SurfaceRow icon={<Plug size={16} strokeWidth={1.5} aria-hidden="true" />} name="Any MCP client" detail="Claude Code, Cursor, Codex" items="Weekly update · Linear" />
          </ul>
        </div>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Nothing to re-install">
            Change a skill or add a connection and every member has it the next time their app syncs.
          </LpFact>
          <LpFact title="Access by team">
            Share with everyone, a team or one person. Remove someone and they lose it.
          </LpFact>
          <LpFact title="One sign-in">
            Members sign in once. The app picks up the skills, connections and models they are allowed to use.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="manage-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="manage-heading"
          label="The dashboard"
          lines={["Members, tools and models in one place."]}
          size="small"
        />
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Members and roles">
            Invite people, group them into teams and choose what each role can do.
          </LpFact>
          <LpFact title="Library">
            Skills, plugins and connections, shared with everyone, a team or one person.
          </LpFact>
          <LpFact title="MCP Gateway">
            Everything in the Library reaches any MCP client through one URL. <FactLink href="/connect" label="Learn more about MCP Gateway">Learn more</FactLink>
          </LpFact>
          <LpFact title="AI Gateway">
            Connect model providers once and choose who can use each model. <FactLink href="/ai-gateway" label="Learn more about AI Gateway">Learn more</FactLink>
          </LpFact>
          <LpFact title="Policies">
            Limit members to the models you provide and choose which desktop versions are allowed.
          </LpFact>
          <LpFact title="Analytics">
            Usage and adoption across every member. Basic on Team, full on Enterprise.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="web-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="web-heading"
          label="OpenWork Web"
          lines={["The full app in a browser tab."]}
          aside="An add-on at $50 per member a month, on Team and Enterprise."
          size="small"
        />
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Nothing to install">
            Open OpenWork Web from the dashboard. Each member gets a cloud computer of their own.
          </LpFact>
          <LpFact title="Picks up where you left off">
            It sleeps when idle and wakes when you open it. Files in the workspace are kept.
          </LpFact>
          <LpFact title="Runs while your laptop is off">
            Cloud Automations run on your cloud computer, even when your own computer is off.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="security-heading" className="mt-24 md:mt-28">
        <LpProductHeading id="security-heading" label="Sign-in and security" lines={["Fits the way your company already signs in."]} size="small" />
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Single sign-on">
            Any SAML or OIDC identity provider, such as Okta, Microsoft Entra or Google Workspace. On the Team plan.
          </LpFact>
          <LpFact title="Provisioning and audit">
            SCIM adds and removes people as they change in your identity provider. The audit log records who changed what. On Enterprise.
          </LpFact>
          <LpFact title="Run it yourself">
            Self-host the full platform on your own infrastructure. Free for up to 5 users.{" "}
            <FactLink href="/docs/start-here/self-host" label="Read the self-hosting docs">Read the docs</FactLink>
          </LpFact>
        </div>
        <LpTrustRow className="mt-8" />
      </section>

      <LpTiers
        id="cloud-pricing-heading"
        tiers={[
          { name: "Free", price: "$0", note: "Up to 5 users, on Cloud or self-hosted." },
          { name: "Team", price: "$10 per user a month", note: "Unlimited users, SSO and cloud automations." },
          { name: "Enterprise", price: "Talk to us", note: "SCIM, audit log and desktop policies." }
        ]}
        footnote={
          <>
            Add-ons on Team and Enterprise: OpenWork Web at $50 per member a month, OpenWork Models at $10 per user a month.{" "}
            <a href="/pricing" className="text-[var(--lp-ink)] underline underline-offset-4">
              See pricing
            </a>
          </>
        }
      />

      <div className="mt-24 md:mt-28">
        <LandingFaq entries={cloudFaq} tone="product" />
      </div>

      <LpProductCta heading="Bring your team onto OpenWork." note="Free plan for up to 5 users.">
        <div className="flex flex-col gap-3 sm:flex-row">
          <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">
            Get started free
          </a>
          <a href={callHref} className="lp-pill-secondary">
            Talk to sales
          </a>
        </div>
      </LpProductCta>
    </LpProductShell>
  );
}

function StepRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-3 text-[13px]">
      <span className="min-w-0 truncate text-[#111827]">{label}</span>
      <span className="text-[#4B5563]">{value}</span>
    </span>
  );
}

function ShareRow({ mark, name, who }: { mark: ReactNode; name: string; who: string }) {
  return (
    <span className="flex items-center gap-2.5 text-[13px]">
      {mark}
      <span className="min-w-0 flex-1 truncate font-medium text-[#111827]">{name}</span>
      <span className="text-[#4B5563]">{who}</span>
    </span>
  );
}

function SharedRow({ mark, name, kind, who, last = false }: { mark: ReactNode; name: string; kind: string; who: string; last?: boolean }) {
  return (
    <li className={`flex min-h-[44px] items-center gap-3 ${last ? "" : "border-b border-[#F0F1F3]"}`}>
      <span className="flex w-[18px] shrink-0">{mark}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#111827]">{name}</span>
      <span className="hidden w-[76px] shrink-0 text-xs text-[#6B7280] sm:block">{kind}</span>
      <span className="w-[76px] shrink-0 text-right text-xs text-[#374151]">{who}</span>
    </li>
  );
}

function SurfaceRow({ icon, name, detail, items }: { icon: ReactNode; name: string; detail: string; items: string }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-xl bg-white px-4 py-3.5 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--lp-ink)]">
        {icon}
        <span className="whitespace-nowrap text-[13px] font-medium text-[#111827]">{name}</span>
        <span className="text-xs text-[#6B7280]">{detail}</span>
      </span>
      <span className="mono text-xs text-[#047857]">● {items}</span>
    </li>
  );
}

function FactLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a href={href} aria-label={label} className="whitespace-nowrap text-[var(--lp-ink)] underline underline-offset-4">
      {children}
    </a>
  );
}
