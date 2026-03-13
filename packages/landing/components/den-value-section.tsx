"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";

type DenValueSectionProps = {
  getStartedHref: string;
};

export function DenValueSection(props: DenValueSectionProps) {
  return (
    <section className="landing-shell rounded-[2.1rem] bg-[radial-gradient(circle_at_top_right,rgba(27,41,255,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.98))] p-7 md:p-9">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.62fr)_minmax(0,1.38fr)] xl:items-start">
        <div className="max-w-[28rem]">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
            Pricing
          </div>
          <p className="text-[2.35rem] font-medium leading-[1.02] tracking-tight text-[#011627] md:text-[2.8rem]">
            Replace repetitive work with a $50 worker.
          </p>
          <p className="mt-4 text-[16px] leading-7 text-[#5f6b7a]">
            Den is priced like a utility, not a headcount bet. Keep your team on
            the critical decisions and let the worker own the repetitive queue.
          </p>
        </div>

        <div className="rounded-[2rem] border border-[#dce2f4] bg-[rgba(255,255,255,0.94)] p-4 shadow-[0_24px_70px_-28px_rgba(15,23,42,0.18)] md:p-5">
          <div className="grid gap-3 md:grid-cols-2 md:items-stretch">
            <article className="flex h-full flex-col rounded-[1.5rem] border border-[#e2e8f0] bg-[linear-gradient(180deg,#ffffff,#f8fafc)] px-4 py-4 shadow-[0_10px_26px_-22px_rgba(15,23,42,0.22)] md:px-5">
              <div className="flex items-center justify-between gap-3">
                <div className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-[#64748b]">
                  Human repetitive work
                </div>
                <div className="invisible inline-flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ring-1 ring-transparent">
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
                  href="mailto:ben@openwork.software?subject=We%20want%20to%20hire%20you"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-[#cbd5e1] bg-white px-4 py-2 text-center text-sm font-semibold text-[#334155] shadow-[0_1px_2px_rgba(17,24,39,0.06)] transition hover:bg-[#f8fafc]"
                >
                  Hire a human automator
                </a>
                <p className="mt-2 text-center text-[11px] font-medium text-[#64748b]">
                  Limited offer to SF teams
                </p>
              </div>
            </article>

            <article className="relative flex h-full flex-col rounded-[1.5rem] border border-[#c7d2fe] bg-[linear-gradient(180deg,rgba(245,247,255,0.98),rgba(237,242,255,0.98))] px-4 py-4 shadow-[0_18px_40px_-28px_rgba(27,41,255,0.28)] ring-1 ring-[#1b29ff]/10 md:px-5">
              <div className="flex items-center justify-between gap-3">
                <div className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1b29ff]">
                  Den worker
                </div>
                <div className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#1b29ff] ring-1 ring-[#1b29ff]/10">
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
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#1b29ff]" />
                  <span>Handles repetitive work continuously instead of in bursts.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#1b29ff]" />
                  <span>Keeps humans focused on approvals and exceptions.</span>
                </div>
              </div>

              <div className="mt-auto pt-5">
                <a
                  href={props.getStartedHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-[#1b29ff]/25 bg-[linear-gradient(135deg,#1b29ff_0%,#2639ff_58%,#1a2bd0_100%)] px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(27,41,255,0.2)] transition hover:-translate-y-px"
                >
                  Start with one worker
                  <ArrowRight size={16} strokeWidth={2.3} />
                </a>
                <p className="mt-2 text-center text-[11px] font-medium text-[#64748b]">
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
