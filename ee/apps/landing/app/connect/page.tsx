import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Plug } from "lucide-react";

import { BrandLogo } from "../../components/lp-brand-logos";
import { LpConnectConsole } from "../../components/lp-connect-console";
import { LpCopyButton } from "../../components/lp-copy";
import { MCP_SERVER_URL } from "../../components/lp-mcp-clients";
import {
  GoogleMark,
  LinearMark,
  MicrosoftMark,
  SkillMark,
  SlackMark,
  TerminalMark
} from "../../components/lp-service-marks";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";

export const metadata: Metadata = withSocialMetadata({
  title: "MCP Gateway — add one URL, use your MCPs in every app",
  description:
    "Paste one URL into Claude Code, Cursor, Codex or any MCP client. Sign up in the browser, and your skills and connections follow you. Free for solo use.",
  alternates: { canonical: "/connect" }
});

export default async function ConnectPage() {
  const github = await getGithubData();
  const callHref = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <div className="relative z-10">
        <SiteNav
          stars={github.stars}
          callUrl={callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Get started for free"
          active="connect"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section aria-labelledby="connect-heading" className="pt-12 md:pt-[72px]">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] text-[var(--lp-muted)]">MCP Gateway</span>
              <span className="inline-flex h-[22px] items-center rounded-full bg-[#ECFDF5] px-2.5 text-xs font-medium text-[#047857]">
                Free for solo use
              </span>
            </div>
            <h1
              id="connect-heading"
              className="mt-5 max-w-[880px] text-[40px] font-medium leading-[44px] tracking-[-0.045em] md:text-[60px] md:leading-[64px]"
            >
              <span className="block">Add one URL.</span>
              <span className="block">Use your MCPs in every app.</span>
            </h1>
            <p className="mt-5 max-w-[620px] text-[17px] leading-[27px] text-[var(--lp-body)] md:text-lg md:leading-7">
              Paste it into Claude Code, Cursor, Codex or any MCP client. Sign up when the browser opens.
              Your skills and connections follow you everywhere.
            </p>
            <div className="mt-10">
              <LpConnectConsole />
            </div>
          </section>

          <section aria-label="What happens when you add the URL" className="mt-16 grid gap-6 md:mt-[72px] md:grid-cols-3">
            <HowStep number="01" title="Paste the URL">
              <CodeCard>
                <span className="text-[var(--lp-ink)]">$ claude mcp add … openwork</span>
                <span className="text-[var(--lp-muted)]">&gt; /mcp  openwork · needs sign-in</span>
                <span className="text-[#047857]">Opening your browser…</span>
              </CodeCard>
            </HowStep>
            <HowStep number="02" title="Sign up in the browser">
              <div className="flex h-[132px] flex-col justify-center gap-2.5 rounded-[14px] bg-white px-[18px] shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
                <span className="text-sm font-medium text-[#111827]">Name your workspace</span>
                <span className="flex h-[34px] items-center justify-between rounded-lg px-3 text-[13px] text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">
                  Sam&apos;s workspace <span className="text-[#6B7280]">5 free seats</span>
                </span>
                <span className="self-start rounded-lg bg-[var(--lp-ink)] px-3 py-1.5 text-xs text-white">
                  Create workspace and authorize
                </span>
              </div>
            </HowStep>
            <HowStep number="03" title="Your tools are there">
              <CodeCard>
                <span className="text-[#047857]">✓ openwork connected</span>
                <span className="text-[var(--lp-ink)]">tools: search_capabilities,</span>
                <span className="text-[var(--lp-ink)]">execute_capability, list_skills, get_skill</span>
              </CodeCard>
            </HowStep>
          </section>

          <section aria-labelledby="sharing-heading" className="mt-24 md:mt-32">
            <div className="text-[13px] text-[var(--lp-muted)]">Skill sharing</div>
            <h2
              id="sharing-heading"
              className="mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]"
            >
              <span className="block">Share a skill once.</span>
              <span className="block">Every agent on your team can use it.</span>
            </h2>
            <div className="mt-10 flex flex-col items-stretch gap-6 rounded-[20px] bg-[var(--lp-tonal)] p-5 md:p-8 lg:flex-row lg:items-center lg:gap-0">
              <SkillCard />
              <div className="flex items-center justify-center lg:flex-1" aria-hidden="true">
                <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
                <span className="mono rounded-full bg-white px-3 py-1.5 text-[11px] text-[var(--lp-ink)] shadow-[0_0_0_1px_rgba(1,22,39,0.1)]">
                  /mcp/agent
                </span>
                <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
              </div>
              <ul className="flex flex-col gap-2.5 lg:w-[380px] lg:shrink-0" aria-label="Teammates using the shared skill">
                <TeammateRow mark={<BrandLogo name="claude" className="h-4 w-4 text-[#D97757]" />} who="Priya" app="Claude Code" />
                <TeammateRow mark={<BrandLogo name="cursor" className="h-4 w-4 text-[#111]" />} who="Jordan" app="Cursor" />
                <TeammateRow mark={<TerminalMark className="h-4 w-4" />} who="Sam" app="Codex" />
              </ul>
            </div>
            <div className="mt-8 grid gap-8 md:grid-cols-3">
              <Fact title="Loaded when it's needed">
                Agents see each skill&apos;s name and description. The full SKILL.md loads only when the task calls for it.
              </Fact>
              <Fact title="Edits reach everyone">
                Change the skill and every teammate&apos;s next call uses the new version. Nothing to re-install.
              </Fact>
              <Fact title="Access checked on every call">
                Share with a person, a team or everyone. Remove someone and their agent loses the skill.
              </Fact>
            </div>
          </section>

          <section aria-labelledby="connections-heading" className="mt-24 md:mt-28">
            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
              <div>
                <div className="text-[13px] text-[var(--lp-muted)]">Connections</div>
                <h2 id="connections-heading" className="mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.03em]">
                  Your tools come along too.
                </h2>
              </div>
              <p className="max-w-[380px] text-sm leading-[22px] text-[var(--lp-body)] md:text-right">
                Connect a service once in OpenWork. Every agent you add the URL to can use it.
              </p>
            </div>
            <ul className="mt-8 grid grid-cols-2 border-b border-[var(--lp-border)] md:grid-cols-4">
              {CONNECTIONS.map((connection, index) => (
                <li
                  key={connection.name}
                  className={`flex h-16 items-center gap-3 border-t border-[var(--lp-border)] px-4 md:px-5 ${index % 2 === 1 ? "border-l" : ""} ${index % 4 !== 0 ? "md:border-l" : "md:border-l-0"}`}
                >
                  {connection.mark}
                  <span className="text-sm text-[#111827]">{connection.name}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="pricing-heading" className="mt-24 md:mt-28">
            <h2 id="pricing-heading" className="text-[13px] font-normal text-[var(--lp-muted)]">
              Pricing
            </h2>
            <div className="mt-4 grid border-y border-[var(--lp-border)] md:grid-cols-3">
              <Tier name="Solo" price="Free" note="Just you, every client you use." first />
              <Tier name="Team" price="First 5 seats free" note="Then $10 per seat a month." />
              <Tier name="Enterprise" price="Talk to us" note="SCIM, audit and your own hosting." />
            </div>
          </section>

          <section className="mt-24 md:mt-28">
            <div className="flex flex-col items-start gap-6 rounded-[24px] bg-[var(--lp-tonal)] px-6 py-10 md:px-14 md:py-14">
              <h2 className="text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">
                Copy the URL. Try it in the agent you already use.
              </h2>
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex h-[52px] min-w-0 flex-1 items-center gap-3 rounded-full bg-white pl-5 pr-2 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
                  <code className="mono min-w-0 flex-1 truncate text-[15px] text-[var(--lp-ink)]">{MCP_SERVER_URL}</code>
                  <LpCopyButton value={MCP_SERVER_URL} />
                </div>
                <a href="/docs/start-here/connect-openwork-mcp" className="lp-pill-secondary">
                  Read the docs
                </a>
              </div>
              <span className="text-[13px] text-[var(--lp-muted)]">Free for solo use. No credit card.</span>
            </div>
          </section>

          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}

type Connection = { name: string; mark: ReactNode };

const CONNECTIONS: Connection[] = [
  { name: "Google Workspace", mark: <GoogleMark className="h-5 w-5" /> },
  { name: "Microsoft 365", mark: <MicrosoftMark className="h-5 w-5" /> },
  { name: "Linear", mark: <LinearMark className="h-5 w-5" /> },
  { name: "Slack", mark: <SlackMark className="h-5 w-5" /> },
  { name: "Notion", mark: <BrandLogo name="notion" className="h-5 w-5 text-[#111]" /> },
  { name: "GitHub", mark: <BrandLogo name="github" className="h-5 w-5 text-[#111]" /> },
  { name: "HubSpot", mark: <BrandLogo name="hubspot" className="h-5 w-5 text-[#FF7A59]" /> },
  { name: "Any MCP server", mark: <Plug className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.5} aria-hidden="true" /> }
];

function HowStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <span className="mono text-[13px] text-[var(--lp-muted)]">{number}</span>
        <h2 className="text-[17px] font-medium tracking-[-0.015em]">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function CodeCard({ children }: { children: ReactNode }) {
  return (
    <div className="mono flex h-[132px] flex-col justify-center gap-2 rounded-[14px] bg-white px-[18px] text-xs leading-[18px] shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
      {children}
    </div>
  );
}

function SkillCard() {
  return (
    <div className="flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)] lg:w-[400px] lg:shrink-0">
      <div className="flex items-center justify-between border-b border-[#F0F1F3] px-4 py-3.5">
        <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">
          <SkillMark className="h-[18px] w-[18px]" /> Weekly update
        </span>
        <span className="mono text-[11px] text-[#6B7280]">SKILL.md</span>
      </div>
      <pre className="mono overflow-x-auto px-4 py-3.5 text-xs leading-[18px] text-[#374151]">
{`---
name: weekly-update
description: Draft the Monday update
---
1. Pull closed issues from Linear
2. Add the numbers from Drive
3. Ask before posting to #launch`}
      </pre>
      <div className="flex flex-wrap items-center gap-2.5 border-t border-[#F0F1F3] px-4 py-3">
        <span className="flex-1 text-xs text-[#4B5563]">Who can use it</span>
        <span className="flex h-[30px] items-center rounded-lg px-2.5 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">
          Everyone in the organization
        </span>
        <span className="flex h-[30px] items-center rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white">Share</span>
      </div>
    </div>
  );
}

function TeammateRow({ mark, who, app }: { mark: ReactNode; who: string; app: string }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl bg-white px-4 py-3.5 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
      <span className="flex items-center gap-2">
        {mark}
        <span className="text-[13px] font-medium text-[#111827]">{who}</span>
        <span className="text-xs text-[#6B7280]">in {app}</span>
      </span>
      <span className="mono text-xs text-[#047857]">● openwork · Used Weekly update skill</span>
    </li>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--lp-border)] pt-5">
      <h3 className="text-base font-medium tracking-[-0.01em]">{title}</h3>
      <p className="text-sm leading-[22px] text-[var(--lp-body)]">{children}</p>
    </div>
  );
}

function Tier({ name, price, note, first = false }: { name: string; price: string; note: string; first?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 py-6 ${first ? "md:pr-6" : "border-t border-[var(--lp-border)] md:border-l md:border-t-0 md:px-6"}`}>
      <span className="text-sm text-[var(--lp-body)]">{name}</span>
      <span className="text-[28px] font-medium tracking-[-0.03em]">{price}</span>
      <span className="text-[13px] text-[var(--lp-muted)]">{note}</span>
    </div>
  );
}
