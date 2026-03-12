"use client";

import { LandingBackground } from "./landing-background";
import { DenCapabilityCarousel } from "./den-capability-carousel";
import { DenComparisonAnimation } from "./den-comparison-animation";
import { DenHero } from "./den-hero";
import { DenHowItWorks } from "./den-how-it-works";
import { DenSupportGrid } from "./den-support-grid";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  getStartedHref: string;
};

const useCaseCards = [
  {
    label: "OPS",
    title: "Invoice tracking, doc generation",
    body: "Watches incoming invoices, flags issues, delivers a morning summary to Slack.",
    detail: "~2 hrs/week back",
    accent: "from-[#ffb570] via-[#ff9e43] to-[#f97316]",
  },
  {
    label: "CODE",
    title: "PR review, issue triage",
    body: "Checks PRs against your style guide. Sorts issues by severity. Drafts first responses.",
    detail: "Runs on every push",
    accent: "from-[#6e87ff] via-[#4f6dff] to-[#1b29ff]",
  },
  {
    label: "CONTENT",
    title: "Social drafts, follow-up emails",
    body: "Writes drafts from your changelog or CRM data. You approve before anything goes out.",
    detail: "You approve, it sends",
    accent: "from-[#67d9d1] via-[#3fcfc3] to-[#0f9f9a]",
  },
];

export function LandingDen(props: Props) {
  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            downloadHref={props.downloadHref}
            active="den"
          />
        </div>

        <div className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <DenHero stars={props.stars} getStartedHref={props.getStartedHref} />

          <section className="grid gap-5 md:grid-cols-3">
            {useCaseCards.map(card => (
              <article
                key={card.label}
                className="feature-card flex h-full flex-col rounded-[2rem] p-6 md:p-7"
              >
                <div
                  className={`mb-5 h-3.5 w-3.5 rounded-full bg-gradient-to-br ${card.accent}`}
                />
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                  {card.label}
                </div>
                <h3 className="mb-3 text-[1.7rem] font-medium leading-[1.12] tracking-tight text-[#011627]">
                  {card.title}
                </h3>
                <p className="flex-1 text-[15px] leading-7 text-gray-600">
                  {card.body}
                </p>
                <div className="mono mt-6 text-[13px] text-gray-500">
                  {card.detail}
                </div>
              </article>
            ))}
          </section>

          <DenCapabilityCarousel />

          <DenHowItWorks />

          <DenSupportGrid />

          <section>
            <div className="landing-shell rounded-[2rem] p-7 md:p-8">
              <div className="grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
                <div>
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                    Pricing
                  </div>
                  <p className="text-[1.95rem] font-medium leading-[1.1] tracking-tight text-[#011627]">
                    $50/month per worker.
                  </p>
                </div>

                <p className="max-w-2xl text-[16px] leading-8 text-gray-600">
                  Your team&apos;s repetitive tasks cost $2,000–4,000/mo in engineer
                  time. A Den worker costs $50 and doesn&apos;t get bored by Thursday.
                </p>

                <div className="flex flex-col items-start gap-3 lg:items-end">
                  <a
                    href={props.getStartedHref}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-button"
                  >
                    Deploy your first worker
                  </a>
                  <div className="text-sm text-gray-500">No credit card to start</div>
                </div>
              </div>
            </div>
          </section>

          <section className="landing-shell rounded-[2rem] p-7 md:p-8">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
              Why Den feels different
            </div>
            <h3 className="mb-4 max-w-2xl text-[2rem] font-medium leading-tight tracking-tight text-[#011627]">
              The gap is not model quality. It&apos;s whether the work can keep moving without you.
            </h3>
            <p className="mb-8 max-w-3xl text-[16px] leading-8 text-gray-600">
              Local chat tools are great when you want to stay in the loop. Den is for
              the work that should keep moving after you close the tab. This animation
              makes that tradeoff explicit without adding more copy.
            </p>
            <DenComparisonAnimation />
          </section>

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
