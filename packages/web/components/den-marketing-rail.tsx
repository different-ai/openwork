type DenMarketingRailProps = {
  compact?: boolean;
};

const useCaseCards = [
  {
    label: "OPS",
    title: "Invoice tracking, doc generation",
    body: "Watches incoming invoices, flags issues, and delivers a morning summary to Slack.",
    detail: "~2 hrs/week back",
    accent: "from-[#ffb570] via-[#ff9e43] to-[#f97316]"
  },
  {
    label: "CODE",
    title: "PR review, issue triage",
    body: "Checks PRs against your style guide, sorts issues by severity, and drafts first responses.",
    detail: "Runs on every push",
    accent: "from-[#6e87ff] via-[#4f6dff] to-[#1b29ff]"
  },
  {
    label: "CONTENT",
    title: "Social drafts, follow-up emails",
    body: "Writes drafts from your changelog or CRM data. You approve before anything goes out.",
    detail: "You approve, it sends",
    accent: "from-[#67d9d1] via-[#3fcfc3] to-[#0f9f9a]"
  }
];

const activityEntries = [
  { time: "9:41 AM", source: "GitHub", tone: "bg-[#22c55e]", lines: ["Reviewed PR #247, approved"] },
  { time: "10:12 AM", source: "Slack", tone: "bg-[#f59e0b]", lines: ["Flagged invoice #1092", "Duplicate detected"] },
  { time: "1:30 PM", source: "Linear", tone: "bg-[#ef4444]", lines: ["Triaged 8 issues", "2 critical"] },
  { time: "3:15 PM", source: "Slack", tone: "bg-[#22c55e]", lines: ["Weekly digest sent", "to #ops"] }
];

function ActivityPanel() {
  return (
    <div className="overflow-hidden rounded-[2rem] border border-white/70 bg-[#151718] shadow-[0_26px_70px_-36px_rgba(15,23,42,0.55)]">
      <div className="relative flex items-center border-b border-white/10 bg-[#1d1f21] px-4 py-3">
        <div className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
          ops-worker-01
        </div>
      </div>

      <div className="space-y-4 px-4 py-4 text-white">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#9aa3af]">
          <span className="h-2.5 w-2.5 rounded-full bg-[#3ddc97] shadow-[0_0_0_6px_rgba(61,220,151,0.12)]" />
          Running
        </div>

        <div className="relative space-y-3 pl-8 before:absolute before:bottom-2 before:left-[9px] before:top-1 before:w-px before:bg-white/10 before:content-['']">
          {activityEntries.map((entry) => (
            <div key={`${entry.time}-${entry.source}`} className="relative rounded-[1.1rem] border border-white/8 bg-white/6 px-3 py-3 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.75)]">
              <span className={`absolute -left-8 top-[0.3rem] h-2.5 w-2.5 rounded-full ${entry.tone}`} />
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-400">{entry.time}</span>
                <span className="rounded-full border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                  {entry.source}
                </span>
              </div>
              <div className="space-y-0.5 text-[13px] leading-6 text-slate-100">
                {entry.lines.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PricingCards() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <article className="flex h-full flex-col rounded-[1.6rem] border border-[#dbe1e8] bg-[linear-gradient(180deg,#ffffff,#f6f7f9)] px-4 py-4 shadow-[0_10px_26px_-22px_rgba(15,23,42,0.18)]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#64748b]">Human repetitive work</div>
        <div className="mt-3 text-[1.95rem] font-medium leading-[0.95] tracking-tight text-[#0f172a]">$2k-4k/mo</div>
        <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#64748b]">
          <div>Best when the work needs constant human judgment.</div>
          <div>Expensive for follow-through and reminders.</div>
        </div>
      </article>

      <article className="flex h-full flex-col rounded-[1.6rem] border border-[#c4cbd5] bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.08),transparent_45%),linear-gradient(180deg,#fbfbfc,#eef1f4)] px-4 py-4 shadow-[0_20px_44px_-28px_rgba(15,23,42,0.28)] ring-1 ring-[#0f172a]/5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#111827]">Den worker</div>
          <div className="inline-flex items-center rounded-full bg-[#111827] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
            Recommended
          </div>
        </div>
        <div className="mt-3 text-[2rem] font-medium leading-[0.95] tracking-tight text-[#0f172a]">$50/mo</div>
        <div className="mt-4 space-y-3 text-[13px] leading-6 text-[#42526a]">
          <div>Handles repetitive work continuously instead of in bursts.</div>
          <div>Keeps humans focused on approvals and exceptions.</div>
        </div>
      </article>
    </div>
  );
}

export function DenMarketingRail({ compact = false }: DenMarketingRailProps) {
  return (
    <div className="grid gap-6 text-[#011627]">
      <div className="grid gap-5">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
          OpenWork hosted
        </div>
        <div className="grid gap-4">
          <h1 className="max-w-[12ch] text-[2.7rem] font-medium leading-[0.95] tracking-[-0.055em] text-[#011627] md:text-[3.5rem]">
            Always-on AI workers for you and your team.
          </h1>
          <p className="max-w-[38rem] text-[16px] leading-8 text-slate-600">
            Define a task, deploy a worker, and check results from Slack or Telegram. Den handles the repetitive work so your team can stay focused on approvals and exceptions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-[13px] font-medium text-slate-700">
          <span className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 shadow-[0_10px_20px_-18px_rgba(15,23,42,0.32)]">Open source</span>
          <span className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 shadow-[0_10px_20px_-18px_rgba(15,23,42,0.32)]">50+ integrations and LLMs</span>
          <span className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 shadow-[0_10px_20px_-18px_rgba(15,23,42,0.32)]">Free first worker</span>
          <span className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 shadow-[0_10px_20px_-18px_rgba(15,23,42,0.32)]">Polar billing for scaling</span>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(300px,0.92fr)] xl:items-start">
        <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
          {useCaseCards.slice(0, compact ? 2 : useCaseCards.length).map((card) => (
            <article key={card.label} className="rounded-[1.7rem] border border-slate-200/80 bg-white/88 p-5 shadow-[0_24px_60px_-42px_rgba(15,23,42,0.35)] backdrop-blur">
              <div className={`mb-4 h-3.5 w-3.5 rounded-full bg-gradient-to-br ${card.accent}`} />
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{card.label}</div>
              <h2 className="text-[1.35rem] font-medium leading-[1.08] tracking-[-0.035em] text-[#011627]">{card.title}</h2>
              <p className="mt-3 text-[14px] leading-7 text-slate-600">{card.body}</p>
              <div className="mt-5 font-mono text-[12px] text-slate-500">{card.detail}</div>
            </article>
          ))}
        </div>

        <ActivityPanel />
      </div>

      {!compact ? (
        <section className="grid gap-4 rounded-[2rem] border border-slate-200/80 bg-[radial-gradient(circle_at_top_right,rgba(15,23,42,0.08),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.94),rgba(244,246,248,0.98))] p-5 shadow-[0_28px_70px_-48px_rgba(15,23,42,0.28)]">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Pricing</div>
            <p className="mt-3 max-w-[28rem] text-[2rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#011627]">
              Replace repetitive work with a $50 worker.
            </p>
            <p className="mt-3 max-w-[38rem] text-[15px] leading-7 text-slate-600">
              Start free, then use Den Cloud billing when you need more capacity. The app handles checkout return flows and billing management without sending people back to marketing pages.
            </p>
          </div>
          <PricingCards />
        </section>
      ) : null}
    </div>
  );
}
