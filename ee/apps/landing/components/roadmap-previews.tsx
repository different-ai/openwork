import { AlertTriangle, Circle, CornerDownLeft, GitBranch, Play, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { GoogleMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";
import { OpenWorkMark } from "./openwork-mark";

/* Static previews for the roadmap. Each one shows what a product looks like
 * today, or, for "Coming soon" apps, what we are designing. Numbers and names
 * are sample data. */

const initialsClass =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#F3F4F6] text-[10px] font-semibold text-[#374151]";

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

type UsageRow = { mark: ReactNode; name: string; kind: string; share: number; people: string; uses: string; trend: string };

const USAGE: UsageRow[] = [
  { mark: <LinearMark className="h-4 w-4" />, name: "Linear", kind: "Connection", share: 88, people: "31 people", uses: "214 uses", trend: "+12%" },
  { mark: <SkillMark className="h-4 w-4" />, name: "Proposal writer", kind: "Skill", share: 45, people: "14 people", uses: "58 uses", trend: "+40%" },
  { mark: <GoogleMark className="h-4 w-4" />, name: "Google Calendar", kind: "Connection", share: 38, people: "12 people", uses: "96 uses", trend: "+3%" }
];

type AttentionRow = { failed: boolean; title: string; detail: string; action: string };

const ATTENTION: AttentionRow[] = [
  { failed: true, title: "Proposal writer failed 6 of 58 runs", detail: "Most failures: Salesforce sign-in expired for 3 people", action: "Review" },
  { failed: false, title: "Brand voice wasn’t used this month", detail: "Shared with Marketing, 9 people", action: "Review" },
  { failed: false, title: "5 people haven’t finished a task yet", detail: "Invited more than two weeks ago", action: "Remind" }
];

function Stat({ label, value, detail, up }: { label: string; value: string; detail: string; up?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-xl bg-white px-4 py-3.5 shadow-[0_0_0_1px_#EEF0F3]">
      <span className="text-xs text-[#6B7280]">{label}</span>
      <span className="text-[22px] font-semibold tracking-[-0.02em] text-[#0F172A]">{value}</span>
      <span className={`text-xs ${up ? "text-[#047857]" : "text-[#6B7280]"}`}>{detail}</span>
    </div>
  );
}

export function RoadmapInsightsPreview() {
  return (
    <div className="flex w-full flex-col bg-[#FAFAFA]">
      <div className="flex h-12 items-center border-b border-[#F3F4F6] bg-white px-6 text-[15px] font-medium text-[#0F172A]">Analytics</div>
      <div className="flex flex-col px-6 py-6 md:px-10">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#0F172A]">What’s working in Acme Studio</h3>
          <span className="flex h-8 items-center rounded-lg bg-white px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB]">Last 30 days</span>
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <Stat label="Tasks finished" value="1,284" detail="Up 18% from August" up />
          <Stat label="People using OpenWork" value="43 of 48" detail="5 haven’t started" />
          <Stat label="Spent on models" value="$1,284" detail="$0.99 per finished task" />
        </div>
        <div className="mt-7 flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-[#374151]">Most used</span>
          <span className="text-[#6B7280]">View all</span>
        </div>
        <ul className="mt-2">
          {USAGE.map((row) => (
            <li key={row.name} className="flex h-10 items-center gap-3 border-b border-[#F3F4F6] text-[13px]">
              <span className="flex w-4 shrink-0">{row.mark}</span>
              <span className="flex-1 text-[#111827]">{row.name}</span>
              <span className="hidden w-24 text-xs text-[#9CA3AF] sm:block">{row.kind}</span>
              <span className="hidden h-1 w-20 rounded-full bg-[#E5E7EB] sm:block">
                <span className="block h-1 rounded-full bg-[#111827]" style={{ width: `${row.share}%` }} />
              </span>
              <span className="w-20 text-right font-medium text-[#111827]">{row.people}</span>
              <span className="hidden w-20 text-right text-xs text-[#9CA3AF] md:block">{row.uses}</span>
              <span className="w-12 text-right text-xs text-[#047857]">{row.trend}</span>
            </li>
          ))}
        </ul>
        <div className="mt-7 flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-[#374151]">Needs attention</span>
          <span className="text-[#6B7280]">{ATTENTION.length}</span>
        </div>
        <ul className="mt-2">
          {ATTENTION.map((row) => (
            <li key={row.title} className="flex items-center gap-3 border-b border-[#F3F4F6] py-3">
              <span className="flex w-4 shrink-0">
                {row.failed ? (
                  <AlertTriangle size={16} strokeWidth={1.8} className="text-[#B45309]" aria-hidden="true" />
                ) : (
                  <Circle size={16} strokeWidth={1.8} strokeDasharray="3 3" className="text-[#9CA3AF]" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] text-[#111827]">{row.title}</span>
                <span className="text-xs text-[#6B7280]">{row.detail}</span>
              </span>
              <span className="text-[13px] font-medium text-[#111827]">{row.action}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sharing and activity                                                */
/* ------------------------------------------------------------------ */

type ActivityRow = { who: ReactNode; title: string; detail: string; when: string; action?: string; faded?: boolean };

const ACTIVITY_TODAY: ActivityRow[] = [
  { who: <span className={initialsClass}>PR</span>, title: "Priya shared Customer briefing with Design", detail: "Skill in Customer toolkit", when: "10m", action: "Try it" },
  { who: <span className={initialsClass}>JL</span>, title: "Jordan published a new version of Proposal writer", detail: "Skill you use, version 3", when: "1h", action: "Compare" },
  { who: <span className={initialsClass}><OpenWorkMark className="h-3.5 w-3.5" /></span>, title: "Onboarding checklist is no longer shared with you", detail: "Removed from Everyone", when: "3h", faded: true }
];

const ACTIVITY_WEEK: ActivityRow[] = [
  { who: <span className="flex h-7 w-7 shrink-0 items-center justify-center"><GoogleMark className="h-4 w-4" /></span>, title: "Google Calendar is ready to use", detail: "Connected by your organization for Design", when: "Mon", action: "Open" },
  { who: <span className={initialsClass}>AK</span>, title: "Alex added Sales playbook to the Company marketplace", detail: "Plugin with 4 skills", when: "Mon", action: "Browse" }
];

function ActivityList({ label, rows }: { label: string; rows: ActivityRow[] }) {
  return (
    <div className="flex flex-col">
      <span className="px-3 pb-2 pt-5 text-xs text-[#374151]">{label}</span>
      {rows.map((row, index) => (
        <div
          key={row.title}
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${index === 0 && label === "Today" ? "bg-[#F7F8FA]" : ""}`}
        >
          {row.who}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`truncate text-[13px] ${row.faded ? "text-[#9CA3AF]" : "text-[#111827]"}`}>{row.title}</span>
            <span className="truncate text-xs text-[#9CA3AF]">{row.detail}</span>
          </span>
          <span className="w-10 text-right text-xs text-[#9CA3AF]">{row.when}</span>
          <span className="w-16 text-right text-[13px] font-medium text-[#111827]">{row.action ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

export function RoadmapActivityPreview() {
  return (
    <div className="flex w-full flex-col bg-white px-5 py-8 md:px-16 md:py-10">
      <div className="mx-auto flex w-full max-w-[760px] flex-col">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-[#111827]">Activity</h3>
          <span className="hidden gap-1 rounded-lg bg-[#F3F4F6] p-1 text-xs text-[#4B5563] sm:flex">
            <span className="rounded-md bg-white px-2.5 py-1 text-[#111827] shadow-[0_1px_2px_rgba(0,0,0,0.06)]">All</span>
            <span className="px-2.5 py-1">Skills</span>
            <span className="px-2.5 py-1">Plugins</span>
            <span className="px-2.5 py-1">Connections</span>
          </span>
        </div>
        <ActivityList label="Today" rows={ACTIVITY_TODAY} />
        <ActivityList label="Earlier this week" rows={ACTIVITY_WEEK} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

type StepKind = "start" | "tool" | "decision" | "finish";
type Step = { n: number; kind: StepKind; badge: string; badgeClass: string; title: string; note?: string; skipped?: boolean };

const STEP_CARD: Record<StepKind, string> = {
  start: "border-[#BFDBFE] bg-[#F5F9FF]",
  tool: "border-[#E5E7EB] bg-white",
  decision: "border-[#E5E7EB] bg-[#F7F8FA]",
  finish: "border-[#A7F3D0] bg-[#F3FBF7]"
};

function StepIcon({ kind }: { kind: StepKind }) {
  if (kind === "start") return <Play size={14} strokeWidth={2} aria-hidden="true" />;
  if (kind === "decision") return <GitBranch size={14} strokeWidth={2} aria-hidden="true" />;
  if (kind === "finish") return <CornerDownLeft size={14} strokeWidth={2} aria-hidden="true" />;
  return <Wrench size={14} strokeWidth={2} aria-hidden="true" />;
}

function StepCard({ step }: { step: Step }) {
  return (
    <div className={`flex w-full max-w-[300px] gap-2.5 rounded-xl border px-3.5 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${STEP_CARD[step.kind]}`}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#E5E7EB] bg-white text-[10px] font-semibold text-[#4B5563]">
        {step.n}
      </span>
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-white text-[#6B7280] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
        <StepIcon kind={step.kind} />
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${step.badgeClass}`}>{step.badge}</span>
          {step.skipped ? (
            <span className="rounded-full bg-[#F3F4F6] px-1.5 py-0.5 text-[10px] text-[#4B5563]">This run: skipped</span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-[#ECFDF5] px-1.5 py-0.5 text-[10px] text-[#047857]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#10B981]" />
              This run: completed
            </span>
          )}
        </span>
        <span className="text-xs font-medium leading-[17px] text-[#1F2937]">{step.title}</span>
        {step.note ? <span className="text-[11px] text-[#6B7280]">{step.note}</span> : null}
      </span>
    </div>
  );
}

const Connector = () => <span className="h-5 w-px bg-[#E5E7EB]" aria-hidden="true" />;

export function RoadmapWorkflowPreview() {
  return (
    <div className="flex w-full flex-col">
      <div className="flex flex-col gap-4 border-b border-[#F3F4F6] px-5 pt-5 md:px-7">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold tracking-[-0.01em] text-[#0F172A]">At-risk accounts digest</h3>
            <span className="text-[13px] text-[#6B7280]">Sales · runs every day at 9:00</span>
          </div>
          <div className="hidden gap-2 sm:flex">
            <span className="flex h-8 items-center rounded-lg px-3.5 text-[13px] font-medium text-[#374151] shadow-[inset_0_0_0_1px_#E5E7EB]">Show code</span>
            <span className="flex h-8 items-center rounded-lg bg-[var(--lp-ink)] px-3.5 text-[13px] font-medium text-white">Run now</span>
          </div>
        </div>
        <div className="flex gap-6 text-[13px] font-medium">
          <span className="border-b-2 border-[var(--lp-ink)] pb-2.5 text-[#0F172A]">Overview</span>
          <span className="pb-2.5 text-[#9CA3AF]">Runs</span>
          <span className="pb-2.5 text-[#9CA3AF]">Edit</span>
        </div>
      </div>
      <div className="flex flex-col items-center bg-[#FAFAFA] px-4 pb-7 pt-5 md:px-7">
        <span className="mb-3 self-start text-[11px] text-[#6B7280]">Last run: Sep 28, 9:00 · Succeeded</span>
        <StepCard step={{ n: 1, kind: "start", badge: "Start", badgeClass: "bg-[#DBEAFE] text-[#1D4ED8]", title: "Start", note: "Runs with: week of Sep 22" }} />
        <Connector />
        <span className="mb-1.5 text-[9px] font-semibold tracking-[0.08em] text-[#9CA3AF]">AT THE SAME TIME</span>
        <div className="flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <StepCard step={{ n: 2, kind: "tool", badge: "HubSpot", badgeClass: "bg-[#FFF7ED] text-[#C2410C]", title: "Find open deals with no activity", note: "Saves the result as deals" }} />
          <StepCard step={{ n: 3, kind: "tool", badge: "Gmail", badgeClass: "bg-[#FEF2F2] text-[#B91C1C]", title: "Search replies from those accounts", note: "Saves the result as replies" }} />
        </div>
        <Connector />
        <StepCard step={{ n: 4, kind: "decision", badge: "Decision", badgeClass: "bg-[#FEF3C7] text-[#B45309]", title: "The number of at-risk deals is more than 0" }} />
        <div className="mt-1.5 flex w-full max-w-[660px] flex-col gap-4 rounded-xl bg-[#F3F4F6]/60 px-3 pb-3 pt-2 sm:flex-row">
          <div className="flex flex-1 flex-col items-center">
            <span className="text-[9px] font-semibold tracking-[0.08em] text-[#9CA3AF]">YES</span>
            <Connector />
            <StepCard step={{ n: 5, kind: "tool", badge: "Slack", badgeClass: "bg-[#FDF4FF] text-[#A21CAF]", title: "Post the digest to #sales-ops", note: "Uses deals, replies" }} />
          </div>
          <div className="flex flex-1 flex-col items-center">
            <span className="text-[9px] font-semibold tracking-[0.08em] text-[#9CA3AF]">NO</span>
            <Connector />
            <StepCard step={{ n: 6, kind: "finish", badge: "Finish", badgeClass: "bg-[#D1FAE5] text-[#047857]", title: "Finish with nothing to report", skipped: true }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboards                                                          */
/* ------------------------------------------------------------------ */

const RECENT = [
  { name: "Brief for Thursday call", where: "Documents", when: "1h" },
  { name: "Clean up invoices.xlsx", where: "Documents", when: "Running" },
  { name: "Q3 board prep", where: "Personal", when: "2d" }
];

export function RoadmapDashboardPreview() {
  return (
    <div className="flex w-full justify-center bg-white px-5 py-8 md:py-12">
      <div className="flex w-full max-w-[680px] flex-col">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-[#111827]">Good morning, Sam</h3>
        <div className="mt-5 flex flex-col gap-3 rounded-2xl px-4 pb-3 pt-4 shadow-[0_0_0_1px_#E5E7EB,0_2px_6px_rgba(17,24,39,0.04)]">
          <span className="text-sm text-[#9CA3AF]">Ask anything, or find a session, app or file</span>
          <span className="flex gap-2 text-xs text-[#4B5563]">
            <span className="rounded-full bg-[#F3F4F6] px-2.5 py-1">Auto</span>
            <span className="px-1 py-1">Attach</span>
          </span>
        </div>
        <span className="mt-7 text-xs text-[#6B7280]">Recent</span>
        <ul className="mt-1">
          {RECENT.map((row) => (
            <li key={row.name} className="flex h-10 items-center text-[13px]">
              <span className="flex-1 text-[#111827]">{row.name}</span>
              <span className="w-28 text-[#6B7280]">{row.where}</span>
              <span className={`w-16 text-right ${row.when === "Running" ? "text-[#2563EB]" : "text-[#9CA3AF]"}`}>{row.when}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex items-baseline justify-between text-xs">
          <span className="text-[#6B7280]">Your apps</span>
          <span className="font-medium text-[#111827]">Add</span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1.35fr_1fr_1fr]">
          <div className="flex flex-col gap-2 rounded-xl bg-[#F7F8FA] p-3.5">
            <span className="flex items-center gap-2 text-[13px] font-medium text-[#111827]"><GoogleMark className="h-4 w-4" />Today</span>
            {[["10:00", "Thursday call prep"], ["13:30", "Design review"], ["16:00", "1:1 with Priya"]].map(([time, event]) => (
              <span key={time} className="flex gap-3 text-xs"><span className="w-9 text-[#9CA3AF]">{time}</span><span className="text-[#111827]">{event}</span></span>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-xl bg-[#F7F8FA] p-3.5">
            <span className="flex items-center gap-2 text-[13px] font-medium text-[#111827]"><LinearMark className="h-4 w-4" />My issues</span>
            <span className="text-2xl font-semibold text-[#111827]">4</span>
            <span className="text-xs text-[#6B7280]">2 due this week</span>
          </div>
          <div className="flex flex-col gap-2 rounded-xl bg-[#F7F8FA] p-3.5">
            <span className="flex items-center gap-2 text-[13px] font-medium text-[#111827]"><BrandLogo name="notion" className="h-4 w-4 text-[#111827]" />Team wiki</span>
            <span className="text-xs font-medium text-[#111827]">Launch checklist</span>
            <span className="text-xs text-[#6B7280]">Edited by Priya, 20m</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New apps (not available yet)                                        */
/* ------------------------------------------------------------------ */

export function RoadmapStreamlinedChatPreview() {
  return (
    <div className="flex h-full w-full overflow-hidden rounded-2xl bg-[#FCFDFE] shadow-[0_0_0_1px_#EDF1F6]">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center gap-3 border-b border-[#EDF1F6] bg-white px-3.5">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[var(--lp-ink)] text-[11px] font-semibold text-white">S</span>
          <span className="text-[13px] font-semibold text-[#07192C]">Scout</span>
          <span className="rounded-md bg-[#F1F5F9] px-2 py-1 text-[11.5px] font-medium text-[#07192C]">Home</span>
          <span className="text-[11.5px] text-[#637291]">Apps</span>
          <span className="text-[11.5px] text-[#637291]">Calendar</span>
        </div>
        <div className="flex flex-1 flex-col justify-end gap-1.5 px-4 pb-3.5 pt-5">
          <span className="mb-3 flex flex-col items-center gap-1">
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--lp-ink)] text-[15px] font-semibold text-white">S</span>
            <span className="text-[12.5px] font-semibold text-[#07192C]">Scout</span>
            <span className="text-[10.5px] text-[#637291]">Set up by Ben for the Launch team</span>
          </span>
          <span className="max-w-[300px] self-start rounded-2xl bg-[#EEF1F5] px-3 py-2 text-[12.5px] leading-[18px] text-[#07192C]">
            Morning Maya. Your apps are connected, so I already had a look.
          </span>
          <span className="max-w-[300px] self-start rounded-2xl bg-[#EEF1F5] px-3 py-2 text-[12.5px] leading-[18px] text-[#07192C]">
            Two things need you before 3 PM. Want me to start the pricing copy for Priya?
          </span>
          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[#637291]">
            <GoogleMark className="h-3 w-3" />
            <SlackMark className="h-3 w-3" />
            Looked at Gmail, Slack and Calendar
          </span>
          <span className="self-end rounded-2xl bg-[var(--lp-ink)] px-3 py-2 text-[12.5px] text-white">yes please, keep it short</span>
          <span className="mt-3 flex h-[38px] items-center rounded-full bg-white pl-3.5 text-xs text-[#9AA5BA] shadow-[0_0_0_1px_#E3E7EE]">
            Message Scout
          </span>
        </div>
      </div>
      <div className="hidden w-[210px] shrink-0 flex-col gap-2 border-l border-[#EDF1F6] bg-[#F8FAFC] p-3 sm:flex">
        <span className="px-0.5 text-[10.5px] font-medium text-[#637291]">Launch team views</span>
        <div className="flex flex-col gap-1 rounded-[10px] bg-white p-2.5 shadow-[0_0_0_1px_#EDF1F6]">
          <span className="flex justify-between text-[11.5px]"><span className="font-semibold text-[#07192C]">Waiting on you</span><span className="text-[10.5px] text-[#9AA5BA]">2 today</span></span>
          {[["P", "Pricing copy", "3:00"], ["D", "Hero copy OK", "Today"], ["A", "Press kit notes", "Yest."]].map(([initial, task, when]) => (
            <span key={task} className="flex h-6 items-center gap-2 text-[11.5px]">
              <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#EEF1F5] text-[9px] font-semibold text-[#30405F]">{initial}</span>
              <span className="flex-1 text-[#07192C]">{task}</span>
              <span className="text-[11px] text-[#07192C]">{when}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] bg-white p-2.5 shadow-[0_0_0_1px_#EDF1F6]">
          <span className="flex justify-between text-[11.5px]"><span className="font-semibold text-[#07192C]">Today</span><span className="text-[10.5px] text-[#9AA5BA]">Mon, Sep 28</span></span>
          {[["10:00", "Standup"], ["1:00", "Design review"], ["3:00", "Update"]].map(([time, event]) => (
            <span key={time} className="flex h-[22px] items-center gap-2 text-[11.5px]">
              <span className="w-[34px] text-[11px] text-[#9AA5BA]">{time}</span>
              <span className="h-4 w-0.5 rounded bg-[#D8E0EC]" />
              <span className="text-[#07192C]">{event}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const AT_RISK = [
  { account: "Northwind", why: "Renewal Oct 12", meeting: "No meeting" },
  { account: "Globex", why: "Usage down 40%", meeting: "No meeting" },
  { account: "Initech", why: "Champion left", meeting: "Meeting Thu" }
];

export function RoadmapSlackPreview() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1px_#EDF1F6]">
      <div className="flex h-11 items-center gap-2 border-b border-[#EDF1F6] px-4">
        <SlackMark className="h-[15px] w-[15px]" />
        <span className="text-[13px] font-bold text-[#1D1C1D]"># sales-ops</span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#8A94A6] text-xs font-semibold text-white">M</span>
          <span className="flex flex-col gap-0.5 text-[13px] leading-[19px] text-[#1D1C1D]">
            <span><b>Maya</b> <span className="text-[11px] text-[#9AA5BA]">9:41 AM</span></span>
            <span><span className="rounded bg-[#E8F5FA] px-0.5 text-[#1264A3]">@OpenWork</span> which accounts are at risk this week?</span>
          </span>
        </div>
        <div className="flex gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F0F4F9]"><OpenWorkMark className="h-4 w-4" /></span>
          <span className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] leading-[19px] text-[#1D1C1D]">
            <span><b>OpenWork</b> <span className="text-[11px] text-[#9AA5BA]">9:42 AM</span></span>
            <span>Three accounts slipped. Two have no meeting booked.</span>
            <span className="flex overflow-hidden rounded-lg border border-[#E3E7EE]">
              <span className="w-1 bg-[#2563EB]" />
              <span className="flex flex-1 flex-col gap-1.5 px-3 py-2.5 text-xs">
                <b className="text-[12.5px]">At-risk accounts, week of Sep 28</b>
                {AT_RISK.map((row) => (
                  <span key={row.account} className="flex">
                    <span className="w-[88px] font-semibold">{row.account}</span>
                    <span className="flex-1 text-[#4B5563]">{row.why}</span>
                    <span className={row.meeting === "No meeting" ? "text-[#B45309]" : "text-[#4B5563]"}>{row.meeting}</span>
                  </span>
                ))}
              </span>
            </span>
            <span className="flex gap-1.5 text-xs font-semibold">
              <span className="rounded-md border border-[#D3DAE4] px-2.5 py-1">Draft follow-ups</span>
              <span className="rounded-md border border-[#D3DAE4] px-2.5 py-1">Open in OpenWork</span>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
