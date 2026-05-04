"use client";

import { useState } from "react";
import {
  Activity,
  ChevronRight,
  Download,
  Gauge,
  Puzzle,
  Users,
  Zap,
} from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/* ── Mock data ── */

type CapRow = {
  name: string;
  seed: string;
  invocations: string;
  users: string;
  successRate: string;
  trend: number[];
};

const pluginRows: CapRow[] = [
  { name: "Productivity", seed: "plg-productivity", invocations: "2.4K", users: "16", successRate: "98%", trend: [80, 90, 100, 110, 120, 130, 135, 140, 148, 155] },
  { name: "Enterprise Search", seed: "plg-enterprise-search", invocations: "1.1K", users: "12", successRate: "96%", trend: [30, 38, 45, 52, 60, 66, 72, 78, 82, 88] },
  { name: "Sales", seed: "plg-sales", invocations: "820", users: "9", successRate: "99%", trend: [20, 25, 30, 34, 40, 44, 48, 52, 55, 58] },
  { name: "Customer Support", seed: "plg-customer-support", invocations: "680", users: "9", successRate: "95%", trend: [14, 18, 22, 28, 32, 36, 40, 44, 48, 52] },
  { name: "Product Management", seed: "plg-product-management", invocations: "520", users: "7", successRate: "97%", trend: [8, 12, 15, 18, 22, 24, 28, 30, 32, 34] },
  { name: "Engineering", seed: "plg-engineering", invocations: "490", users: "6", successRate: "94%", trend: [10, 14, 16, 20, 22, 26, 30, 34, 36, 38] },
];

const skillRows: CapRow[] = [
  { name: "Release readiness", seed: "sk-release", invocations: "1.2K", users: "14", successRate: "97%", trend: [40, 44, 50, 58, 66, 72, 80, 86, 92, 96] },
  { name: "Research brief", seed: "sk-research", invocations: "840", users: "11", successRate: "94%", trend: [20, 28, 34, 42, 50, 55, 60, 64, 68, 72] },
  { name: "Meeting prep", seed: "sk-meeting", invocations: "610", users: "9", successRate: "99%", trend: [15, 20, 24, 30, 34, 40, 44, 48, 51, 54] },
  { name: "Bug triage", seed: "sk-bug", invocations: "390", users: "6", successRate: "91%", trend: [10, 14, 16, 20, 22, 26, 30, 34, 36, 38] },
  { name: "Changelog draft", seed: "sk-changelog", invocations: "280", users: "5", successRate: "96%", trend: [5, 8, 10, 14, 16, 18, 22, 24, 26, 28] },
];

const weeklyTrend = [32, 41, 39, 52, 61, 68, 74, 70, 82, 88, 91, 96];

/* ── Helpers ── */

function getGreeting(name: string | null | undefined) {
  const hour = new Date().getHours();
  const g = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${g}, ${name?.trim().split(/\s+/)[0] ?? "there"}`;
}

function toneBg(tone: "violet" | "green" | "blue") {
  switch (tone) {
    case "violet": return "bg-[#EDE4FF]";
    case "green": return "bg-[#E3F3E3]";
    case "blue": return "bg-[#E4ECFB]";
  }
}

function trendColor(trend: number[]): string {
  if (trend.length < 3) return "#637291";
  const s = (trend[0] + trend[1] + trend[2]) / 3;
  const e = trend.slice(-3).reduce((a, b) => a + b, 0) / 3;
  if (e - s > 0.5) return "#18A34A";
  if (e - s < -0.5) return "#B43035";
  return "#637291";
}

/* ── Sparkline ── */

function Sparkline({ values, color, title }: { values: number[]; color: string; title?: string }) {
  const w = 80, h = 20, pad = 2;
  if (values.length === 0) return null;
  const min = Math.min(...values), max = Math.max(...values), range = Math.max(max - min, 1);
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `M ${pad},${h - pad} ${pts.map((p) => `L ${p}`).join(" ")} L ${w - pad},${h - pad} Z`;
  const line = `M ${pts.join(" L ")}`;
  const last = pts[pts.length - 1].split(",");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={title} className="block">
      {title ? <title>{title}</title> : null}
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} />
    </svg>
  );
}

/* ── Area chart for overview ── */

function AreaChart({ values }: { values: number[] }) {
  const w = 600, h = 120, padX = 24, padY = 12;
  if (values.length === 0) return null;
  const min = Math.min(...values), max = Math.max(...values), range = Math.max(max - min, 1);
  const stepX = (w - padX * 2) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = padX + i * stepX;
    const y = padY + (h - padY * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)},${h - padY} L ${padX},${h - padY} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" aria-label="Weekly active users trend">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = padY + (h - padY * 2) * (1 - pct);
        return <line key={pct} x1={padX} y1={y} x2={w - padX} y2={y} stroke="#eef1f5" strokeWidth="0.8" />;
      })}
      <path d={area} fill="#07192C" fillOpacity="0.06" />
      <path d={line} fill="none" stroke="#07192C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill="#07192C" />
      {/* X labels */}
      {pts.map(([x], i) => (
        <text key={i} x={x} y={h - 1} textAnchor="middle" className="fill-[#9AA5BA] text-[9px]">
          {i + 1}
        </text>
      ))}
    </svg>
  );
}

/* ── Stat card ── */

function StatCard({ icon, title, value, sub, tone }: {
  icon: React.ReactNode; title: string; value: string; sub?: string; tone: "violet" | "green" | "blue";
}) {
  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ${toneBg(tone)}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#30405F]">{title}</div>
          <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">{value}</div>
          {sub ? <div className="mt-0.5 truncate text-[12px] text-[#637291]">{sub}</div> : null}
        </div>
      </div>
    </div>
  );
}

/* ── Plugin icon (matches Den plugin cards) ── */

function PluginIcon({ seed }: { seed: string }) {
  return (
    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-[10px]">
      <div className="absolute inset-0"><PaperMeshGradient seed={seed} speed={0} style={{ width: "100%", height: "100%" }} /></div>
      <div className="relative flex h-full w-full items-center justify-center">
        <div className="flex h-6 w-6 items-center justify-center rounded-[6px] border border-white/60 bg-white shadow-[0_4px_10px_-4px_rgba(15,23,42,0.3)]">
          <Puzzle className="h-3 w-3 text-gray-700" aria-hidden />
        </div>
      </div>
    </div>
  );
}

function SkillIcon({ seed }: { seed: string }) {
  return (
    <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-[10px]">
      <div className="absolute inset-0"><PaperMeshGradient seed={seed} speed={0} style={{ width: "100%", height: "100%" }} /></div>
      <div className="relative flex h-full w-full items-center justify-center">
        <div className="flex h-6 w-6 items-center justify-center rounded-[6px] border border-white/60 bg-white shadow-[0_4px_10px_-4px_rgba(15,23,42,0.3)]">
          <Zap className="h-3 w-3 text-gray-700" aria-hidden />
        </div>
      </div>
    </div>
  );
}

/* ── Pill tab bar ── */

type TabId = "plugins" | "skills";

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "plugins", label: "Plugins" },
    { id: "skills", label: "Skills" },
  ];
  return (
    <div role="tablist" className="inline-flex items-center gap-1 rounded-full border border-[#e3e7ee] bg-white/80 p-1">
      {tabs.map((t) => {
        const sel = t.id === active;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={sel} onClick={() => onChange(t.id)}
            className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${sel ? "bg-[#07192C] text-white" : "text-[#30405F] hover:bg-[#F4F6FB] hover:text-[#07192C]"}`}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Table ── */

function CapTable({ rows, kind }: { rows: CapRow[]; kind: "plugin" | "skill" }) {
  return (
    <div role="tabpanel" className="overflow-hidden rounded-[16px] border border-[#e3e7ee] bg-white/90">
      <div className="grid grid-cols-[1.6fr_0.7fr_0.5fr_0.6fr_0.8fr] gap-3 border-b border-[#e9edf3] px-5 py-3 text-[12px] font-medium text-[#5A6886]">
        <div>{kind === "plugin" ? "Plugin" : "Skill"}</div>
        <div className="text-right">Invocations</div>
        <div className="text-right">Users</div>
        <div className="text-right">Success</div>
        <div>Trend</div>
      </div>
      {rows.map((row) => (
        <div key={row.name} className="grid grid-cols-[1.6fr_0.7fr_0.5fr_0.6fr_0.8fr] items-center gap-3 border-b border-[#eef1f5] px-5 py-2.5 transition-colors last:border-b-0 hover:bg-[#F6F8FC]">
          <div className="flex items-center gap-3">
            {kind === "plugin" ? <PluginIcon seed={row.seed} /> : <SkillIcon seed={row.seed} />}
            <span className="truncate text-[14px] font-medium tracking-[-0.01em] text-[#07192C]">{row.name}</span>
          </div>
          <div className="text-right text-[13px] tabular-nums text-[#30405F]">{row.invocations}</div>
          <div className="text-right text-[13px] tabular-nums text-[#30405F]">{row.users}</div>
          <div className="text-right text-[13px] tabular-nums text-[#30405F]">{row.successRate}</div>
          <div><Sparkline values={row.trend} color={trendColor(row.trend)} title={`${row.name} trend`} /></div>
        </div>
      ))}
    </div>
  );
}

/* ── Main screen ── */

export function DashboardOverviewScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();
  const [tab, setTab] = useState<TabId>("plugins");

  const members = orgContext?.members.length ?? 0;
  const pending = (orgContext?.invitations ?? []).filter((i) => i.status === "pending").length;
  const weeklyActive = members > 0 ? Math.max(1, Math.round(members * 0.76)) : 0;

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-8 pt-4 sm:px-6 md:px-8">

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e7e9f0] pb-3">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{activeOrg?.name ?? "OpenWork Cloud"}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[#9AA5BA]" />
        <span className="text-[14px] font-medium tracking-[-0.01em] text-[#5A6886]">Usage Insights</span>
      </div>

      {/* Greeting */}
      <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-[#07192C]">{getGreeting(user?.name)}</h1>
      <p className="mt-1 text-[14px] leading-6 text-[#5A6886]">Adoption and capability usage across your workspace.</p>

      {/* Stat cards */}
      <div className="mt-5 grid gap-3.5 md:grid-cols-3">
        <StatCard icon={<Users className="h-5 w-5 text-[#6F3DFF]" />} title="OpenWork users" value={`${members}`} sub={`${pending} pending invites`} tone="violet" />
        <StatCard icon={<Activity className="h-5 w-5 text-[#18A34A]" />} title="Active this week" value={`${weeklyActive}`} sub="Based on sessions" tone="green" />
        <StatCard icon={<Gauge className="h-5 w-5 text-[#1D63FF]" />} title="Tasks completed" value="1,284" sub="Last 30 days" tone="blue" />
      </div>

      {/* Chart + settings row */}
      <div className="mt-5 grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-medium tracking-[-0.01em] text-[#07192C]">Weekly active users</span>
            <span className="text-[12px] text-[#637291]">Last 12 weeks</span>
          </div>
          <div className="h-[110px]">
            <AreaChart values={weeklyTrend} />
          </div>
        </div>

        <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-5 py-4">
          <span className="text-[13px] font-medium tracking-[-0.01em] text-[#07192C]">Telemetry settings</span>
          <div className="mt-3 grid gap-2.5 text-[13px]">
            <div className="flex items-center justify-between"><span className="text-[#5A6886]">Collection</span><span className="font-medium text-[#07192C]">Usage</span></div>
            <div className="flex items-center justify-between"><span className="text-[#5A6886]">Identity</span><span className="font-medium text-[#07192C]">Anonymized</span></div>
            <div className="flex items-center justify-between"><span className="text-[#5A6886]">Retention</span><span className="font-medium text-[#07192C]">90 days</span></div>
            <div className="flex items-center justify-between"><span className="text-[#5A6886]">Prompt data</span><span className="font-medium text-[#07192C]">Never collected</span></div>
          </div>
        </div>
      </div>

      {/* Capability tabs */}
      <div className="mt-5">
        <TabBar active={tab} onChange={setTab} />
      </div>
      <div className="mt-3">
        {tab === "plugins" ? <CapTable rows={pluginRows} kind="plugin" /> : null}
        {tab === "skills" ? <CapTable rows={skillRows} kind="skill" /> : null}
      </div>

      {/* Download CTA */}
      <div className="mt-6 flex items-center justify-between gap-6 rounded-[16px] border border-[#e3e7ee] bg-[#07192C] px-6 py-5">
        <div>
          <p className="text-[14px] font-medium text-white">Download OpenWork</p>
          <p className="mt-1 max-w-[480px] text-[13px] leading-[1.55] text-white/60">Run locally for free. Keep data on your machine and move to shared workflows when ready.</p>
        </div>
        <a href="https://openworklabs.com/download" className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-white/10">
          <Download className="h-3.5 w-3.5" />Download
        </a>
      </div>
    </div>
  );
}
