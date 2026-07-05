"use client";

import type { ReactNode } from "react";
import { DownloadOpenWorkCard, type DownloadCardInstallers } from "@openwork/ui/react";
import {
  ArrowRight,
  ChevronRight,
  Gauge,
  Users,
} from "lucide-react";
import Link from "next/link";
import { getMarketplacesRoute } from "../../_lib/den-org";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/* ── Types ── */

type AdoptionData = {
  members: number;
  pendingInvites: number;
  activeUsers7d: number;
  activeUsers30d: number;
  weeklyTrend: number[];
};

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type Release = {
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type Installers = DownloadCardInstallers;

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

const FALLBACK_RELEASE = "https://github.com/different-ai/openwork/releases";

function selectAsset(assets: ReleaseAsset[], extensions: string[], keywords: string[] = []): ReleaseAsset | null {
  const matches = assets.filter((asset) => {
    if (!asset?.name || !asset?.browser_download_url) return false;
    const name = asset.name.toLowerCase();
    const extOk = extensions.some((ext) => name.endsWith(ext));
    const kwOk = keywords.length === 0 || keywords.some((kw) => name.includes(kw));
    return extOk && kwOk;
  });
  if (matches.length === 0) return null;
  return (
    matches.find((a) => a.name?.toLowerCase().includes("adhoc")) ||
    matches.find((a) => a.name?.toLowerCase().includes("universal")) ||
    matches.find((a) => a.name?.toLowerCase().includes("aarch64")) ||
    matches.find((a) => a.name?.toLowerCase().includes("arm64")) ||
    matches[0]
  );
}

async function fetchInstallers(): Promise<{ installers: Installers; releaseTag: string; releaseUrl: string }> {
  const fallback: Installers = {
    macos: { appleSilicon: FALLBACK_RELEASE, intel: FALLBACK_RELEASE },
    windows: { x64: FALLBACK_RELEASE, arm64: FALLBACK_RELEASE },
    linux: {
      appImageX64: FALLBACK_RELEASE,
      appImageArm64: FALLBACK_RELEASE,
      tarX64: FALLBACK_RELEASE,
      tarArm64: FALLBACK_RELEASE,
    },
  };
  try {
    const res = await fetch("https://api.github.com/repos/different-ai/openwork/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { installers: fallback, releaseTag: "", releaseUrl: FALLBACK_RELEASE };
    const release = (await res.json()) as Release;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const releaseUrl = release?.html_url || FALLBACK_RELEASE;
    const releaseTag = release?.tag_name || "";

    const macApple = selectAsset(assets, [".dmg"], ["mac-arm64"]);
    const macIntel = selectAsset(assets, [".dmg"], ["mac-x64"]);
    const dmg = selectAsset(assets, [".dmg"], ["openwork-mac-"]);
    const winX64 = selectAsset(assets, [".exe"], ["win-x64"]);
    const winArm64 = selectAsset(assets, [".exe"], ["win-arm64"]);
    const linuxAppX64 = selectAsset(assets, [".appimage"], ["linux-x86_64"]) || selectAsset(assets, [".appimage"], ["linux-x64"]);
    const linuxAppArm64 = selectAsset(assets, [".appimage"], ["linux-arm64"]);
    const linuxTarX64 = selectAsset(assets, [".tar.gz"], ["linux-x64"]);
    const linuxTarArm64 = selectAsset(assets, [".tar.gz"], ["linux-arm64"]);

    return {
      installers: {
        macos: {
          appleSilicon: macApple?.browser_download_url || dmg?.browser_download_url || releaseUrl,
          intel: macIntel?.browser_download_url || dmg?.browser_download_url || releaseUrl,
        },
        windows: {
          x64: winX64?.browser_download_url || releaseUrl,
          arm64: winArm64?.browser_download_url || releaseUrl,
        },
        linux: {
          appImageX64: linuxAppX64?.browser_download_url || releaseUrl,
          appImageArm64: linuxAppArm64?.browser_download_url || releaseUrl,
          tarX64: linuxTarX64?.browser_download_url || releaseUrl,
          tarArm64: linuxTarArm64?.browser_download_url || releaseUrl,
        },
      },
      releaseTag,
      releaseUrl,
    };
  } catch {
    return { installers: fallback, releaseTag: "", releaseUrl: FALLBACK_RELEASE };
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

  const { data: releaseData } = useQuery({
    queryKey: ["github", "releases"],
    queryFn: fetchInstallers,
    staleTime: 1000 * 60 * 60,
  });

  const members = adoption?.members ?? orgContext?.members.length ?? 0;
  const pending = adoption?.pendingInvites ?? (orgContext?.invitations ?? []).filter((i) => i.status === "pending").length;
  const inst = releaseData?.installers;

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

      {/* Extensions banner */}
      <section className="mt-5 rounded-[18px] border border-[#d7e2f5] bg-gradient-to-br from-[#F4F8FF] to-[#EEF3FF] p-5">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">Download the app to unlock extensions</h2>
        <p className="mt-1.5 text-[13px] leading-6 text-[#526582]">
          Sign in with this account to get Computer Use, Browser, Image Gen, Google Workspace, and your team&apos;s marketplace extensions — all built in.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={getMarketplacesRoute(activeOrg?.slug ?? "")} className="inline-flex items-center gap-1.5 rounded-full border border-[#d8e0ec] bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-gray-50">
            View all extensions <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {/* Download OpenWork */}
      <section className="mt-4">
        <DownloadOpenWorkCard installers={inst ?? null} releaseTag={releaseData?.releaseTag} />
      </section>

      {/* Live org data */}
      <div className="mt-5 grid gap-3.5 md:grid-cols-2">
        <StatCard icon={<Users className="h-5 w-5 text-[#6F3DFF]" />} title="OpenWork users" value={`${members}`} sub="Current workspace members" tone="violet" />
        <StatCard icon={<Gauge className="h-5 w-5 text-[#1D63FF]" />} title="Pending invites" value={`${pending}`} sub="Awaiting activation" tone="blue" />
      </div>
    </div>
  );
}
