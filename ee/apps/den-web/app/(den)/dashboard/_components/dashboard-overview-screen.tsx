"use client";

import type { ReactNode } from "react";
import {
  ChevronRight,
  Gauge,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { OrganizationDownloadCard } from "./organization-download-card";

/* ── Types ── */

type AdoptionData = {
  members: number;
  pendingInvites: number;
  activeUsers7d: number;
  activeUsers30d: number;
  weeklyTrend: number[];
};

/* ── Data ── */

async function fetchAdoption(): Promise<AdoptionData | null> {
  try {
    const { response, payload } = await requestJson("/v1/telemetry/adoption", { method: "GET" }, 12000);
    if (!response.ok || !payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    return {
      members: typeof p.members === "number" ? p.members : 0,
      pendingInvites: typeof p.pendingInvites === "number" ? p.pendingInvites : 0,
      activeUsers7d: typeof p.activeMembers7d === "number" ? p.activeMembers7d : (typeof p.activeUsers7d === "number" ? p.activeUsers7d : 0),
      activeUsers30d: typeof p.activeMembers30d === "number" ? p.activeMembers30d : (typeof p.activeUsers30d === "number" ? p.activeUsers30d : 0),
      weeklyTrend: Array.isArray(p.weeklyTrend) ? p.weeklyTrend.map(Number) : [],
    };
  } catch {
    return null;
  }
}

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

/* ── Small components ── */

function StatCard({ icon, title, value, sub, tone }: {
  icon: ReactNode; title: string; value: string; sub?: string; tone: "violet" | "green" | "blue";
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

/* ── Main screen ── */

export function DashboardOverviewScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();

  const { data: adoption } = useQuery({
    queryKey: ["telemetry", "adoption"],
    queryFn: fetchAdoption,
  });

  const members = adoption?.members ?? orgContext?.members.length ?? 0;
  const pending = adoption?.pendingInvites ?? (orgContext?.invitations ?? []).filter((i) => i.status === "pending").length;

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-8 pt-4 sm:px-6 md:px-8">

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e7e9f0] pb-3">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{activeOrg?.name ?? "OpenWork Cloud"}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[#9AA5BA]" />
        <span className="text-[14px] font-medium tracking-[-0.01em] text-[#5A6886]">Dashboard</span>
      </div>

      {/* Greeting */}
      <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-[#07192C]">{getGreeting(user?.name)}</h1>
      <p className="mt-1 text-[14px] leading-6 text-[#5A6886]">
        Run locally for free. Keep data on your machine and move to shared workflows when ready.
      </p>

      {/* Download OpenWork */}
      {activeOrg && orgContext?.capabilities.installLinks ? (
        <div className="mt-4">
          <OrganizationDownloadCard organizationId={activeOrg.id} organizationName={activeOrg.name} />
        </div>
      ) : null}

      {/* Live org data */}
      <div className="mt-5 grid gap-3.5 md:grid-cols-2">
        <StatCard icon={<Users className="h-5 w-5 text-[#6F3DFF]" />} title="OpenWork users" value={`${members}`} sub="Current workspace members" tone="violet" />
        <StatCard icon={<Gauge className="h-5 w-5 text-[#1D63FF]" />} title="Pending invites" value={`${pending}`} sub="Awaiting activation" tone="blue" />
      </div>
    </div>
  );
}
