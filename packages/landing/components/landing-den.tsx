"use client";

import { LandingBackground } from "./landing-background";
import { DenCapabilityCarousel } from "./den-capability-carousel";
import { DenHero } from "./den-hero";
import { DenHowItWorks } from "./den-how-it-works";
import { DenSupportGrid } from "./den-support-grid";
import { DenValueSection } from "./den-value-section";
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
          <DenCapabilityCarousel />
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

          

          <DenHowItWorks />

          <DenSupportGrid />

          <DenValueSection getStartedHref={props.getStartedHref} />

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
