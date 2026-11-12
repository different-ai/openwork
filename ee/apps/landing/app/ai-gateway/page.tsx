import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Route } from "lucide-react";

import { LandingFaq } from "../../components/landing-faq";
import { BrandLogo } from "../../components/lp-brand-logos";
import { LpDemoAiGateway } from "../../components/lp-demo-panels";
import {
  CLOUD_SIGNUP_URL,
  LpFact,
  LpMarkGrid,
  LpPreviewFrame,
  LpProductCta,
  LpProductHeading,
  LpProductHero,
  LpProductShell,
  LpStatusBadge,
  LpStep,
  LpStepCard,
  LpTiers,
  salesCallHref
} from "../../components/lp-product-page";
import { AwsMark, MicrosoftMark } from "../../components/lp-service-marks";
import { StructuredData } from "../../components/structured-data";
import { aiGatewayFaq, faqSchema } from "../../lib/faq";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

const DOCS_URL = "/docs/ai-gateway/overview";

export const metadata: Metadata = withSocialMetadata({
  title: "AI Gateway — add a provider once, give everyone the right models",
  description:
    "Connect OpenAI, Anthropic, Bedrock, Vertex or Azure once. Choose who can use each model, set spend limits, and see cost by person. Members never handle a key.",
  alternates: { canonical: "/ai-gateway" }
});

export default async function AiGatewayPage() {
  const github = await getGithubData();
  const callHref = salesCallHref();

  return (
    <LpProductShell
      stars={github.stars}
      callHref={callHref}
      active="ai-gateway"
      current="ai-gateway"
      mobilePrimary={{ href: CLOUD_SIGNUP_URL, label: "Set up AI Gateway" }}
    >
      <StructuredData data={faqSchema(aiGatewayFaq)} />

      <LpProductHero
        id="ai-gateway-heading"
        label="AI Gateway"
        badge="Keys stay on the server"
        lines={["Add a provider once.", "Everyone gets the right models."]}
        sub="Connect OpenAI, Anthropic, Bedrock, Vertex or Azure in OpenWork Cloud. Choose who can use each model and set spend limits. Members pick a model and never handle a key."
        actions={
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">
                Set up AI Gateway
              </a>
              <a href={DOCS_URL} className="lp-pill-secondary">
                Read the docs
              </a>
            </div>
            <span className="text-[13px] text-[var(--lp-muted)]">On OpenWork Cloud or self-hosted.</span>
          </div>
        }
      >
        <LpPreviewFrame label="AI Gateway preview">
          <LpDemoAiGateway />
        </LpPreviewFrame>
        <p className="mt-3 text-[13px] text-[var(--lp-muted)]">
          A working preview. Add a provider, change who can use it, raise a limit.
        </p>
      </LpProductHero>

      <section aria-label="How to set up AI Gateway" className="mt-16 grid gap-6 md:mt-[72px] md:grid-cols-3">
        <LpStep number="01" title="Add a provider">
          <LpStepCard>
            <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">
              <BrandLogo name="anthropic" className="h-4 w-4 text-[#191919]" /> Anthropic
            </span>
            <span className="mono flex h-[34px] items-center justify-between rounded-lg px-3 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB]">
              sk-ant-•••••••••••• <span className="text-[#6B7280]">Shared API key</span>
            </span>
            <span className="self-start rounded-lg bg-[var(--lp-ink)] px-3 py-1.5 text-xs text-white">Add provider</span>
          </LpStepCard>
        </LpStep>
        <LpStep number="02" title="Choose who can use it">
          <LpStepCard>
            <StepRow label="Who can use it" value="Engineering" />
            <StepRow label="Models" value="Claude Sonnet, Haiku" />
            <StepRow label="Members' own keys" value="Not allowed" />
          </LpStepCard>
        </LpStep>
        <LpStep number="03" title="Members pick a model">
          <LpStepCard>
            <span className="text-[11px] text-[#6B7280]">From Acme Studio</span>
            <span className="flex h-[30px] items-center justify-between rounded-lg bg-[#F5F7FA] px-2.5 text-[13px] font-medium text-[#111827]">
              Claude Sonnet <span aria-hidden="true">✓</span>
            </span>
            <span className="flex h-[30px] items-center px-2.5 text-[13px] text-[#374151]">Claude Haiku</span>
          </LpStepCard>
        </LpStep>
      </section>

      <section aria-labelledby="flow-heading" className="mt-24 md:mt-32">
        <LpProductHeading
          id="flow-heading"
          label="How a prompt reaches a model"
          lines={["One key for each person.", "Provider keys never leave the server."]}
        />
        <div className="mt-10 flex flex-col items-stretch gap-4 rounded-[20px] bg-[var(--lp-tonal)] p-5 md:p-8 lg:flex-row lg:items-center lg:gap-0">
          <FlowCard title="Priya in OpenWork" className="lg:w-[320px] lg:shrink-0">
            <FlowLine label="model" value="Claude Sonnet" />
            <FlowLine label="key" value="ow_gw_••••••••" />
            <span className="mono mt-1 text-xs text-[var(--lp-ink)]">&gt; Summarize the Q3 pipeline</span>
          </FlowCard>
          <FlowConnector />
          <FlowCard title="AI Gateway" className="lg:w-[320px] lg:shrink-0">
            <FlowCheck>Key belongs to Priya</FlowCheck>
            <FlowCheck>Engineering can use Claude Sonnet</FlowCheck>
            <FlowCheck>$148 of $200 used this month</FlowCheck>
          </FlowCard>
          <FlowConnector />
          <ul className="flex flex-col gap-2.5 lg:w-[300px] lg:shrink-0" aria-label="Providers the gateway can send the request to">
            <ProviderRow mark={<BrandLogo name="anthropic" className="h-4 w-4 text-[#191919]" />} name="Anthropic" credential="Organization key" chosen />
            <ProviderRow mark={<BrandLogo name="openai" className="h-4 w-4 text-[#111]" />} name="OpenAI" credential="Organization key" />
            <ProviderRow mark={<BrandLogo name="gemini" className="h-4 w-4 text-[#4285F4]" />} name="Google Vertex AI" credential="Priya's Google sign-in" />
          </ul>
        </div>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Keys stay on the server">
            Provider keys are stored encrypted and only the gateway reads them. The app gets one AI Gateway key for each person.
          </LpFact>
          <LpFact title="Access checked on every request">
            Grant models to everyone, a team or one person. Remove someone and their next request is refused.
          </LpFact>
          <LpFact title="Usage by person">
            Tokens and estimated cost for the last 31 days, by model, team and person.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="limits-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="limits-heading"
          label="Spend limits"
          lines={["Set the budget before the month starts."]}
          aside="Every request goes through the gateway, so a limit applies in whichever app a member uses."
          size="small"
        />
        <div className="mt-8 grid items-start gap-8 lg:grid-cols-2 lg:gap-12">
          <LimitCard />
          <div className="grid gap-8">
            <LpFact title="Daily, weekly and monthly">
              Give a team or a person an amount in US dollars for each period. A member has to stay under all of them.
            </LpFact>
            <LpFact title="Pause or only warn">
              Stop requests when someone reaches a limit, or let them keep working and flag it for follow-up.
            </LpFact>
            <LpFact title="Members can ask for more">
              Let members ask for 25% more when they reach a limit. An admin approves or denies the request.
            </LpFact>
          </div>
        </div>
      </section>

      <section aria-labelledby="providers-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="providers-heading"
          label="Providers"
          lines={["Use the providers you already pay for."]}
          aside={
            <>
              Already run LiteLLM or Bifrost? Keep it and add it as a provider.{" "}
              <a href="/docs/ai-gateway/compare-litellm-bifrost" className="text-[var(--lp-ink)] underline underline-offset-4">
                Compare them
              </a>
            </>
          }
          size="small"
        />
        <LpMarkGrid label="Supported providers" items={PROVIDERS} />
      </section>

      <section aria-labelledby="more-heading" className="mt-24 md:mt-28">
        <LpProductHeading id="more-heading" label="Rolling out" lines={["More ways to use the same models."]} size="small" />
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <LpFact
            title={
              <>
                Smart Model Router<LpStatusBadge>Rolling out on Cloud</LpStatusBadge>
              </>
            }
          >
            Members pick Smart instead of a model. Each prompt goes to the model you tagged for that kind of work, at the thinking level it needs.{" "}
            <a href="/docs/ai-gateway/auto-model-routing" className="text-[var(--lp-ink)] underline underline-offset-4">
              How routing works
            </a>
          </LpFact>
          <LpFact
            title={
              <>
                Keys for Claude Code, Codex and Cursor<LpStatusBadge>Rolling out</LpStatusBadge>
              </>
            }
          >
            Members create their own AI Gateway API key and use your organization&apos;s models in other tools. The same access rules and limits apply.{" "}
            <a href="/docs/ai-gateway/third-party-tools" className="text-[var(--lp-ink)] underline underline-offset-4">
              How API keys work
            </a>
          </LpFact>
        </div>
      </section>

      <LpTiers
        id="ai-gateway-pricing-heading"
        tiers={[
          { name: "Team", price: "$10 per user a month", note: "Shared provider keys and model access rules." },
          { name: "Enterprise", price: "Talk to us", note: "Spend observability, audit log and SCIM." },
          { name: "OpenWork Models", price: "$10 per user a month", note: "Optional. Managed models with no keys to add." }
        ]}
        footnote="Your providers bill model usage. The same terms apply on OpenWork Cloud and self-hosted."
      />

      <div className="mt-24 md:mt-28">
        <LandingFaq entries={aiGatewayFaq} tone="product" />
      </div>

      <LpProductCta heading="Give your team models without handing out keys." note="Shared provider keys are on the Team plan.">
        <div className="flex flex-col gap-3 sm:flex-row">
          <a href={CLOUD_SIGNUP_URL} className="lp-pill-primary">
            Set up AI Gateway
          </a>
          <a href={DOCS_URL} className="lp-pill-secondary">
            Read the docs
          </a>
        </div>
      </LpProductCta>
    </LpProductShell>
  );
}

const PROVIDERS: { name: string; mark: ReactNode }[] = [
  { name: "OpenAI", mark: <BrandLogo name="openai" className="h-5 w-5 text-[#111]" /> },
  { name: "Anthropic", mark: <BrandLogo name="anthropic" className="h-5 w-5 text-[#191919]" /> },
  { name: "Google Vertex AI", mark: <BrandLogo name="gemini" className="h-5 w-5 text-[#4285F4]" /> },
  { name: "Amazon Bedrock", mark: <AwsMark className="h-5 w-5" /> },
  { name: "Azure OpenAI", mark: <MicrosoftMark className="h-5 w-5" /> },
  { name: "Mistral", mark: <BrandLogo name="mistral" className="h-5 w-5 text-[#FA520F]" /> },
  { name: "OpenRouter", mark: <BrandLogo name="openrouter" className="h-5 w-5 text-[#6467F2]" /> },
  { name: "LiteLLM and more", mark: <Route className="h-5 w-5 text-[var(--lp-ink)]" strokeWidth={1.5} aria-hidden="true" /> }
];

function StepRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-[#4B5563]">{label}</span>
      <span className="font-medium text-[#111827]">{value}</span>
    </span>
  );
}

function FlowCard({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)] ${className ?? ""}`}>
      <div className="border-b border-[#F0F1F3] px-4 py-3.5 text-sm font-medium text-[#111827]">{title}</div>
      <div className="flex flex-col gap-2 px-4 py-3.5">{children}</div>
    </div>
  );
}

function FlowLine({ label, value }: { label: string; value: string }) {
  return (
    <span className="mono flex gap-3 text-xs leading-[18px]">
      <span className="w-10 shrink-0 text-[#8A93A0]">{label}</span>
      <span className="text-[#374151]">{value}</span>
    </span>
  );
}

function FlowCheck({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-start gap-2 text-[13px] leading-[18px] text-[#374151]">
      <span className="text-[#047857]" aria-hidden="true">
        ✓
      </span>
      {children}
    </span>
  );
}

function FlowConnector() {
  return <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" aria-hidden="true" />;
}

function ProviderRow({ mark, name, credential, chosen = false }: { mark: ReactNode; name: string; credential: string; chosen?: boolean }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-xl bg-white px-4 py-3.5 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
      <span className="flex items-center gap-2">
        {mark}
        <span className="text-[13px] font-medium text-[#111827]">{name}</span>
      </span>
      <span className={`mono text-xs ${chosen ? "text-[#047857]" : "text-[#6B7280]"}`}>
        {chosen ? `● Sent with the ${credential.toLowerCase()}` : credential}
      </span>
    </li>
  );
}

function LimitCard() {
  return (
    <div className="rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)]">
      <div className="flex items-center justify-between border-b border-[#F0F1F3] px-4 py-3.5">
        <span className="text-sm font-medium text-[#111827]">Engineering</span>
        <span className="text-xs text-[#6B7280]">Anthropic, OpenAI</span>
      </div>
      <dl className="flex flex-col px-4">
        <LimitRow label="Daily" value="$20" />
        <LimitRow label="Monthly" value="$200" />
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 border-b border-[#F0F1F3] py-3 text-xs text-[#4B5563]">
          <dt>Used this month</dt>
          <dd className="contents">
            <span>$148 of $200</span>
            <span className="col-span-2 h-1.5 rounded-full bg-[#E8ECF1]" aria-hidden="true">
              <span className="block h-1.5 w-[74%] rounded-full bg-[var(--lp-ink)]" />
            </span>
          </dd>
        </div>
        <LimitRow label="When someone reaches it" value="Pause their models" />
        <LimitRow label="Let them ask for 25% more" value="On" last />
      </dl>
    </div>
  );
}

function LimitRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex min-h-[44px] items-center justify-between gap-3 text-[13px] ${last ? "" : "border-b border-[#F0F1F3]"}`}>
      <dt className="text-[#4B5563]">{label}</dt>
      <dd className="font-medium text-[#111827]">{value}</dd>
    </div>
  );
}
