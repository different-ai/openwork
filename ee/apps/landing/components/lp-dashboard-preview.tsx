"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  CircleDollarSign,
  GitBranch,
  LayoutDashboard,
  Library,
  MessageSquare,
  Plug,
  Settings,
  TrendingUp,
  TriangleAlert,
  Users
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type AppId = "budget" | "pipeline" | "incidents" | "deploys";

type AppDefinition = {
  id: AppId;
  name: string;
  icon: LucideIcon;
};

const apps: AppDefinition[] = [
  { id: "budget", name: "Budget Allocator", icon: CircleDollarSign },
  { id: "pipeline", name: "Sales Pipeline", icon: TrendingUp },
  { id: "incidents", name: "Incidents", icon: TriangleAlert },
  { id: "deploys", name: "Deploys", icon: GitBranch }
];

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Sessions", icon: MessageSquare },
  { label: "Library", icon: Library },
  { label: "Your Connections", icon: Plug },
  { label: "Settings", icon: Settings }
];

const budgetRows = [
  { label: "Engineering", value: 42 },
  { label: "Sales", value: 28 },
  { label: "Marketing", value: 18 },
  { label: "Ops", value: 12 }
];

const incidents = [
  { text: "API latency p95 elevated", time: "8m", color: "bg-[#f59e0b]" },
  { text: "Payments — resolved", time: "24m", color: "bg-[#10b981]" },
  { text: "Auth — investigating", time: "41m", color: "bg-[#ef4444]" }
];

const deploys = [
  { service: "api", sha: "4f2a8c1", time: "2m ago" },
  { service: "web", sha: "9de31b7", time: "2m ago" },
  { service: "billing", sha: "17ac602", time: "2m ago" },
  { service: "auth", sha: "c8b045e", time: "2m ago" },
  { service: "worker", sha: "601fd2a", time: "2m ago" }
];

function TrafficLights() {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      <span className="h-2.5 w-2.5 rounded-full bg-[#fb7185]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
    </div>
  );
}

function AppToggle({ app, active, onToggle, compact = false }: { app: AppDefinition; active: boolean; onToggle: () => void; compact?: boolean }) {
  const Icon = app.icon;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={compact
        ? `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium transition-colors duration-150 ${active ? "border-[#bfdbfe] bg-[#eff6ff] text-[var(--lp-blue)]" : "border-[#e1e4e8] bg-white text-[var(--lp-muted)]"}`
        : "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[11.5px] text-[var(--lp-muted)] transition-colors duration-150 hover:bg-[#eceff3]"}
    >
      {compact ? <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> : (
        <span className={`flex h-4 w-4 items-center justify-center rounded-[4px] border ${active ? "border-[var(--lp-blue)] bg-[var(--lp-blue)] text-white" : "border-[#cbd2da] bg-white"}`}>
          {active ? <Check className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden="true" /> : null}
        </span>
      )}
      <span>{app.name}</span>
    </button>
  );
}

function WidgetCard({ name, icon: Icon, children }: { name: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="h-full overflow-hidden rounded-[12px] border border-[#e1e4e8] bg-white">
      <div className="flex h-11 items-center gap-2 border-b border-[#eef1f5] px-4">
        <Icon className="h-3.5 w-3.5 text-[var(--lp-muted)]" strokeWidth={1.75} aria-hidden="true" />
        <h3 className="text-[12.5px] font-medium text-[var(--lp-ink)]">{name}</h3>
        <span className="ml-auto rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[8px] font-semibold tracking-[0.08em] text-[var(--lp-faint)]">MCP App</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Widget({ app, reduceMotion }: { app: AppDefinition; reduceMotion: boolean | null }) {
  let body: ReactNode;

  if (app.id === "budget") {
    body = (
      <div className="space-y-3">
        {budgetRows.map((row) => (
          <div key={row.label}>
            <div className="mb-1.5 flex justify-between text-[10.5px]"><span className="text-[var(--lp-muted)]">{row.label}</span><span className="font-medium text-[var(--lp-ink)]">{row.value}%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#eef1f5]"><div className="h-full rounded-full bg-[var(--lp-blue)]" style={{ width: `${row.value}%` }} /></div>
          </div>
        ))}
      </div>
    );
  } else if (app.id === "pipeline") {
    body = (
      <div className="grid grid-cols-3 gap-2">
        {[{ label: "Open", value: "$1.2M" }, { label: "Won this month", value: "$340k" }, { label: "Win rate", value: "31%" }].map((metric) => (
          <div key={metric.label} className="rounded-[9px] bg-[#F8FAFC] px-2 py-4 text-center">
            <div className="text-[16px] font-semibold tracking-[-0.02em] text-[var(--lp-ink)] sm:text-[18px]">{metric.value}</div>
            <div className="mt-1 text-[9px] leading-[13px] text-[var(--lp-muted)]">{metric.label}</div>
          </div>
        ))}
      </div>
    );
  } else if (app.id === "incidents") {
    body = (
      <div className="space-y-1.5">
        {incidents.map((incident) => (
          <div key={incident.text} className="flex min-h-9 items-center gap-2.5 rounded-[8px] bg-[#F8FAFC] px-3">
            <span className={`h-2 w-2 shrink-0 rounded-full ${incident.color}`} />
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--lp-ink)]">{incident.text}</span>
            <span className="text-[9.5px] text-[var(--lp-faint)]">{incident.time}</span>
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <div className="space-y-1">
        {deploys.map((deploy) => (
          <div key={deploy.service} className="grid grid-cols-[16px_1fr_auto_auto] items-center gap-2 rounded-[7px] px-2 py-1.5 text-[10px] hover:bg-[#F8FAFC]">
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#d1fae5] text-[#059669]"><Check className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden="true" /></span>
            <span className="font-medium text-[var(--lp-ink)]">{deploy.service}</span>
            <span className="font-mono text-[var(--lp-muted)]">{deploy.sha}</span>
            <span className="text-[var(--lp-faint)]">{deploy.time}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <motion.div
      layout
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: reduceMotion ? 0 : 0.18 }}
    >
      <WidgetCard name={app.name} icon={app.icon}>{body}</WidgetCard>
    </motion.div>
  );
}

export function LpDashboardPreview() {
  const [activeApps, setActiveApps] = useState<AppId[]>(["budget", "pipeline", "incidents"]);
  const reduceMotion = useReducedMotion();
  const toggleApp = (id: AppId) => setActiveApps((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <div className="overflow-hidden rounded-[20px] border border-[#e1e4e8] bg-white">
      <div className="flex h-12 items-center gap-3 border-b border-[#e1e4e8] px-5">
        <TrafficLights />
        <span className="text-[12px] font-medium text-[var(--lp-muted)]">OpenWork — Acme Inc</span>
      </div>
      <div className="flex min-h-[570px]">
        <aside className="hidden w-[200px] shrink-0 flex-col border-r border-[#e1e4e8] bg-[#f7f8fa] p-3 md:flex">
          <div className="flex items-center gap-2.5 rounded-[11px] bg-white p-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[var(--lp-ink)] text-[12px] font-semibold text-white">A</span>
            <div><div className="text-[12.5px] font-medium text-[var(--lp-ink)]">Acme Inc</div><div className="text-[10px] text-[var(--lp-faint)]">Organization</div></div>
          </div>
          <div className="px-2 pb-2 pt-5 text-[10px] font-semibold tracking-[0.14em] text-[var(--lp-faint)]">NAVIGATION</div>
          <nav className="flex flex-col gap-0.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.label === "Dashboard";
              return <div key={item.label} className={`flex h-8 items-center gap-2 rounded-[8px] px-2 text-[12px] ${active ? "bg-white font-medium text-[var(--lp-ink)] shadow-[0_1px_2px_rgba(1,22,39,0.06)]" : "text-[var(--lp-muted)]"}`}><Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /><span>{item.label}</span></div>;
            })}
          </nav>
          <div className="px-2 pb-2 pt-6 text-[10px] font-semibold tracking-[0.14em] text-[var(--lp-faint)]">MCP APPS</div>
          <div className="flex flex-col gap-0.5">
            {apps.map((app) => <AppToggle key={app.id} app={app} active={activeApps.includes(app.id)} onToggle={() => toggleApp(app.id)} />)}
          </div>
        </aside>

        <div className="min-w-0 flex-1 bg-white p-5 sm:p-8 lg:p-10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1"><h2 className="text-[15.5px] font-semibold text-[var(--lp-ink)]">Ops overview</h2><p className="mt-1 text-[12px] text-[var(--lp-muted)]">Live apps from your team&apos;s MCP servers.</p></div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[#F8FAFC] px-3 text-[10.5px] text-[var(--lp-muted)]"><Users className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />Shared with everyone</span>
              <button type="button" className="inline-flex h-8 items-center rounded-full bg-[var(--lp-ink)] px-3 text-[10.5px] font-medium text-white active:scale-[0.97]">+ Add app</button>
            </div>
          </div>
          <div className="mt-5 flex gap-2 overflow-x-auto pb-1 md:hidden">
            {apps.map((app) => <AppToggle key={app.id} app={app} active={activeApps.includes(app.id)} onToggle={() => toggleApp(app.id)} compact />)}
          </div>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AnimatePresence initial={false}>
              {apps.filter((app) => activeApps.includes(app.id)).map((app) => <Widget key={app.id} app={app} reduceMotion={reduceMotion} />)}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
