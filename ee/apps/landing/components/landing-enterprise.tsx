import { Check, ChevronRight, Folder, Laptop, MessageSquare, Paperclip } from "lucide-react";
import type { ReactNode } from "react";

import { BookCallForm } from "./book-call-form";
import { CoworkComparison } from "./cowork-comparison";
import { BrandLogo } from "./lp-brand-logos";
import { LpDemoAiGateway } from "./lp-demo-panels";
import { LpArrowLink, LpSectionHeader } from "./lp-primitives";
import { OpenCodeMark, TerminalMark } from "./lp-service-marks";
import { LpTrustRow } from "./lp-trust-row";
import { OpenWorkMark } from "./openwork-mark";
import { RoadmapStatusPill } from "./roadmap-page";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { enterpriseFaq } from "../lib/enterprise";
import {
  enterpriseAgents,
  enterpriseAgentsNote,
  enterpriseControls,
  enterpriseDataBoundary,
  enterpriseDataPath,
  enterpriseDeployments,
  enterpriseRollout,
  enterpriseRolloutNote,
  enterpriseShadowAi,
  type EnterpriseAccess,
  type EnterpriseAgentId,
  type EnterpriseFact
} from "../lib/enterprise-sections";
import { capabilityRows } from "../lib/cowork-capabilities";
import { TRUST_CENTER_URL } from "../lib/trust-center";

type Props = {
  stars: string;
  calUrl: string;
};

const section = "mt-24 scroll-mt-24 md:mt-32";
/** The product-window frame used by the roadmap and the homepage product tabs. */
const productFrame =
  "overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_2px_4px_rgba(1,22,39,0.04),0_32px_64px_-24px_rgba(1,22,39,0.22)]";
/** White card on a tonal panel, as on the MCP gateway page. */
const panelCard = "rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)]";

const agentMarks: Record<EnterpriseAgentId, ReactNode> = {
  openwork: <OpenWorkMark className="h-[18px] w-[22px] object-contain" />,
  opencode: <OpenCodeMark className="h-5 w-5" />,
  "claude-code": <BrandLogo name="claude" className="h-5 w-5 text-[#D97757]" />,
  codex: <TerminalMark className="h-5 w-5" />,
  cursor: <BrandLogo name="cursor" className="h-5 w-5 text-[#111]" />
};

/** Hairline-topped title and detail, as on the MCP gateway page. */
function Fact({ fact }: { fact: EnterpriseFact }) {
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--lp-border)] pt-5">
      <h3 className="text-base font-medium tracking-[-0.01em]">{fact.title}</h3>
      <p className="text-sm leading-[22px] text-[var(--lp-body)]">{fact.detail}</p>
    </div>
  );
}

function Access({ access }: { access: EnterpriseAccess }) {
  return access === "ready" ? <RoadmapStatusPill status="ready" /> : <RoadmapStatusPill status="building" label="In progress" />;
}

function BoundaryCard({ title, state, rows }: { title: ReactNode; state: ReactNode; rows: { icon: ReactNode; label: string }[] }) {
  return (
    <div className={`flex flex-col lg:w-[380px] lg:shrink-0 ${panelCard}`}>
      <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[#F0F1F3] px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">{title}</span>
        <span className="flex items-center gap-1.5 text-xs text-[#4B5563]">{state}</span>
      </div>
      <ul className="flex flex-col px-4 py-1.5">
        {rows.map((row) => (
          <li key={row.label} className="flex h-11 items-center gap-3 border-b border-[#F0F1F3] text-[13px] text-[#111827] last:border-b-0">
            <span className="flex w-4 shrink-0 text-[#6B7280]" aria-hidden="true">{row.icon}</span>
            {row.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingEnterprise(props: Props) {
  const calHref = props.calUrl || "#book";
  const calExternal = /^https?:\/\//.test(calHref);
  const calProps = calExternal ? { target: "_blank", rel: "noreferrer" } : {};

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={props.stars} callUrl={props.calUrl} active="enterprise" mobilePrimaryHref="#book" mobilePrimaryLabel="Contact sales" />

      <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
        <section aria-labelledby="enterprise-heading" className="pt-12 md:pt-[72px]">
          <p className="text-[13px] text-[var(--lp-muted)]">OpenWork Enterprise</p>
          <h1
            id="enterprise-heading"
            className="mt-5 max-w-[880px] text-[40px] font-medium leading-[44px] tracking-[-0.045em] md:text-[60px] md:leading-[64px]"
          >
            <span className="block">AI your team wants.</span>
            <span className="block">Control IT needs.</span>
          </h1>
          <p className="mt-5 max-w-[620px] text-[17px] leading-[27px] text-[var(--lp-body)] md:text-lg md:leading-7">
            Give employees an approved way to work with AI. Company sign-in, permissions, and your choice of provider, without forcing everyone into the same agent.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href={calHref} {...calProps} className="lp-btn">
              Book a demo
            </a>
            <a href="#comparison" className="lp-btn lp-btn--secondary">
              Compare with Claude Cowork
            </a>
          </div>
          <LpTrustRow />
        </section>

        <section id="controls" aria-label="What IT controls" className="mt-12 scroll-mt-24 md:mt-16">
          <div className={productFrame}>
            <LpDemoAiGateway />
          </div>
          <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {enterpriseControls.map((fact) => (
              <Fact key={fact.title} fact={fact} />
            ))}
          </div>
        </section>

        <section aria-labelledby="shadow-ai-heading" className={section}>
          <LpSectionHeader
            id="shadow-ai-heading"
            label="The shadow AI problem"
            heading="The work is already happening. Give it an approved path."
            headingLines={["The work is already happening.", "Give it an approved path."]}
            right={<LpArrowLink href="/shadow-ai">Understand shadow AI</LpArrowLink>}
          />
          <div className="mt-10 grid gap-10 md:grid-cols-2">
            <div>
              <h3 className="flex h-10 items-center border-b border-[var(--lp-ink)] text-sm font-medium text-[var(--lp-muted)]">Without an approved path</h3>
              <ul>
                {enterpriseShadowAi.without.map((item) => (
                  <li key={item} className="flex min-h-[48px] items-center border-b border-[var(--lp-border)] py-2 text-[15px] text-[var(--lp-body)]">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="flex h-10 items-center border-b border-[var(--lp-ink)] text-sm font-medium text-[var(--lp-ink)]">With OpenWork</h3>
              <ul>
                {enterpriseShadowAi.with.map((item) => (
                  <li key={item} className="flex min-h-[48px] items-center gap-3 border-b border-[var(--lp-border)] py-2 text-[15px] text-[var(--lp-ink)]">
                    <Check size={14} strokeWidth={2.6} className="shrink-0 text-[#047857]" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-6 max-w-[720px] text-[13px] leading-6 text-[var(--lp-muted)]">{enterpriseShadowAi.boundary}</p>
        </section>

        <section aria-labelledby="agents-heading" className={section}>
          <LpSectionHeader
            id="agents-heading"
            label="Agent choice, with clear boundaries"
            heading="Keep the tools. Know what’s connected."
            headingLines={["Keep the tools.", "Know what’s connected."]}
            right={<LpArrowLink href="/connect">Explore the MCP gateway</LpArrowLink>}
          />
          <div className="mt-10 border-b border-[var(--lp-border)]">
            <div className="hidden h-10 grid-cols-[minmax(0,1fr)_220px_220px] items-center border-b border-[var(--lp-ink)] text-sm text-[var(--lp-muted)] md:grid" aria-hidden="true">
              <span>Agent</span>
              <span>Shared skills and connections</span>
              <span>AI gateway models</span>
            </div>
            <ul aria-label="What each agent gets from OpenWork">
              {enterpriseAgents.map((agent, index) => (
                <li
                  key={agent.id}
                  className={`grid gap-3 py-4 md:min-h-[68px] md:grid-cols-[minmax(0,1fr)_220px_220px] md:items-center md:gap-0 md:py-3 ${index === 0 ? "border-t border-[var(--lp-ink)] md:border-t-0" : "border-t border-[var(--lp-border)]"}`}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex w-[22px] shrink-0 justify-center">{agentMarks[agent.id]}</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[15px] font-medium text-[var(--lp-ink)]">{agent.name}</span>
                      <span className="text-[13px] text-[var(--lp-muted)]">{agent.via}</span>
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-3 pl-8 md:justify-start md:pl-0">
                    <span className="text-[13px] text-[var(--lp-muted)] md:sr-only">Shared skills and connections</span>
                    <Access access={agent.skills} />
                  </span>
                  <span className="flex items-center justify-between gap-3 pl-8 md:justify-start md:pl-0">
                    <span className="text-[13px] text-[var(--lp-muted)] md:sr-only">AI gateway models</span>
                    <Access access={agent.models} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-6 max-w-[720px] text-[13px] leading-6 text-[var(--lp-muted)]">{enterpriseAgentsNote}</p>
        </section>

        <section aria-labelledby="data-heading" className={section}>
          <LpSectionHeader
            id="data-heading"
            label="A boundary you can explain"
            heading="Local files. A clear data boundary."
            headingLines={["Local files.", "A clear data boundary."]}
            right={<LpArrowLink href="/privacy">Read the privacy policy</LpArrowLink>}
          />
          <div className="mt-10 flex flex-col items-stretch gap-4 rounded-[20px] bg-[var(--lp-tonal)] p-5 md:p-8 lg:flex-row lg:items-center lg:gap-0">
            <BoundaryCard
              title="Employee’s computer"
              state={
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-hidden="true" />
                  Stays here
                </>
              }
              rows={[
                { icon: <Folder size={16} strokeWidth={1.5} />, label: enterpriseDataPath.local[0] },
                { icon: <Laptop size={16} strokeWidth={1.5} />, label: enterpriseDataPath.local[1] }
              ]}
            />
            <div className="flex items-center justify-center lg:flex-1" aria-hidden="true">
              <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
              <span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-[var(--lp-ink)] shadow-[0_0_0_1px_rgba(1,22,39,0.1)]">
                AI gateway
              </span>
              <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
            </div>
            <BoundaryCard
              title={
                <>
                  <BrandLogo name="aws" className="h-[18px] w-[18px] text-[#232F3E]" />
                  AWS Bedrock
                </>
              }
              state="Or another approved provider"
              rows={[
                { icon: <MessageSquare size={16} strokeWidth={1.5} />, label: enterpriseDataPath.provider[0] },
                { icon: <Paperclip size={16} strokeWidth={1.5} />, label: enterpriseDataPath.provider[1] }
              ]}
            />
          </div>
          <div className="mt-8 grid gap-8 md:grid-cols-3">
            {enterpriseDataBoundary.map((fact) => (
              <Fact key={fact.title} fact={fact} />
            ))}
          </div>
        </section>

        <CoworkComparison
          id="comparison-heading"
          anchor="comparison"
          label="OpenWork vs Claude Cowork"
          heading="Control, without the lock-in."
          groups={["Control and deployment"]}
          right={<LpArrowLink href="/alternatives/claude-cowork">Compare all {capabilityRows.length} capabilities</LpArrowLink>}
          className={`${section} block`}
        />

        <section aria-labelledby="deployment-heading" className={section}>
          <LpSectionHeader
            id="deployment-heading"
            label="Deployment, on your terms"
            heading="Start on the laptop. Choose the control plane."
            headingLines={["Start on the laptop.", "Choose the control plane."]}
          />
          <div className="mt-10 grid border-y border-[var(--lp-border)] md:grid-cols-3">
            {enterpriseDeployments.map((deployment, index) => (
              <div
                key={deployment.title}
                className={`flex flex-col py-7 ${index === 0 ? "md:pr-8" : "border-t border-[var(--lp-border)] md:border-l md:border-t-0 md:px-8"}`}
              >
                <span className="text-sm text-[var(--lp-body)]">{deployment.label}</span>
                <h3 className="mt-1.5 text-[24px] font-medium leading-[30px] tracking-[-0.03em]">{deployment.title}</h3>
                <p className="mt-3 flex-1 text-sm leading-[22px] text-[var(--lp-body)]">{deployment.detail}</p>
                <div className="mt-6">
                  <LpArrowLink href={deployment.href}>{deployment.link}</LpArrowLink>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="enterprise-faq-heading" className={`${section} grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] md:gap-20`}>
          <div className="flex flex-col items-start">
            <h2 id="enterprise-faq-heading" className="text-[36px] font-light leading-[42px] tracking-[-0.015em]">
              Before you roll out.
            </h2>
            <div className="mt-8 flex flex-col gap-3">
              <LpArrowLink href={TRUST_CENTER_URL} external>
                Visit the Trust Center
              </LpArrowLink>
              <LpArrowLink href="/ai-governance">Read the AI governance guide</LpArrowLink>
              <LpArrowLink href="https://github.com/different-ai/openwork" external>
                Inspect the source
              </LpArrowLink>
            </div>
          </div>
          <div className="border-b border-[var(--lp-border)]">
            {enterpriseFaq.map((entry) => (
              <details key={entry.question} className="group border-t border-[var(--lp-border)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-base font-medium [&::-webkit-details-marker]:hidden">
                  {entry.question}
                  <ChevronRight
                    aria-hidden="true"
                    size={18}
                    strokeWidth={1.5}
                    className="shrink-0 text-[var(--lp-muted)] transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
                  />
                </summary>
                <p className="max-w-[640px] pb-6 pr-8 text-[15px] leading-7 text-[var(--lp-body)]">{entry.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="contact-heading" className={section}>
          <div className="grid gap-10 rounded-[24px] bg-[var(--lp-tonal)] px-5 py-8 md:px-10 md:py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16 lg:p-14">
            <div className="flex flex-col">
              <div className="text-[15px] text-[var(--lp-muted)]">A practical evaluation</div>
              <h2
                id="contact-heading"
                className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[40px] md:leading-[48px]"
              >
                <span className="block">Bring IT.</span>
                <span className="block">Bring a real workflow.</span>
              </h2>
              <ol className="mt-8 flex flex-col">
                {enterpriseRollout.map((step, index) => (
                  <li key={step.title} className="flex gap-4 border-t border-[#D9E1EA] py-5">
                    <span className="mono w-5 shrink-0 pt-px text-[13px] text-[var(--lp-muted)]">0{index + 1}</span>
                    <span className="flex flex-col gap-1.5">
                      <span className="text-base font-medium tracking-[-0.01em]">{step.title}</span>
                      <span className="text-sm leading-[22px] text-[var(--lp-body)]">{step.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="border-t border-[#D9E1EA] pt-5 text-[13px] leading-6 text-[var(--lp-muted)]">{enterpriseRolloutNote}</p>
              {calExternal ? (
                <a href={calHref} {...calProps} className="lp-pill-primary mt-8 self-start">
                  Book a demo
                </a>
              ) : null}
            </div>
            <div>
              <BookCallForm />
            </div>
          </div>
        </section>

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
