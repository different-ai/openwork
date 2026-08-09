import {
  Activity,
  BarChart3,
  CheckCircle2,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldAlert,
  Users
} from "lucide-react";
import type { ReactNode } from "react";

type StatCardProps = {
  icon: ReactNode;
  title: string;
  value: string;
  sub: string;
  tone: "blue" | "green" | "amber";
};

const navigation = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Members", icon: Users },
  { label: "Analytics", icon: BarChart3, active: true },
  { label: "Audit log", icon: ScrollText },
  { label: "Settings", icon: Settings }
];

const bars = [34, 42, 39, 51, 47, 58, 64, 61, 72, 78, 86, 96];
const barColors = [
  "#DBEAFE",
  "#D5E7FD",
  "#CFE3FC",
  "#C6DEFB",
  "#BBD8FA",
  "#AED0F8",
  "#A1C8F6",
  "#94C0F4",
  "#86B6F1",
  "#78ACEE",
  "#60A5FA",
  "#011627"
];

const audits = [
  {
    before: "j.chen@acme.com ran ",
    strong: "Contract Reviewer",
    after: " · Claude Sonnet — 2m ago"
  },
  {
    before: "SDR workspace scheduled ",
    strong: "Invoice chaser",
    after: " · daily 9:00 — 14m ago"
  },
  {
    before: "Policy blocked ",
    strong: "fs.write",
    after: " for role Intern · reason logged — 1h ago"
  }
];

function toneBackground(tone: StatCardProps["tone"]) {
  if (tone === "green") return "bg-[#E3F3E3]";
  if (tone === "amber") return "bg-[#FBF0DC]";
  return "bg-[#E4ECFB]";
}

function StatCard({ icon, title, value, sub, tone }: StatCardProps) {
  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ${toneBackground(tone)}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#30405F]">
            {title}
          </div>
          <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">
            {value}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-[#637291]">{sub}</div>
        </div>
      </div>
    </div>
  );
}

export function LpAnalyticsScreen() {
  return (
    <>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-[#07192C]">
            Usage — last 30 days
          </h3>
          <p className="mt-1 text-[12px] text-[#637291]">Across every OpenWork client and workspace</p>
        </div>
        <div className="flex gap-2">
          <span className="inline-flex h-9 items-center rounded-full border border-[#d8e0ec] bg-white px-3 text-[11.5px] text-[#30405F]">
            All teams
          </span>
          <button className="inline-flex h-9 items-center rounded-full bg-[#07192C] px-3 text-[11.5px] text-white" type="button">
            Export CSV
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <StatCard
          icon={<Activity className="h-5 w-5 text-[#1D63FF]" />}
          title="Tasks run"
          value="12,480"
          sub="↑ 18% vs prior 30 days"
          tone="blue"
        />
        <StatCard
          icon={<CheckCircle2 className="h-5 w-5 text-[#18A34A]" />}
          title="Active seats"
          value="143 / 150"
          sub="SCIM-synced from Okta"
          tone="green"
        />
        <StatCard
          icon={<ShieldAlert className="h-5 w-5 text-[#B7791F]" />}
          title="Policy blocks"
          value="27"
          sub="All logged with actor + reason"
          tone="amber"
        />
      </div>

      <div className="mt-4 rounded-[16px] border border-[#e3e7ee] bg-white/90 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-[#07192C]">Task volume</div>
            <div className="mt-0.5 text-[12px] text-[#637291]">Weekly task runs</div>
          </div>
          <div className="text-[11px] text-[#9AA5BA]">12 weeks</div>
        </div>
        <div className="mt-4 flex h-24 items-end gap-1.5" aria-label="Task volume increased over 12 weeks">
          {bars.map((height, index) => (
            <div key={height + index} className="flex h-full flex-1 items-end">
              <div
                className="w-full rounded-t-[3px]"
                style={{ height: `${height}%`, backgroundColor: barColors[index] }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#637291]">
          Recent audit activity
        </div>
        {audits.map((audit) => (
          <div key={audit.strong} className="border-t border-[#F1F5F9] py-2.5 text-[12px] leading-[18px] text-[#637291]">
            {audit.before}<strong className="font-semibold text-[#07192C]">{audit.strong}</strong>{audit.after}
          </div>
        ))}
      </div>
    </>
  );
}

export function LpAnalyticsPanel() {
  return (
    <div className="overflow-hidden rounded-[16px] border border-[#EDF1F6] bg-white">
      <div className="flex min-h-[510px]">
        <aside className="hidden w-44 shrink-0 border-r border-[#e3e7ee] bg-[#F8FAFC] p-3 sm:block">
          <div className="mb-5 flex items-center gap-2 rounded-[10px] bg-white px-3 py-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[var(--lp-ink)] text-[12px] font-semibold text-white">
              A
            </span>
            <div>
              <div className="text-[12.5px] font-semibold text-[#07192C]">Acme Inc</div>
              <div className="text-[10px] text-[#637291]">Enterprise</div>
            </div>
          </div>
          <nav className="flex flex-col gap-1" aria-label="Analytics preview navigation">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className={`flex items-center gap-2.5 rounded-[9px] px-3 py-2 text-[12px] font-medium ${
                    item.active
                      ? "bg-white text-[#07192C] shadow-[0_1px_2px_rgba(7,25,44,0.06)]"
                      : "text-[#637291]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {item.label}
                </div>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0 flex-1 bg-[#FCFDFE] p-4 md:p-6">
          <LpAnalyticsScreen />
        </div>
      </div>
    </div>
  );
}
