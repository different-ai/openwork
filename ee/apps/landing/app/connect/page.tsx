import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Plug } from "lucide-react";

import { BrandLogo } from "../../components/lp-brand-logos";
import { LpConnectConsole } from "../../components/lp-connect-console";
import { LpCopyButton } from "../../components/lp-copy";
import { MCP_SERVER_URL } from "../../components/lp-mcp-clients";
import {
  CLOUD_SIGNUP_URL,
  LpFact,
  LpMarkGrid,
  LpProductCta,
  LpProductHeading,
  LpProductHero,
  LpProductShell,
  LpStep,
  LpStepCard,
  LpTiers,
  salesCallHref
} from "../../components/lp-product-page";
import {
  GoogleMark,
  LinearMark,
  MicrosoftMark,
  SkillMark,
  SlackMark,
  TerminalMark
} from "../../components/lp-service-marks";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

export const metadata: Metadata = withSocialMetadata({
  title: "MCP Gateway — add one URL, use your MCPs in every app",
  description:
    "Paste one URL into Claude Code, Cursor, Codex or any MCP client. Sign up in the browser, and your skills and connections follow you. Free for solo use.",
  alternates: { canonical: "/connect" }
});

export default async function ConnectPage() {
  const github = await getGithubData();
  const callHref = salesCallHref();

  return (
    <LpProductShell
      stars={github.stars}
      callHref={callHref}
      active="connect"
      current="mcp-gateway"
      mobilePrimary={{ href: CLOUD_SIGNUP_URL, label: "Get started for free" }}
    >
      <LpProductHero
        id="connect-heading"
        label="MCP Gateway"
        badge="Free for solo use"
        lines={["Add one URL.", "Use your MCPs in every app."]}
        sub="Paste it into Claude Code, Cursor, Codex or any MCP client. Sign up when the browser opens. Your skills and connections follow you everywhere."
      >
        <LpConnectConsole />
      </LpProductHero>

      <section aria-label="What happens when you add the URL" className="mt-16 grid gap-6 md:mt-[72px] md:grid-cols-3">
        <LpStep number="01" title="Paste the URL">
          <LpStepCard mono>
            <span className="text-[var(--lp-ink)]">$ claude mcp add … openwork</span>
            <span className="text-[var(--lp-muted)]">&gt; /mcp  openwork · needs sign-in</span>
            <span className="text-[#047857]">Opening your browser…</span>
          </LpStepCard>
        </LpStep>
        <LpStep number="02" title="Sign up in the browser">
          <LpStepCard>
            <span className="text-sm font-medium text-[#111827]">Name your workspace</span>
            <span className="flex h-[34px] items-center justify-between rounded-lg px-3 text-[13px] text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">
              Sam&apos;s workspace <span className="text-[#6B7280]">Free plan · up to 5 users</span>
            </span>
            <span className="self-start rounded-lg bg-[var(--lp-ink)] px-3 py-1.5 text-xs text-white">
              Create workspace and authorize
            </span>
          </LpStepCard>
        </LpStep>
        <LpStep number="03" title="Your tools are there">
          <LpStepCard mono>
            <span className="text-[#047857]">✓ openwork connected</span>
            <span className="text-[var(--lp-ink)]">tools: search_capabilities,</span>
            <span className="text-[var(--lp-ink)]">execute_capability, list_skills, get_skill</span>
          </LpStepCard>
        </LpStep>
      </section>

      <section aria-labelledby="sharing-heading" className="mt-24 md:mt-32">
        <LpProductHeading
          id="sharing-heading"
          label="Skill sharing"
          lines={["Share a skill once.", "Every agent on your team can use it."]}
        />
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
          <LpFact title="Loaded when it's needed">
            Agents see each skill&apos;s name and description. The full SKILL.md loads only when the task calls for it.
          </LpFact>
          <LpFact title="Edits reach everyone">
            Change the skill and every teammate&apos;s next call uses the new version. Nothing to re-install.
          </LpFact>
          <LpFact title="Access checked on every call">
            Share with a person, a team or everyone. Remove someone and their agent loses the skill.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="connections-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="connections-heading"
          label="Connections"
          lines={["Your tools come along too."]}
          aside="Connect a service once in OpenWork. Every agent you add the URL to can use it."
          size="small"
        />
        <LpMarkGrid label="Connections" items={CONNECTIONS} />
      </section>

      <LpTiers
        id="pricing-heading"
        tiers={[
          { name: "Solo", price: "Free", note: "Just you, every client you use." },
          { name: "Team", price: "$10 per user a month", note: "The Free plan covers up to 5 users." },
          { name: "Enterprise", price: "Talk to us", note: "SCIM, audit and your own hosting." }
        ]}
      />

      <LpProductCta heading="Copy the URL. Try it in the agent you already use." note="Free for solo use. No credit card.">
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex h-[52px] min-w-0 flex-1 items-center gap-3 rounded-full bg-white pl-5 pr-2 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
            <code className="mono min-w-0 flex-1 truncate text-[15px] text-[var(--lp-ink)]">{MCP_SERVER_URL}</code>
            <LpCopyButton value={MCP_SERVER_URL} />
          </div>
          <a href="/docs/start-here/connect-openwork-mcp" className="lp-pill-secondary">
            Read the docs
          </a>
        </div>
      </LpProductCta>
    </LpProductShell>
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
