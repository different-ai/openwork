"use client";

import { DenComparisonAnimation } from "./den-comparison-animation";

type DenValueSectionProps = {
  getStartedHref: string;
};

const costCards = [
  {
    label: "Typical repetitive work",
    value: "$2,000–4,000/mo",
    detail: "Engineer time, handoffs, and follow-up.",
    accent: "border-slate-200/80 bg-white/85 text-slate-600",
  },
  {
    label: "Den worker",
    value: "$50/mo",
    detail: "Always-on, sandboxed, and accountable.",
    accent:
      "border-[#1b29ff]/15 bg-[linear-gradient(180deg,rgba(250,252,255,0.96),rgba(238,244,255,0.96))] text-[#011627]",
  },
];

const valuePoints = [
  "Follows through without another handoff",
  "Reports back in Slack or Telegram",
  "Cheap enough to deploy beyond a single experiment",
];

export function DenValueSection(props: DenValueSectionProps) {
  return (
    <section className="landing-shell rounded-[2rem] bg-[radial-gradient(circle_at_top_right,rgba(27,41,255,0.07),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.92),rgba(247,250,253,0.96))] p-7 md:p-8">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] xl:items-start">
        <div className="max-w-[25rem]">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
            Pricing
          </div>
          <p className="text-[2.35rem] font-medium leading-[1.02] tracking-tight text-[#011627] md:text-[2.7rem]">
            $50/month per worker.
          </p>
          <p className="mt-4 text-[16px] leading-7 text-gray-600">
            Low enough to deploy on real queue work, not just a demo. That is why
            Den starts to look like a bargain quickly.
          </p>

          <div className="mt-6 flex flex-wrap gap-2.5">
            {valuePoints.map(point => (
              <div
                key={point}
                className="rounded-full border border-slate-200/80 bg-white/80 px-3.5 py-2 text-[12px] font-medium text-slate-600 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.2)]"
              >
                {point}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[1.75rem] border border-slate-200/85 bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(245,248,252,0.96))] p-5 shadow-[0_28px_60px_-42px_rgba(15,23,42,0.22)] md:p-6">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch">
            <div
              className={`rounded-[1.35rem] border px-5 py-5 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.18)] ${costCards[0].accent}`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                {costCards[0].label}
              </div>
              <div className="mt-2 text-[1.95rem] font-medium leading-none tracking-tight text-[#011627]">
                {costCards[0].value}
              </div>
              <div className="mt-3 text-[14px] leading-6 text-gray-500">
                {costCards[0].detail}
              </div>
            </div>

            <div className="flex items-center justify-center">
              <div className="rounded-full border border-[#1b29ff]/15 bg-[rgba(27,41,255,0.06)] px-4 py-2 text-center shadow-[0_18px_40px_-30px_rgba(27,41,255,0.28)]">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4656ff]">
                  Cost delta
                </div>
                <div className="mt-1 text-[1.1rem] font-semibold leading-none tracking-tight text-[#011627]">
                  40-80x less
                </div>
              </div>
            </div>

            <div
              className={`rounded-[1.35rem] border px-5 py-5 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.18)] ${costCards[1].accent}`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                {costCards[1].label}
              </div>
              <div className="mt-2 text-[1.95rem] font-medium leading-none tracking-tight">
                {costCards[1].value}
              </div>
              <div className="mt-3 text-[14px] leading-6 text-gray-500">
                {costCards[1].detail}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-slate-200/85 pt-5 md:flex-row md:items-end md:justify-between">
            <p className="max-w-2xl text-[15px] leading-7 text-gray-600">
              The savings come from continuity, not corner-cutting. Den keeps the queue
              moving when a human would otherwise context-switch, defer, or drop the
              follow-up.
            </p>

            <div className="flex flex-col items-start gap-3 md:items-end">
              <a
                href={props.getStartedHref}
                target="_blank"
                rel="noreferrer"
                className="doc-button min-w-[270px] justify-center"
              >
                Deploy your first worker
              </a>
              <div className="text-sm text-gray-500">No credit card to start</div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-[1.75rem] border border-slate-200/80 bg-white/72 p-5 shadow-[0_24px_50px_-42px_rgba(15,23,42,0.18)] md:p-6">
        <div className="mb-6 max-w-3xl">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
            In practice
          </div>
          <h3 className="mb-4 text-[2rem] font-medium leading-tight tracking-tight text-[#011627]">
            The value shows up after you close the tab.
          </h3>
          <p className="text-[16px] leading-8 text-gray-600">
            Human follow-up stalls between approvals. Den keeps moving through the queue
            and reports back when the work is ready for review.
          </p>
        </div>

        <DenComparisonAnimation />
      </div>
    </section>
  );
}
