"use client";

import { DenComparisonAnimation } from "./den-comparison-animation";

type DenValueSectionProps = {
  getStartedHref: string;
};

const costCards = [
  {
    label: "Human repetitive work",
    value: "$2,000–4,000/mo",
    detail: "Salary cost, queue handoffs, and follow-up overhead.",
    accent:
      "border-[#f3d7da] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(255,245,246,0.98))] text-slate-600",
  },
  {
    label: "Den worker",
    value: "$50/mo",
    detail: "Always-on execution with reporting and guardrails built in.",
    accent:
      "border-[#1b29ff]/15 bg-[linear-gradient(180deg,rgba(250,252,255,0.96),rgba(238,244,255,0.96))] text-[#011627]",
  },
];

const valuePoints = [
  "Priced for queue work, not just pilots",
  "Keeps follow-up moving without another handoff",
  "Reports back in Slack or Telegram",
];

const comparisonRows = [
  {
    label: "What happens all day",
    human: "Context switching, triage, reminders, and cleanup.",
    den: "Executes the queue, follows instructions, and reports back.",
  },
  {
    label: "How work gets dropped",
    human: "It waits behind meetings, priorities, and handoffs.",
    den: "It stays on until the task is done or escalated.",
  },
  {
    label: "Best use of human time",
    human: "Burned on repetitive follow-up and status checks.",
    den: "Reserved for judgment, review, and decisions.",
  },
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
            Replace repetitive work with a $50 worker.
          </p>
          <p className="mt-4 text-[16px] leading-7 text-gray-600">
            Den is cheap enough to own the repetitive queue. Your team stays on review
            and decisions while the worker handles the follow-through.
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
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4656ff]">
                Human vs worker
              </div>
              <p className="mt-2 text-[15px] leading-6 text-gray-600">
                The real comparison is not software vs software. It is repetitive human
                labor vs an always-on Den worker.
              </p>
            </div>

            <div className="rounded-full border border-[#1b29ff]/15 bg-[rgba(27,41,255,0.06)] px-4 py-2 text-center shadow-[0_18px_40px_-30px_rgba(27,41,255,0.28)]">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4656ff]">
                Cost delta
              </div>
              <div className="mt-1 text-[1.1rem] font-semibold leading-none tracking-tight text-[#011627]">
                40-80x less
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
            <div
              className={`rounded-[1.35rem] border px-5 py-5 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.18)] ${costCards[0].accent}`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#a15460]">
                {costCards[0].label}
              </div>
              <div className="mt-2 text-[1.95rem] font-medium leading-none tracking-tight text-[#011627]">
                {costCards[0].value}
              </div>
              <div className="mt-3 text-[14px] leading-6 text-gray-500">
                {costCards[0].detail}
              </div>
            </div>

            <div
              className={`rounded-[1.35rem] border px-5 py-5 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.18)] ${costCards[1].accent} ring-1 ring-[#1b29ff]/8`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4656ff]">
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

          <div className="mt-4 rounded-[1.35rem] border border-slate-200/85 bg-white/70 p-4 md:p-5">
            <div className="grid gap-3">
              {comparisonRows.map(row => (
                <div
                  key={row.label}
                  className="grid gap-3 rounded-[1.15rem] border border-slate-200/80 bg-white/80 p-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-start"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                    {row.label}
                  </div>
                  <div className="text-[14px] leading-6 text-gray-600">{row.human}</div>
                  <div className="text-[14px] leading-6 text-[#011627]">{row.den}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-slate-200/85 pt-5 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl text-[15px] leading-7 text-gray-600">
              Den does not replace judgment. It replaces the repetitive execution layer
              that slows humans down and makes routine follow-up too expensive to scale.
            </p>

            <div className="flex flex-col items-start gap-3 md:items-end">
              <a
                href={props.getStartedHref}
                target="_blank"
                rel="noreferrer"
                className="doc-button min-w-[270px] justify-center"
              >
                Start with one worker
              </a>
              <div className="text-sm text-gray-500">
                See how much queue work one worker can absorb
              </div>
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
