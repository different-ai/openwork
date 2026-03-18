"use client";

import { CheckCircle2 } from "lucide-react";

type DenValueSectionProps = {
  getStartedHref: string;
};

export function DenValueSection(props: DenValueSectionProps) {
  const hireHumanSubject =
    "Please come automate this {TASK} at {LOCATION} - SF for {BUDGET}";
  const hireHumanBody = `Hey Ben,

I want to automate this {TASK} because {REASON}. I don't trust AI to do this because of the following {AI_CONCERN}. I'm willing to pay you {BUDGET} for {HOURS} of your time.

Best`;
  const hireHumanHref = `mailto:ben@openwork.software?subject=${encodeURIComponent(hireHumanSubject)}&body=${encodeURIComponent(hireHumanBody)}`;
  const getStartedExternal = /^https?:\/\//.test(props.getStartedHref);

  return (
    <section className="landing-shell rounded-[2.1rem] bg-[radial-gradient(circle_at_top_right,rgba(15,23,42,0.08),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.94),rgba(244,246,248,0.98))] p-6 md:p-9">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.62fr)_minmax(0,1.38fr)] xl:items-start">
        <div className="max-w-[28rem]">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
            Pricing
          </div>
          <p className="text-[2.15rem] font-medium leading-[1.02] tracking-tight text-[#011627] md:text-[2.8rem]">
            Replace repetitive work with a $50 worker.
          </p>
          <p className="mt-4 text-[16px] leading-7 text-[#5f6b7a]">
            Den is priced like a utility, not a headcount bet. Keep your team on
            the critical decisions and let the worker own the repetitive queue.
          </p>
        </div>

        <div className="rounded-[2rem] border border-[#d9dee5] bg-[rgba(255,255,255,0.94)] p-4 shadow-[0_24px_70px_-28px_rgba(15,23,42,0.16)] md:p-5">
          <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
            <article className="flex h-full flex-col rounded-[1.6rem] border border-[#dbe1e8] bg-[linear-gradient(180deg,#ffffff,#f6f7f9)] px-4 py-4 shadow-[0_10px_26px_-22px_rgba(15,23,42,0.18)] md:px-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#64748b] sm:whitespace-nowrap">
                  Human repetitive work
                </div>
                <div className="invisible hidden items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ring-1 ring-transparent md:inline-flex">
                  <CheckCircle2 size={12} strokeWidth={2.4} />
                  Recommended
                </div>
              </div>
              <div className="mt-3">
                <div className="whitespace-nowrap text-[1.95rem] font-medium leading-[0.95] tracking-tight text-[#0f172a] md:text-[2.15rem]">
                  $2k-4k/mo
                </div>
              </div>
              <div className="mt-4 space-y-3 text-[12px] leading-6 text-[#64748b] md:text-[13px]">
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#cbd5e1]" />
                  <span>Best when the work needs constant human judgment.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#cbd5e1]" />
                  <span>Expensive for follow-through and reminders.</span>
                </div>
              </div>

              <div className="mt-auto pt-5">
                <a
                  href={hireHumanHref}
                  className="secondary-button w-full border border-[#d6dbe2] px-4 text-center text-sm font-semibold text-[#1f2937] shadow-[0_12px_24px_-22px_rgba(15,23,42,0.32)] transition hover:border-[#c8d0da] hover:bg-[#f5f6f8]"
                >
                  Hire a human automator
                </a>
                <p className="mt-2 text-center text-[11px] font-medium text-[#64748b]">
                  Limited offer to SF teams
                </p>
              </div>
            </article>

            <article className="relative flex h-full flex-col rounded-[1.6rem] border border-[#c4cbd5] bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.08),transparent_45%),linear-gradient(180deg,#fbfbfc,#eef1f4)] px-4 py-4 shadow-[0_20px_44px_-28px_rgba(15,23,42,0.28)] ring-1 ring-[#0f172a]/5 md:px-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#111827] sm:whitespace-nowrap">
                  Den worker
                </div>
                <div className="inline-flex items-center gap-1 rounded-full bg-[#111827] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_10px_24px_-18px_rgba(15,23,42,0.5)]">
                  <CheckCircle2 size={12} strokeWidth={2.4} />
                  Recommended
                </div>
              </div>
              <div className="mt-3">
                <div className="text-[2rem] font-medium leading-[0.95] tracking-tight text-[#0f172a] md:text-[2.15rem]">
                  $50/mo
                </div>
              </div>
              <div className="mt-4 space-y-3 text-[12px] leading-6 text-[#42526a] md:text-[13px]">
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#111827]" />
                  <span>Handles repetitive work continuously instead of in bursts.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#111827]" />
                  <span>Keeps humans focused on approvals and exceptions.</span>
                </div>
              </div>

              <div className="mt-auto pt-5">
                <a
                  href={props.getStartedHref}
                  className="doc-button w-full px-4 text-sm font-semibold"
                  rel={getStartedExternal ? "noreferrer" : undefined}
                  target={getStartedExternal ? "_blank" : undefined}
                >
                  Deploy your first worker
                </a>
                <p className="mt-2 text-center text-[11px] font-medium text-[#5f6b7a]">
                  Same setup. Lower cost.
                </p>
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
