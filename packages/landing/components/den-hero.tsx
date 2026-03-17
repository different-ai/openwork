"use client";

import { Star } from "lucide-react";
import { DenActivityPanel } from "./den-activity-panel";
import { SlackGlyph, TelegramGlyph } from "./den-icons";



type DenHeroProps = {
  stars: string;
  getStartedHref: string;
};

export function DenHero(props: DenHeroProps) {
  const getStartedExternal = /^https?:\/\//.test(props.getStartedHref);

  return (
    <section className="grid gap-8 pt-8 md:pt-14 lg:grid-cols-[minmax(0,1.28fr)_minmax(320px,0.72fr)] lg:items-center">
      <div className="max-w-[42rem]">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-gray-500">
          OpenWork hosted
        </div>
        <h2 className="max-w-[12.4ch] text-3xl font-medium tracking-tight text-gray-900 md:max-w-[12.1ch] md:text-[3.2rem] md:leading-[0.98] lg:max-w-none lg:text-[3.35rem] xl:text-[3.7rem]">
          <span className="block lg:whitespace-nowrap">Always-on AI workers</span>
          <span className="block lg:whitespace-nowrap">for you and your team.</span>
        </h2>
        <p className="mt-5 max-w-[35rem] text-lg leading-relaxed text-gray-700 md:text-[1rem] md:leading-8 lg:text-[1.02rem]">
          Define a task, deploy a worker, check results from{" "}
          <span className="whitespace-nowrap">
            <SlackGlyph className="mr-1 inline-block align-[-0.15em]" />
            Slack
          </span>{" "}
          or{" "}
          <span className="whitespace-nowrap">
            <TelegramGlyph className="mr-1 inline-block align-[-0.15em]" />
            Telegram
          </span>
          . Den handles the repetitive work so your team can focus on what they&apos;re best at.
        </p>

        <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          <a
            href={props.getStartedHref}
            className="doc-button min-w-[290px] justify-center px-8 text-[1.08rem] font-semibold"
            rel={getStartedExternal ? "noreferrer" : undefined}
            target={getStartedExternal ? "_blank" : undefined}
          >
            Get started
          </a>
          <div className="flex flex-col text-[0.98rem] text-gray-500 sm:max-w-[14rem]">
            <span className="font-semibold text-gray-700">$50/mo per worker</span>
            <span>Free for a limited time</span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2.5">


          <span className="landing-chip inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium text-gray-700">
            Open source
          </span>

          <span className="landing-chip inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium text-gray-700">
            50+ Integrations and LLMs
          </span>

          <a
            href="https://github.com/different-ai/openwork"
            target="_blank"
            rel="noreferrer"
            className="group flex flex-row items-stretch overflow-hidden rounded-[6px] border border-[#d0d7de] text-[13px] font-medium text-[#24292f] shadow-[0_1px_0_rgba(27,31,36,0.04)] transition-all hover:border-gray-400"
          >
            <div className="flex items-center gap-1.5 bg-[#f6f8fa] px-3 py-1.5 transition-colors group-hover:bg-[#f3f4f6]">
              <Star size={15} strokeWidth={2} className="text-[#57606a]" />
              <span className="font-semibold">Star</span>
            </div>
            <div className="flex items-center border-l border-[#d0d7de] bg-white px-3 py-1.5 font-semibold transition-colors group-hover:text-[#0969da]">
              {props.stars || "11.5k"}
            </div>
          </a>




          <div className="mr-2 flex items-center gap-2 opacity-80">
            <span className="text-[13px] font-medium text-gray-500">Backed by</span>
            <div className="flex items-center gap-1.5">
              <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] font-bold leading-none text-white">
                Y
              </div>
              <span className="text-[13px] font-semibold tracking-tight text-gray-600">
                Combinator
              </span>
            </div>
          </div>
        </div>
      </div>

      <DenActivityPanel />
    </section>
  );
}
